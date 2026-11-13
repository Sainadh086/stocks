import test, { mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { scope, rolesFile } from "../src/brokers/accounts.js";
import { type connected, ticketsFile } from "../src/brokers/robinhood.js";
import {
  automationPreferencePath,
  preferenceFromSnapshot,
} from "../src/trading/automation.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";
import { session } from "../src/shared/calendar.js";
import { indiaTradingFile } from "../src/trading/india.js";
const day = "2026-10-19",
  open = session(day)![0],
  now = open + 7290000;
function fixture() {
  mock.timers.enable({ apis: ["Date"], now });
  const records = new Map<string, Row>([
    [rolesFile, { long_term: "LONG", trading: "TRADE" }],
    [
      rolesFile.replace(
        "account_roles.json",
        `live_trading_settings_${scope("TRADE")}.json`,
      ),
      { version: 1, account_number: "TRADE", budget: 100, reserve_pct: 10 },
    ],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  return records;
}
async function enable(service: Service) {
  service.touch("fixture", true);
  await service.setAuto(true, "fixture", true, true);
}
function cleanup() {
  mock.restoreAll();
  mock.timers.reset();
}

test(
  "macOS automation prevents idle sleep and releases the assertion on stop, expiry and shutdown",
  { skip: process.platform !== "darwin" },
  async () => {
    fixture();
    let spawned = 0,
      killed = 0;
    mock.method(
      childProcess,
      "spawn",
      (command: string, args: string[], options: Row) => {
        assert.equal(command, "/usr/bin/caffeinate");
        assert.deepEqual(args, ["-i", "-w", String(process.pid)]);
        assert.deepEqual(options, { stdio: "ignore" });
        spawned++;
        return Object.assign(new EventEmitter(), {
          kill() {
            killed++;
            return true;
          },
        }) as ChildProcess;
      },
    );
    const service = new Service(
      true,
      { comparisons: {}, batch: null },
      async () => {
        throw new Error("No broker access expected");
      },
    );
    try {
      await enable(service);
      assert.equal(spawned, 1);
      (service as any).saveAutomation();
      assert.equal(spawned, 1, "saving consent must reuse the assertion");
      const restored = new Service(true, undefined, async () => {
        throw new Error("No broker access expected");
      });
      (restored as any).preventSleep();
      assert.equal(
        spawned,
        2,
        "a restored session must acquire its own assertion",
      );
      await restored.close();
      assert.equal(killed, 1);
      await service.setAuto(false, "", false);
      assert.equal(killed, 2);
      await enable(service);
      mock.timers.setTime(now + 12 * 3600000 + 1);
      await (service as any).tick();
      assert.equal(service.liveView().auto.enabled, false);
      assert.equal(killed, 3);
      await enable(service);
      await service.close();
      assert.equal(spawned, 4);
      assert.equal(killed, 4);
    } finally {
      await service.close();
      cleanup();
    }
  },
);

for (const event of ["error", "exit"])
  test(
    `sleep assertion ${event} pauses macOS automation with a visible error`,
    { skip: process.platform !== "darwin" },
    async () => {
      fixture();
      const child = Object.assign(new EventEmitter(), {
        kill() {
          return true;
        },
      });
      mock.method(childProcess, "spawn", () => child as ChildProcess);
      const service = new Service(
        true,
        { comparisons: {}, batch: null },
        async () => {
          throw new Error("No broker access expected");
        },
      );
      try {
        await enable(service);
        if (event === "error") child.emit("error", new Error("unavailable"));
        else child.emit("exit", 1);
        assert.equal(service.liveView().auto.enabled, false);
        assert.match(
          service.liveView().auto.error,
          event === "error"
            ? /Could not prevent idle sleep.*unavailable/
            : /Idle-sleep protection stopped/,
        );
      } finally {
        await service.close();
        cleanup();
      }
    },
  );

test(
  "India and US sessions share idle-sleep protection until both are paused",
  { skip: process.platform !== "darwin" },
  async () => {
    const records = fixture();
    records.set(indiaTradingFile, {
      broker: "groww",
      current: { groww: "india-account" },
      accounts: {
        "india-account": {
          auto: { enabled: true, expires_at: now + 3600000 },
          tickets: [],
          history: [],
        },
      },
    });
    let spawned = 0,
      killed = 0;
    mock.method(childProcess, "spawn", () => {
      spawned++;
      return Object.assign(new EventEmitter(), {
        kill() {
          killed++;
          return true;
        },
      }) as ChildProcess;
    });
    const service = new Service(
      true,
      { comparisons: {}, batch: null },
      async () => {
        throw new Error("No broker access expected");
      },
    );
    try {
      (service as any).preventSleep();
      assert.equal(spawned, 1);
      await enable(service);
      assert.equal(spawned, 1);
      await service.setAuto(false, "", false);
      assert.equal(killed, 0, "India trading still needs the assertion");
      service.india.stop();
      assert.equal(killed, 1);
    } finally {
      await service.close();
      cleanup();
    }
  },
);

test("on survives graceful API shutdown and crash restart without extending consent", async () => {
  const records = fixture(),
    service = new Service(false);
  try {
    await enable(service);
    const expiry = service.liveView().auto.expires_at;
    const crashRestart = new Service(false);
    assert.equal(crashRestart.liveView().auto.enabled, true);
    assert.equal(crashRestart.liveView().auto.expires_at, expiry);
    await service.close();
    assert.equal(records.get(automationPreferencePath)!.enabled, true);
    mock.timers.setTime(now + 3600000);
    const restarted = new Service(false);
    assert.equal(restarted.liveView().auto.enabled, true);
    assert.equal(restarted.liveView().auto.expires_at, expiry);
    assert.equal(restarted.liveView().auto.remembered, true);
    (restarted as any).consent({ automatic: true });
    assert.throws(
      () => (service as any).consent({ automatic: true }),
      /stopping/,
    );
  } finally {
    cleanup();
  }
});

test("an explicit off choice remains off after restart", async () => {
  const records = fixture(),
    service = new Service(false);
  try {
    await enable(service);
    await service.setAuto(false, "", false);
    await service.close();
    assert.equal(records.get(automationPreferencePath)!.enabled, false);
    assert.equal(new Service(false).liveView().auto.enabled, false);
  } finally {
    cleanup();
  }
});

test("restoration cannot authorize a different account or extend an expired session", async () => {
  const records = fixture(),
    service = new Service(false);
  try {
    await enable(service);
    records.set(rolesFile, { long_term: "LONG", trading: "OTHER" });
    assert.equal(new Service(false).liveView().auto.enabled, false);
    records.set(rolesFile, { long_term: "LONG", trading: "TRADE" });
    mock.timers.setTime(now + 12 * 3600000 + 1);
    assert.equal(new Service(false).liveView().auto.enabled, false);
  } finally {
    cleanup();
  }
});

test("legacy browser-bound consent is not restored without its browser connection", async () => {
  fixture();
  const service = new Service(false);
  try {
    service.touch("fixture", true);
    await service.setAuto(true, "fixture", true, false);
    await service.close();
    assert.equal(new Service(false).liveView().auto.enabled, false);
  } finally {
    cleanup();
  }
});

for (const state of ["filled", "queued", "missing"]) {
  test(`resume reconciles ${state} broker status without replaying an interrupted buy`, async () => {
    const records = fixture(),
      original = new Service(false);
    await enable(original);
    const ticket = {
      id: "pending",
      status: "submitting",
      strategy: ROTATION_STRATEGY,
      origin: "strategy",
      reviewed_at: new Date(now - 10000).toISOString(),
      stop: "80",
      target: "170",
      arguments: {
        account_number: "TRADE",
        symbol: "A",
        side: "buy",
        dollar_amount: "45.00",
      },
    };
    records.set(ticketsFile, { pending: ticket });
    let placements = 0;
    const broker: typeof connected = async (action) =>
      action({
        async call(name, args) {
          if (name === "get_accounts")
            return {
              accounts: [
                {
                  account_number: "TRADE",
                  state: "active",
                  agentic_allowed: true,
                },
              ],
            };
          if (name === "get_portfolio")
            return {
              currency: "USD",
              total_value: "100",
              equity_value: state === "filled" ? "45" : "0",
              cash: state === "filled" ? "55" : "100",
              buying_power: {
                buying_power: state === "missing" ? "100" : "55",
                unleveraged_buying_power: state === "missing" ? "100" : "55",
              },
            };
          if (name === "get_equity_quotes")
            return {
              results: args.symbols.map((symbol: string) => ({
                quote: {
                  symbol,
                  state: "active",
                  has_traded: true,
                  last_trade_price: "110",
                  venue_last_trade_time: new Date(now).toISOString(),
                },
              })),
            };
          if (name === "place_equity_order") {
            placements++;
            throw new Error("An interrupted buy must not be replayed");
          }
          throw new Error(`Unexpected ${name}`);
        },
        async rows(name) {
          if (name === "get_equity_positions")
            return state === "filled"
              ? [
                  {
                    symbol: "A",
                    quantity: String(45 / 110),
                    shares_available_for_sells: String(45 / 110),
                    average_buy_price: "110",
                  },
                ]
              : [];
          return state === "missing"
            ? []
            : [
                {
                  id: "broker-order",
                  ref_id: "pending",
                  symbol: "A",
                  side: "buy",
                  state,
                  created_at: new Date(now).toISOString(),
                },
              ];
        },
      });
    const initial = {
      comparisons: {},
      batch: {
        id: "old",
        account: "TRADE",
        automatic: true,
        status: "running",
        ordered_ids: ["pending"],
        ticket_ids: ["pending"],
        results: [],
      },
    };
    const service = new Service(false, initial, broker);
    const signals = {
      strategy: ROTATION_STRATEGY,
      fresh: true,
      asof: new Date(now).toISOString(),
      message: "Ready",
      ranked: [
        { symbol: "A", range_high: 100, range_low: 80, relative_volume: 2 },
      ],
      bars: {
        A: [
          {
            time: open + 6900000,
            date: day,
            open: 109,
            high: 111,
            low: 108,
            close: 109,
            volume: 100,
          },
        ],
      },
    };
    mock.method((service as any).feed, "snapshot", () => signals);
    mock.method((service as any).feed, "refresh", async () => signals);
    try {
      assert.equal(initial.batch.status, "interrupted");
      await (service as any).tick();
      assert.equal(placements, 0);
      assert.equal(service.liveView().auto.enabled, true);
      assert.equal(
        records.get(ticketsFile)!.pending.status,
        state === "missing" ? "submitting" : "submitted",
      );
    } finally {
      cleanup();
    }
  });
}

test("shutdown during a broker read preserves the enabled choice", async () => {
  const records = fixture();
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const broker: typeof connected = async (action) =>
    action({
      async call(name) {
        if (name === "get_accounts")
          return {
            accounts: [
              {
                account_number: "TRADE",
                state: "active",
                agentic_allowed: true,
              },
            ],
          };
        if (name === "get_portfolio") {
          entered();
          await gate;
          return {
            currency: "USD",
            total_value: "100",
            equity_value: "0",
            cash: "100",
            buying_power: {
              buying_power: "100",
              unleveraged_buying_power: "100",
            },
          };
        }
        if (name === "get_equity_quotes") return { results: [] };
        throw new Error(`Unexpected ${name}`);
      },
      async rows() {
        return [];
      },
    });
  const service = new Service(false, undefined, broker);
  mock.method((service as any).feed, "snapshot", () => ({
    strategy: ROTATION_STRATEGY,
    ranked: [],
    bars: {},
    fresh: false,
  }));
  mock.method((service as any).feed, "refresh", async () => ({}));
  try {
    await enable(service);
    const ticking = (service as any).tick();
    await reading;
    const closing = service.close();
    release();
    await ticking;
    await closing;
    assert.equal(records.get(automationPreferencePath)!.enabled, true);
    assert.equal(new Service(false).liveView().auto.enabled, true);
  } finally {
    cleanup();
  }
});

test("first-upgrade migration retains the original scope and expiry", () => {
  const expiry = now + 3600000;
  const preference = preferenceFromSnapshot(
    {
      scope: scope("TRADE"),
      auto: {
        enabled: true,
        background: true,
        expires_at: new Date(expiry).toISOString(),
      },
    },
    now,
  );
  assert.equal(preference.enabled, true);
  assert.equal(preference.expires_at, expiry);
  assert.equal(preference.scope, scope("TRADE"));
  assert.equal(
    preferenceFromSnapshot(
      { scope: scope("TRADE"), auto: { enabled: false } },
      now,
    ).enabled,
    false,
  );
  assert.throws(() => preferenceFromSnapshot({}, now));
});

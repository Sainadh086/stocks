import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";
import { ticketsFile, type connected } from "../src/brokers/robinhood.js";
import {
  buildActions,
  rebalancePlan,
  ticketPending,
  Feed,
} from "../src/trading/live.js";
import {
  ROTATION_STRATEGY,
  rotationEntryReady,
} from "../src/trading/rotation.js";
import { entryReady } from "../src/trading/orb.js";
import { session } from "../src/shared/calendar.js";

const day = "2026-10-16",
  hours = session(day)!,
  now = hours[0] + 7200000 + 90000;
const pick = (symbol: string, high = 101) => ({
  symbol,
  range_high: high,
  range_low: 95,
  relative_volume: 2,
});
function bars(close: number) {
  const prior =
    hours[0] + Math.floor((now - hours[0]) / 300000) * 300000 - 300000;
  return [
    {
      time: hours[0] + 900000,
      date: day,
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: 100,
    },
    {
      time: prior,
      date: day,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
    },
  ];
}
function fixture(holding = false) {
  const records = new Map<string, Row>([
    [rolesFile, { long_term: "LONG", trading: "TRADE" }],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    path.includes("live_trading_settings_")
      ? { version: 1, account_number: "TRADE", budget: 1000, reserve_pct: 10 }
      : structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, data: Row) =>
    records.set(path, structuredClone(data)),
  );
  const quote = (price: number) => ({
    state: "active",
    has_traded: true,
    last_trade_price: String(price),
    venue_last_trade_time: new Date(now).toISOString(),
  });
  const snapshot: Row = {
    account_number: "TRADE",
    updated_at: new Date(now).toISOString(),
    positions: holding
      ? [
          {
            symbol: "A",
            quantity: "9",
            shares_available_for_sells: "9",
            average_buy_price: "100",
          },
        ]
      : [],
    orders: [],
    quotes: { A: quote(100), B: quote(103) },
    portfolio: {
      currency: "USD",
      total_value: "1000",
      equity_value: holding ? "900" : "0",
      cash: holding ? "100" : "1000",
      buying_power: {
        buying_power: holding ? "100" : "1000",
        unleveraged_buying_power: holding ? "100" : "1000",
      },
    },
  };
  const signals = {
    strategy: ROTATION_STRATEGY,
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    ranked: [pick("B")],
    candidates: [pick("A"), pick("B")],
    bars: { A: bars(100), B: bars(103) },
  };
  return { records, snapshot, signals };
}

test("live rotation accepts an established confirmed breakout after ORB's first-minute window", () => {
  const f = fixture();
  try {
    assert.match(
      entryReady(f.signals.bars.B, pick("B"), now, hours)!,
      /First breakout/,
    );
    assert.equal(
      rotationEntryReady(f.signals.bars.B, pick("B"), now, hours),
      null,
    );
    assert.equal(
      buildActions(f.snapshot, f.signals, 1000, 10, [], now).actions[0].action,
      "BUY",
    );
    f.snapshot.quotes.B.last_trade_price = "100";
    assert.match(
      buildActions(f.snapshot, f.signals, 1000, 10, [], now).actions[0].reason,
      /no longer above/,
    );
    assert.match(
      rotationEntryReady(bars(100), pick("B"), now, hours)!,
      /completed close/,
    );
    assert.match(
      rotationEntryReady(bars(103).slice(0, 1), pick("B"), now, hours)!,
      /current completed/,
    );
  } finally {
    mock.restoreAll();
  }
});

test("historical filled tickets do not consume position slots when absent from recent broker orders", () => {
  const f = fixture();
  try {
    const tickets = ["X", "Y", "Z", "Q"].map((symbol) => ({
      id: symbol,
      status: "submitted",
      reviewed_at: new Date(hours[0] - 86400000).toISOString(),
      arguments: { side: "buy", symbol },
      result: { order: { id: symbol, state: "filled" } },
    }));
    assert.equal(ticketPending(tickets[0], []), false);
    assert.equal(ticketPending({ ...tickets[0], result: {} }, []), true);
    assert.equal(
      ticketPending(tickets[0], [{ id: "X", state: "partially_filled" }]),
      true,
    );
    assert.equal(
      buildActions(f.snapshot, f.signals, 1000, 10, tickets, now).actions[0]
        .action,
      "BUY",
    );
  } finally {
    mock.restoreAll();
  }
});

test("a funded weaker holding is replaced only by a qualified stronger candidate", () => {
  const f = fixture(true);
  try {
    const plan = rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now);
    assert.deepEqual(
      plan.actions
        .filter((a: Row) => a.enabled)
        .map((a: Row) => `${a.side}:${a.symbol}`),
      ["sell:A", "buy:B"],
    );
    assert.equal(plan.actions[1].after_sell_fills, true);
    const recent = [
      {
        id: "entry",
        state: "filled",
        symbol: "A",
        side: "buy",
        created_at: new Date(now - 60000).toISOString(),
      },
    ];
    assert.equal(
      rebalancePlan(
        { ...f.snapshot, orders: recent },
        f.signals,
        1000,
        10,
        [],
        now,
      ).actions[0].action,
      "EXIT",
    );
    f.signals.bars.A = bars(101.05);
    f.signals.bars.B = bars(101.1);
    assert.equal(
      rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now).actions[0].action,
      "HOLD",
    );
    f.signals.bars.B = bars(100);
    assert.equal(
      rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now).actions[0].action,
      "HOLD",
    );
    f.signals.fresh = false;
    assert.equal(
      rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now).actions[0].action,
      "WAIT",
    );
  } finally {
    mock.restoreAll();
  }
});

for (const outcome of [
  "filled",
  "queued",
  "rejected",
  "canceled",
  "expired",
  "voided",
  "timeout",
  "preview_timeout",
])
  test(`automatic replacement waits for its sale: ${outcome}`, async () => {
    mock.timers.enable({ apis: ["Date"], now });
    const f = fixture(true),
      placed: string[] = [];
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
          if (name === "get_portfolio") return f.snapshot.portfolio;
          if (name === "get_equity_quotes")
            return {
              results: args.symbols.map((symbol: string) => ({
                quote: { symbol, ...f.snapshot.quotes[symbol] },
              })),
            };
          if (name === "review_equity_order")
            return { symbol: args.symbol, side: args.side, type: args.type };
          if (name === "place_equity_order") {
            placed.push(`${args.side}:${args.symbol}`);
            if (outcome === "timeout") throw new Error("Request timed out");
            const state =
              args.side === "sell" && outcome !== "preview_timeout"
                ? outcome
                : "filled";
            const order = {
              id: args.ref_id,
              ref_id: args.ref_id,
              symbol: args.symbol,
              side: args.side,
              state,
              created_at: new Date(now).toISOString(),
            };
            f.snapshot.orders.push(order);
            if (state === "filled" && args.side === "sell") {
              f.snapshot.positions = [];
              Object.assign(f.snapshot.portfolio, {
                cash: "1000",
                equity_value: "0",
                buying_power: {
                  buying_power: "1000",
                  unleveraged_buying_power: "1000",
                },
              });
            }
            return { order };
          }
          throw new Error(`Unexpected ${name}`);
        },
        async rows(name) {
          return structuredClone(
            name === "get_equity_positions"
              ? f.snapshot.positions
              : f.snapshot.orders,
          );
        },
      });
    const service = new Service(
      false,
      { comparisons: {}, batch: null },
      broker,
    );
    mock.method((service as any).feed, "snapshot", () => f.signals);
    mock.method((service as any).feed, "refresh", async () => f.signals);
    if (outcome === "preview_timeout") {
      const validate = (service as any).validateTicket.bind(service);
      let stalled = false;
      mock.method(
        service as any,
        "validateTicket",
        async (...args: unknown[]) => {
          await validate(...args);
          if (!stalled) {
            stalled = true;
            mock.timers.setTime(now + 17 * 60000);
          }
        },
      );
    }
    try {
      service.touch("fixture", true);
      await service.setAuto(true, "fixture", true, true);
      await (service as any).tick();
      const view = service.liveView();
      if (outcome === "preview_timeout") {
        assert.deepEqual(placed, [], "an expired preview must never be placed");
        assert.equal(view.batch.status, "superseded");
        assert.equal(view.auto.enabled, true);
        assert.match(view.batch.error, /Preview expired while connecting/);
        const expiredIds = [...view.batch.ticket_ids];
        f.signals.asof = new Date(Date.now()).toISOString();
        for (const q of Object.values(f.snapshot.quotes) as Row[])
          q.venue_last_trade_time = f.signals.asof;
        for (const frame of Object.values(f.signals.bars))
          for (const bar of frame) bar.time += 17 * 60000;
        await (service as any).tick();
        assert.equal(service.liveView().batch.status, "completed");
        assert.deepEqual(placed, ["sell:A", "buy:B"]);
        assert.ok(
          service
            .liveView()
            .batch.ticket_ids.every((id: string) => !expiredIds.includes(id)),
        );
        return;
      }
      assert.deepEqual(
        placed,
        outcome === "filled" ? ["sell:A", "buy:B"] : ["sell:A"],
      );
      assert.equal(
        view.batch.status,
        outcome === "filled"
          ? "completed"
          : outcome === "queued"
            ? "waiting_sales"
            : "stopped",
        view.batch.error,
      );
      assert.ok(view.decision_history.some((e: Row) => e.kind === "order"));
      assert.equal(
        (service.liveView().decision_history ?? []).length,
        view.decision_history.length,
        "displaying status must not initiate trades or alter history",
      );
      if (outcome === "timeout")
        assert.equal(
          Object.values(f.records.get(ticketsFile)!).filter(
            (t: Row) => t.status === "unknown",
          ).length,
          1,
        );
      if (outcome === "queued") {
        // A slow sale must not permanently stop the session just because its
        // original follow-up buy preview has expired while awaiting the fill.
        mock.timers.setTime(now + 180000);
        f.signals.asof = new Date(Date.now()).toISOString();
        for (const q of Object.values(f.snapshot.quotes) as Row[])
          q.venue_last_trade_time = f.signals.asof;
        f.snapshot.orders[0].state = "filled";
        f.snapshot.positions = [];
        Object.assign(f.snapshot.portfolio, {
          cash: "1000",
          equity_value: "0",
          buying_power: {
            buying_power: "1000",
            unleveraged_buying_power: "1000",
          },
        });
        await (service as any).tick();
        assert.equal(service.liveView().batch.status, "superseded");
        assert.equal(service.liveView().auto.enabled, true);
        assert.deepEqual(placed, ["sell:A"]);
        (service as any).liveRequested = true;
        await (service as any).tick();
        assert.equal(
          service.liveView().batch.status,
          "completed",
          service.liveView().batch.error,
        );
        assert.deepEqual(placed, ["sell:A", "buy:B"]);
      }
      const restarted = new Service(false, undefined, broker);
      assert.ok(
        restarted.liveView().decision_history.length > 0,
        "history survives a restart",
      );
    } finally {
      mock.restoreAll();
      mock.timers.reset();
    }
  });

// The initial full history warmup is allowed; repeated empty scans are bounded.
test("an empty candidate pool refreshes a bounded sweep rather than the full universe every cycle", async () => {
  const calls: string[] = [];
  const feed = new Feed({
    now: () => now,
    universe: async () => Array.from({ length: 30 }, (_, i) => `S${i}`),
    history: async (symbol, period) => {
      if (period === "1d") calls.push(symbol);
      return { bars: bars(100), source: "fixture", adjustment: "none" };
    },
  });
  await feed.refresh([], now);
  const first = calls.splice(0);
  await feed.refresh([], now);
  assert.equal(first.length, 12);
  assert.equal(calls.length, 12);
  assert.equal(
    first.some((s) => calls.includes(s)),
    false,
  );
});

for (const scenario of [
  "price_move",
  "buying_power_drop",
  "cash_drop",
  "unleveraged_power_drop",
  "signal_withdrawn",
  "slow_review",
]) {
  test(`automatic buy handles ${scenario} without growing an order or permanently pausing`, async () => {
    mock.timers.enable({ apis: ["Date"], now });
    const f = fixture(),
      reviews: number[] = [],
      placements: number[] = [];
    let quotes = 0;
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
          if (name === "get_portfolio") {
            if (scenario.endsWith("_drop")) {
              const funds = String(100 - quotes * 10);
              f.snapshot.portfolio.cash =
                scenario === "cash_drop" ? funds : "1000";
              f.snapshot.portfolio.buying_power = {
                buying_power: scenario === "buying_power_drop" ? funds : "4000",
                unleveraged_buying_power:
                  scenario === "unleveraged_power_drop" ? funds : "1000",
              };
            }
            return f.snapshot.portfolio;
          }
          if (name === "get_equity_quotes") {
            quotes++;
            const price =
              scenario === "signal_withdrawn" && quotes === 4
                ? 100
                : 103 + Math.min(quotes, 10) * 0.05;
            return {
              results: args.symbols.map((symbol: string) => ({
                quote: {
                  symbol,
                  ...f.snapshot.quotes[symbol],
                  last_trade_price: price,
                  venue_last_trade_time: new Date(Date.now()).toISOString(),
                },
              })),
            };
          }
          if (name === "review_equity_order") {
            reviews.push(Number(args.dollar_amount));
            if (scenario === "slow_review" && reviews.length === 1)
              mock.timers.setTime(now + 90000);
            return { symbol: args.symbol, side: args.side, type: args.type };
          }
          if (name === "place_equity_order") {
            placements.push(Number(args.dollar_amount));
            const order = {
              id: args.ref_id,
              ref_id: args.ref_id,
              symbol: args.symbol,
              side: args.side,
              state: "filled",
              created_at: new Date(Date.now()).toISOString(),
            };
            f.snapshot.orders.push(order);
            return { order };
          }
          throw new Error(`Unexpected ${name}`);
        },
        async rows(name) {
          return structuredClone(
            name === "get_equity_positions" ? [] : f.snapshot.orders,
          );
        },
      });
    const service = new Service(
      false,
      { comparisons: {}, batch: null },
      broker,
    );
    mock.method((service as any).feed, "snapshot", () => f.signals);
    mock.method((service as any).feed, "refresh", async () => f.signals);
    try {
      service.touch("fixture", true);
      await service.setAuto(true, "fixture", true, true);
      await (service as any).tick();
      assert.equal(service.liveView().auto.enabled, true);
      if (scenario === "signal_withdrawn") {
        assert.equal(placements.length, 0);
        assert.equal(service.liveView().batch.status, "superseded");
        (service as any).liveRequested = true;
        await (service as any).tick();
      }
      assert.equal(
        service.liveView().batch.status,
        "completed",
        service.liveView().batch.error,
      );
      assert.equal(placements.length, 1);
      assert.ok(
        placements[0] <=
          (scenario === "signal_withdrawn" ? reviews.at(-1)! : reviews[0]),
        "a submission cannot grow beyond its preview",
      );
      if (scenario === "price_move")
        assert.equal(
          placements[0],
          reviews[0],
          "price movement must not shrink a fixed dollar allocation when funds are unchanged",
        );
      if (scenario.endsWith("_drop"))
        assert.ok(
          placements[0] < reviews[0],
          "a lower fund limit must shrink the order",
        );
      assert.equal(
        placements[0],
        reviews.at(-1),
        "submit must match the re-reviewed amount",
      );
      for (let i = 1; i < reviews.length; i++) {
        // A new batch after a withdrawn signal starts its own cap.
        if (scenario !== "signal_withdrawn")
          assert.ok(reviews[i] <= reviews[i - 1]);
      }
    } finally {
      mock.restoreAll();
      mock.timers.reset();
    }
  });
}

test("newly rotated candidates get current prices before publishing actionable signals", async () => {
  let clock = hours[0] + 1230000;
  const calls: string[] = [];
  const universe = "ABCDEFGH".split("");
  const baseline = () => {
    const frame = [];
    for (let days = 1, count = 0; count < 10; days++) {
      const date = new Date(hours[0] - days * 86400000)
          .toISOString()
          .slice(0, 10),
        prior = session(date);
      if (!prior) continue;
      count++;
      for (const offset of [0, 300000, 600000])
        frame.push({
          time: prior[0] + offset,
          date,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 100,
        });
    }
    for (const offset of [0, 300000, 600000, 900000])
      frame.push({
        time: hours[0] + offset,
        date: day,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 200,
      });
    return frame;
  };
  const feed = new Feed({
    now: () => clock,
    universe: async () => universe,
    history: async (symbol, period) => {
      if (period === "60d")
        return { bars: baseline(), source: "fixture", adjustment: "none" };
      calls.push(symbol);
      const frame = baseline();
      if (["E", "F", "G", "H"].includes(symbol))
        frame[frame.length - 1] = { ...frame.at(-1)!, high: 103, close: 102 };
      return { bars: frame, source: "fixture", adjustment: "none" };
    },
  });
  await feed.refresh([], clock);
  calls.length = 0;
  clock += 60000;
  const signals = await feed.refresh([], clock);
  assert.deepEqual(
    signals.ranked.map((p) => p.symbol),
    ["E", "F", "G", "H"],
  );
  assert.ok(["E", "F", "G", "H"].every((s) => calls.includes(s)));
  assert.equal(
    rotationEntryReady(signals.bars.E, signals.ranked[0], clock, hours),
    null,
  );
});

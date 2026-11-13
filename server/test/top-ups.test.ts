import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { buildActions } from "../src/trading/live.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";
import { Service } from "../src/service.js";
import { rolesFile } from "../src/brokers/accounts.js";
import { type connected, ticketsFile } from "../src/brokers/robinhood.js";
import { store, type Row } from "../src/shared/storage.js";
import { session } from "../src/shared/calendar.js";

const day = "2026-10-19",
  hours = session(day)!,
  now = hours[0] + 7290000;
function fixture() {
  const pick = {
    symbol: "A",
    range_high: 102.95,
    range_low: 102.7,
    relative_volume: 2,
  };
  const signals = {
    strategy: ROTATION_STRATEGY,
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    ranked: [] as Row[],
    candidates: [pick],
    bars: {
      A: [
        {
          time: hours[0] + 6900000,
          date: day,
          open: 103,
          high: 103.2,
          low: 102.8,
          close: 103,
          volume: 100,
        },
      ],
    },
  };
  const snapshot: Row = {
    account_number: "TRADE",
    updated_at: new Date(now).toISOString(),
    positions: [
      {
        symbol: "A",
        quantity: "1",
        shares_available_for_sells: "1",
        average_buy_price: "103",
      },
    ],
    orders: [],
    quotes: {
      A: {
        state: "active",
        has_traded: true,
        last_trade_price: "103",
        venue_last_trade_time: new Date(now).toISOString(),
      },
    },
    portfolio: {
      currency: "USD",
      total_value: "1000",
      equity_value: "103",
      cash: "897",
      buying_power: { buying_power: "897", unleveraged_buying_power: "897" },
    },
  };
  return { signals, snapshot };
}
function actions(
  f: ReturnType<typeof fixture>,
  tickets: Row[] = [],
  budget = 1000,
  reserve = 10,
) {
  return buildActions(
    f.snapshot,
    f.signals,
    budget,
    reserve,
    tickets,
    now,
    1000,
  ).actions as Row[];
}
function entry() {
  return {
    id: "original",
    status: "submitted",
    strategy: ROTATION_STRATEGY,
    reviewed_at: new Date(now - 600000).toISOString(),
    arguments: {
      account_number: "TRADE",
      symbol: "A",
      side: "buy",
      dollar_amount: "103",
    },
    stop: "102.9",
    target: "105",
    result: { order: { id: "original", state: "filled" } },
  };
}

test("an existing qualified holding can use remaining money without counting as a new position", () => {
  const f = fixture(),
    a = actions(f)[0];
  assert.equal(a.action, "BUY", a.reason);
  assert.equal(a.top_up, true);
  assert.equal(a.dollar_amount, "347.00");
  assert.equal(actions(f).length, 1, "one decision per symbol");
  assert.ok(
    103 + Number(a.dollar_amount) <= 450,
    "one stock receives at most half the deployable budget",
  );
  for (const symbol of ["B", "C", "D"]) {
    f.snapshot.positions.push({ ...f.snapshot.positions[0], symbol });
    f.snapshot.quotes[symbol] = { ...f.snapshot.quotes.A };
  }
  f.snapshot.portfolio.equity_value = "412";
  assert.equal(
    actions(f).find((a) => a.symbol === "A")!.action,
    "BUY",
    "four occupied slots do not block a top-up",
  );
});
test("cost-dominated top-ups wait while an existing stop exit remains available", () => {
  const f = fixture();
  f.signals.candidates[0].range_low = 102.99;
  f.signals.candidates[0].range_high = 102.995;
  const holding = actions(f)[0];
  assert.equal(holding.action, "HOLD");
  assert.match(holding.reason, /estimated costs/);
  f.snapshot.quotes.A.last_trade_price = "102.98";
  assert.equal(actions(f)[0].action, "EXIT");
});

test("top-ups honor buying power, total budget, reserve and equal allocations", () => {
  const f = fixture();
  f.snapshot.portfolio.buying_power = {
    buying_power: "5",
    unleveraged_buying_power: "5",
  };
  assert.equal(
    actions(f)[0].enabled,
    false,
    "cash is retained when the existing holding already exceeds half of currently deployable capital",
  );
  assert.equal(actions(f, [], 100)[0].enabled, false);
  assert.equal(actions(f, [], 1000, 100)[0].enabled, false);
  f.snapshot.portfolio.buying_power = {
    buying_power: "897",
    unleveraged_buying_power: "897",
  };
  f.snapshot.positions[0].quantity = String(450 / 103);
  f.snapshot.portfolio.equity_value = "450";
  f.snapshot.portfolio.cash = "550";
  f.snapshot.portfolio.buying_power = {
    buying_power: "550",
    unleveraged_buying_power: "550",
  };
  assert.equal(actions(f)[0].action, "HOLD");
  f.snapshot.positions[0].quantity = "0.1";
  f.snapshot.positions[0].average_buy_price = "150";
  f.snapshot.portfolio.equity_value = "10.3";
  f.snapshot.portfolio.cash = "989.7";
  f.snapshot.portfolio.buying_power = {
    buying_power: "989.7",
    unleveraged_buying_power: "989.7",
  };
  assert.equal(
    actions(f)[0].enabled,
    false,
    "an existing loss beyond the position risk budget must block further adds",
  );
  f.snapshot.positions[0].average_buy_price = "103";
  f.snapshot.positions[0].quantity = "0.001";
  f.snapshot.portfolio.equity_value = "0.103";
  f.snapshot.portfolio.buying_power = {
    buying_power: "0.99",
    unleveraged_buying_power: "0.99",
  };
  assert.match(actions(f)[0].reason, /minimum add/);
});

test("multiple existing holdings share remaining funds without allocating the same cash twice", () => {
  const f = fixture();
  f.snapshot.positions.push({ ...f.snapshot.positions[0], symbol: "B" });
  f.snapshot.quotes.B = { ...f.snapshot.quotes.A };
  f.signals.candidates.push({ ...f.signals.candidates[0], symbol: "B" });
  (f.signals.bars as Row).B = [...f.signals.bars.A];
  f.snapshot.portfolio.equity_value = "206";
  f.snapshot.portfolio.cash = "794";
  f.snapshot.portfolio.buying_power = {
    buying_power: "200",
    unleveraged_buying_power: "200",
  };
  const buys = actions(f).filter((a) => a.enabled && a.side === "buy");
  assert.equal(buys.length, 2);
  assert.equal(
    buys.reduce((sum, a) => sum + Number(a.dollar_amount), 0),
    200,
  );
  assert.ok(buys.every((a) => a.top_up));
});

test("same-day entries permit adds while exits, pending orders and stale data block them", () => {
  const f = fixture();
  assert.equal(actions(f, [entry()])[0].action, "BUY");
  assert.equal(
    actions(f, [{ ...entry(), status: "unknown" }])[0].enabled,
    false,
  );
  f.snapshot.orders = [{ symbol: "A", state: "queued", side: "buy" }];
  assert.equal(actions(f)[0].enabled, false);
  f.snapshot.orders = [];
  f.signals.fresh = false;
  assert.equal(actions(f)[0].enabled, false);
  f.signals.fresh = true;
  f.snapshot.quotes.A.venue_last_trade_time = new Date(
    now - 90001,
  ).toISOString();
  assert.equal(actions(f)[0].enabled, false);
  f.snapshot.quotes.A.venue_last_trade_time = new Date(now).toISOString();
  for (const price of ["101", "106"]) {
    f.snapshot.quotes.A.last_trade_price = price;
    assert.equal(actions(f)[0].action, "EXIT");
    assert.equal(actions(f)[0].top_up, undefined);
  }
  f.snapshot.positions = [];
  f.snapshot.quotes.A.last_trade_price = "103";
  f.signals.ranked = f.signals.candidates;
  assert.match(
    actions(f, [entry()])[0].reason,
    /already traded today/,
    "adds do not permit re-entering a fully exited stock",
  );
});

test("a top-up keeps an existing tighter stop and requires a qualified held-stock signal", () => {
  const f = fixture(),
    t = entry();
  t.stop = "102.95";
  assert.equal(actions(f, [t])[0].stop, "102.95");
  f.signals.candidates[0].relative_volume = 1;
  assert.equal(actions(f, [t])[0].action, "HOLD");
});

for (const state of ["filled", "queued"]) {
  test(`automatic top-up ${state} executes once and rechecks available funds`, async () => {
    mock.timers.enable({ apis: ["Date"], now });
    const f = fixture(),
      placed: Row[] = [],
      reviews: Row[] = [];
    const records = new Map<string, Row>([
      [rolesFile, { long_term: "LONG", trading: "TRADE" }],
      [ticketsFile, { original: entry() }],
    ]);
    mock.method(store, "json", (path: string, fallback: Row) =>
      path.includes("live_trading_settings_")
        ? { version: 1, account_number: "TRADE", budget: 1000, reserve_pct: 10 }
        : structuredClone(records.get(path) ?? fallback),
    );
    mock.method(store, "save", (path: string, value: Row) =>
      records.set(path, structuredClone(value)),
    );
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
            return structuredClone(f.snapshot.portfolio);
          if (name === "get_equity_quotes")
            return {
              results: args.symbols.map((symbol: string) => ({
                quote: { symbol, ...f.snapshot.quotes[symbol] },
              })),
            };
          if (name === "review_equity_order") {
            reviews.push({ ...args });
            return { symbol: args.symbol, side: args.side, type: args.type };
          }
          if (name === "place_equity_order") {
            placed.push({ ...args });
            const order = {
              id: args.ref_id,
              ref_id: args.ref_id,
              side: args.side,
              symbol: args.symbol,
              state,
              created_at: new Date(now).toISOString(),
            };
            f.snapshot.orders.push(order);
            if (state === "filled") {
              const dollars = Number(args.dollar_amount);
              f.snapshot.positions[0].quantity = String(1 + dollars / 103);
              f.snapshot.positions[0].shares_available_for_sells =
                f.snapshot.positions[0].quantity;
              f.snapshot.portfolio.equity_value = String(103 + dollars);
              f.snapshot.portfolio.cash = String(897 - dollars);
              f.snapshot.portfolio.buying_power = {
                buying_power: String(897 - dollars),
                unleveraged_buying_power: String(897 - dollars),
              };
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
    try {
      service.touch("fixture", true);
      await service.setAuto(true, "fixture", true, true);
      await (service as any).tick();
      assert.equal(placed.length, 1);
      assert.equal(placed[0].symbol, "A");
      assert.equal(placed[0].side, "buy");
      assert.equal(placed[0].dollar_amount, "347.00");
      assert.equal(reviews.at(-1)!.dollar_amount, placed[0].dollar_amount);
      assert.equal(
        service.liveView().batch.status,
        state === "filled" ? "completed" : "waiting_buys",
        service.liveView().batch.error,
      );
      assert.equal(
        Object.values(records.get(ticketsFile)!).filter((t: Row) => t.top_up)
          .length,
        1,
      );
      (service as any).liveRequested = true;
      await (service as any).tick();
      assert.equal(
        placed.length,
        1,
        "a filled position at target or a pending add must not trigger duplicate buys",
      );
    } finally {
      mock.restoreAll();
      mock.timers.reset();
    }
  });
}

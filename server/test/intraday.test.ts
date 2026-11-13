import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  intradayBars,
  intradayIndicators,
  intradayEntryCheck,
  intradayQuoteCheck,
  intradayStop,
  protectedStop,
} from "../src/trading/intraday.js";
import { buildActions, rebalancePlan } from "../src/trading/live.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";
import { execution } from "../src/trading/orb.js";
import { session } from "../src/shared/calendar.js";
import { store, US, type Row } from "../src/shared/storage.js";

const day = "2026-10-22",
  hours = session(day)!,
  now = hours[0] + 1200000;
const bar = (index: number, close = 100) => ({
  time: hours[0] + index * 300000,
  date: day,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
});
const frame = () => [bar(0, 99), bar(1, 100), bar(2, 100), bar(3, 101)];
const pick = {
  symbol: "A",
  range_high: 100,
  range_low: 95,
  relative_volume: 2,
};

test("session indicators ignore premarket, incomplete, synthetic, invalid and duplicate bars", () => {
  const original = frame(),
    data = [...original].reverse();
  data.push(
    original[0],
    { ...bar(-1), volume: 100000 },
    bar(4, 200),
    { ...bar(3, 200), kind: "quote" } as any,
    { ...bar(2), low: -1 },
  );
  assert.deepEqual(intradayBars(data, now, hours[0]), original);
  const metrics = intradayIndicators(data, now, hours[0]);
  assert.equal(metrics.vwap, 100);
  assert.ok(metrics.ema9! > 99 && metrics.ema9! < 101);
  assert.equal(metrics.atr, 2);
  assert.equal(intradayStop(data, now, hours[0], 101, 95), 98);
});

test("entries require volume, VWAP and EMA confirmation and respect the closing cutoff", () => {
  assert.equal(intradayEntryCheck(frame(), pick, now, hours), null);
  assert.match(
    intradayEntryCheck(
      frame(),
      { ...pick, relative_volume: 1.49 },
      now,
      hours,
    )!,
    /volume/,
  );
  const belowVwap = [bar(0, 110), bar(1, 110), bar(2, 110), bar(3, 101)];
  assert.match(intradayEntryCheck(belowVwap, pick, now, hours)!, /VWAP/);
  const belowEma = [
    { ...bar(0, 99), volume: 10000 },
    bar(1, 110),
    bar(2, 110),
    bar(3, 100),
  ];
  assert.match(intradayEntryCheck(belowEma, pick, now, hours)!, /EMA/);
  assert.match(
    intradayEntryCheck(frame(), pick, hours[1] - 900000, hours)!,
    /last 15 minutes/,
  );
  assert.match(
    intradayEntryCheck(
      frame().map((b) => ({ ...b, volume: 0 })),
      pick,
      now,
      hours,
    )!,
    /OHLCV/,
  );
});

test("quote guards reject chasing and wide or crossed spreads without blocking valid liquidity", () => {
  const quote = {
    last_trade_price: "101",
    bid_price: "100.99",
    ask_price: "101.01",
  };
  assert.equal(intradayQuoteCheck(quote, frame(), now, hours[0]), null);
  assert.match(
    intradayQuoteCheck(
      { ...quote, last_trade_price: "105" },
      frame(),
      now,
      hours[0],
    )!,
    /chasing/,
  );
  assert.match(
    intradayQuoteCheck({ ...quote, ask_price: "102" }, frame(), now, hours[0])!,
    /spread exceeds/,
  );
  assert.match(
    intradayQuoteCheck({ ...quote, bid_price: "102" }, frame(), now, hours[0])!,
    /valid bid\/ask/,
  );
  assert.match(
    intradayQuoteCheck(
      { ...quote, last_trade_price: "99" },
      frame(),
      now,
      hours[0],
    )!,
    /VWAP or EMA/,
  );
});

test("profit protection activates only after an entry reaches a completed +1R and never loosens", () => {
  const data = [bar(0, 101), bar(1, 103), bar(2, 104), bar(3, 102)];
  assert.equal(
    protectedStop(data, hours[0] + 300000, hours[0], 100, 98, hours[0]),
    98,
  );
  const activated = protectedStop(
    data,
    hours[0] + 600000,
    hours[0],
    100,
    98,
    hours[0],
  );
  assert.equal(activated, 100);
  const trailed = protectedStop(
    data,
    hours[0] + 900000,
    hours[0],
    100,
    98,
    hours[0],
  );
  assert.equal(trailed, 102);
  assert.equal(protectedStop(data, now, hours[0], 100, 98, hours[0]), trailed);
  assert.equal(
    protectedStop(data, now, hours[0], 100, 98, now),
    98,
    "pre-entry highs cannot activate protection",
  );
});

function fixture() {
  const snapshot: Row = {
    account_number: "TEST",
    updated_at: new Date(now).toISOString(),
    positions: [],
    orders: [],
    quotes: {
      A: {
        state: "active",
        has_traded: true,
        last_trade_price: "101",
        venue_last_trade_time: new Date(now).toISOString(),
      },
    },
    portfolio: {
      currency: "USD",
      total_value: "1000",
      equity_value: "0",
      cash: "1000",
      buying_power: { buying_power: "1000", unleveraged_buying_power: "1000" },
    },
  };
  const signals = {
    strategy: ROTATION_STRATEGY,
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    ranked: [pick],
    candidates: [pick],
    bars: { A: frame() },
  };
  return { snapshot, signals };
}

test("equal-budget targets are capped by stop risk including execution costs", () => {
  const f = fixture(),
    model = buildActions(f.snapshot, f.signals, 1000, 10, [], now, 1000),
    action = model.actions[0];
  assert.equal(action.action, "BUY", action.reason);
  assert.equal(model.target_usd, 450);
  assert.equal(action.risk_limited, true);
  assert.ok(Number(action.dollar_amount) < 450);
  const quantity = Number(action.dollar_amount) / Number(action.price);
  const buy = execution(Number(action.price), quantity, "BUY"),
    sell = execution(Number(action.stop), quantity, "SELL");
  assert.ok(buy.value + buy.fee - sell.value + sell.fee <= 2.5);
  assert.ok(action.planned_risk_usd <= action.risk_cap_usd);
});

test("daily loss halt persists across rebuilding the model and equity recovery, and resets next session", () => {
  const f = fixture(),
    file = join(US, "live_intraday_risk.json"),
    records = new Map<string, Row>([[file, { TEST: { day, equity: "1000" } }]]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  f.snapshot.positions = [
    {
      symbol: "A",
      quantity: "1",
      shares_available_for_sells: "1",
      average_buy_price: "101",
    },
  ];
  f.snapshot.portfolio.equity_value = "101";
  f.snapshot.portfolio.total_value = "990";
  try {
    let model = rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now);
    assert.equal(model.daily_halted, true);
    assert.equal(model.actions[0].action, "EXIT");
    assert.match(model.actions[0].reason, /circuit breaker/);
    assert.ok(!model.actions.some((a: Row) => a.enabled && a.side === "buy"));
    f.snapshot.portfolio.total_value = "1005";
    model = rebalancePlan(f.snapshot, f.signals, 1000, 10, [], now);
    assert.equal(
      model.daily_halted,
      true,
      "a recovered account must not restart buying after a daily halt",
    );
    const tomorrow = session("2026-10-23")![0] + 1200000;
    f.snapshot.updated_at = new Date(tomorrow).toISOString();
    assert.equal(
      buildActions(f.snapshot, f.signals, 1000, 10, [], tomorrow).daily_halted,
      false,
    );
  } finally {
    mock.restoreAll();
  }
});

test("trailing exits remain available when entry signals are stale and keep the original 2R target", () => {
  const f = fixture();
  f.snapshot.positions = [
    {
      symbol: "A",
      quantity: "1",
      shares_available_for_sells: "1",
      average_buy_price: "100",
    },
  ];
  f.snapshot.quotes.A.last_trade_price = "101.5";
  f.signals.bars.A = [bar(0, 101), bar(1, 103), bar(2, 104), bar(3, 102)];
  f.signals.fresh = false;
  const ticket = {
    id: "entry",
    status: "submitted",
    strategy: ROTATION_STRATEGY,
    reviewed_at: new Date(hours[0]).toISOString(),
    arguments: { symbol: "A", side: "buy" },
    stop: "98",
    initial_stop: "98",
    risk_entry: "100",
    target: "104",
    result: { order: { state: "filled" } },
  };
  const action = buildActions(
    f.snapshot,
    f.signals,
    1000,
    10,
    [ticket],
    now,
    1000,
  ).actions[0];
  assert.equal(action.action, "EXIT");
  assert.match(action.reason, /trailing stop/);
  assert.equal(action.stop, "102");
  assert.equal(action.target, "104");
});

test("entry cutoff follows exchange half-day closes", () => {
  const half = session("2026-11-27")!;
  assert.equal(half[1] - half[0], 3.5 * 3600000);
  assert.match(
    intradayEntryCheck([], pick, half[1] - 900000, half)!,
    /last 15 minutes/,
  );
});

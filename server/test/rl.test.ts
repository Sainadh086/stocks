import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  trainPortfolio,
  allocate,
  observation,
  validatePolicy,
  RL_VERSION,
  type Policy,
} from "../src/trading/rl.js";
import { buy, sell, equity, step, type Bars } from "../src/trading/orb.js";
import { buildActions, Feed } from "../src/trading/live.js";
import { learningSettingsFile, saveLearningSettings } from "../src/learning.js";
import { store, type Row } from "../src/shared/storage.js";
import { newAccount } from "../src/backtest.js";
import { session } from "../src/shared/calendar.js";

const days = [
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
  "2026-09-21",
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
];
function data(): Bars {
  return Object.fromEntries(
    ["A", "B", "C", "D"].map((symbol, s) => [
      symbol,
      days.flatMap((date, d) =>
        Array.from({ length: 30 }, (_, i) => {
          const price = 100 + d * 0.1 + i * (s < 2 ? 0.02 : -0.01);
          return {
            time: session(date)![0] + i * 300000,
            date,
            open: price,
            close: price + 0.01,
            high: price + 0.1,
            low: price - 0.1,
            volume: 1000,
          };
        }),
      ),
    ]),
  );
}
function model(state: string, action: number, trainedUntil = 0): Policy {
  const q = [0, 0, 0];
  q[action] = 1;
  return {
    version: RL_VERSION,
    interval_ms: 300000,
    trained_until: trainedUntil,
    epochs: 40,
    seed: 17,
    cost_bps: 8,
    q: { [state]: q },
    visits: { [state]: [10, 10, 10] },
  };
}
test("RL training is reproducible and held-out prices cannot change the trained policy", () => {
  const bars = data(),
    first = trainPortfolio(bars, 8, 17),
    second = trainPortfolio(bars, 8, 17);
  assert.deepEqual(first, second);
  assert.ok(
    Object.values(first.policy.visits)
      .flat()
      .some((n) => n > 5),
  );
  assert.equal(first.report.live_ready, false);
  assert.ok(first.report.held_out.curve.length > 0);
  const altered = structuredClone(bars);
  for (const frame of Object.values(altered))
    for (const b of frame) {
      if (b.time > first.policy.trained_until)
        for (const k of ["open", "close", "high", "low"] as const) b[k] *= 2;
    }
  assert.deepEqual(trainPortfolio(altered, 8, 17).policy, first.policy);
  assert.ok(first.report.double_cost.turnover_usd >= 0);
  assert.ok(first.report.held_out.max_drawdown_pct >= 0);
});
test("RL inference ignores unfinished/future candles, caps weights and blocks unseen or overlapping states", () => {
  const bars = data(),
    now = bars.A.at(-1)!.time + 300000;
  const obs = observation(bars, now, 1, 0),
    p = model(obs.state, 2);
  const result = allocate(p, bars, now, 1, 0);
  assert.equal(
    Object.values(result.weights).reduce((a, b) => a + b, 0),
    1,
  );
  assert.ok(Object.values(result.weights).every((n) => n <= 0.25));
  const future = structuredClone(bars);
  future.A.push({ ...future.A.at(-1)!, time: now, close: 100000 });
  assert.deepEqual(allocate(p, future, now, 1, 0), result);
  assert.equal(
    allocate({ ...p, q: {}, visits: {} }, bars, now, 1, 0).action,
    null,
  );
  assert.equal(
    allocate({ ...p, trained_until: now }, bars, now, 1, 0).action,
    null,
  );
  assert.throws(() =>
    validatePolicy({ ...p, q: { [obs.state]: [NaN, 0, 0] } }),
  );
  assert.throws(() => trainPortfolio(bars, 0));
  assert.throws(
    () => trainPortfolio({ A: bars.A.filter((_, i) => i % 30 === 0) }),
    /five-minute/,
  );
});
test("runtime feeds ignore a configured allocation policy until learning execution is explicitly enabled", () => {
  let saved: Row = {};
  mock.method(store, "json", (path: string, fallback: Row) =>
    path === learningSettingsFile ? saved : fallback,
  );
  mock.method(store, "save", (_path: string, value: Row) => {
    saved = value;
  });
  try {
    const feed = new Feed(),
      policy = model("1:0:0:2", 0);
    (feed as any).current.policy = policy;
    assert.equal(feed.snapshot().policy, undefined);
    saveLearningSettings(true);
    assert.deepEqual(feed.snapshot().policy, policy);
    saveLearningSettings(false);
    assert.equal(feed.snapshot().policy, undefined);
  } finally {
    mock.restoreAll();
  }
});

test("paper partial rebalancing preserves quantity, cost basis and realized accounting", () => {
  const s = newAccount();
  buy(s, "A", 100, 10, 0, 99, 104);
  const cash = s.cash,
    cost = s.positions.A.cost;
  sell(s, "A", 101, 1000, "RL trim", 4);
  assert.equal(s.positions.A.quantity, 6);
  assert.ok(Math.abs(s.positions.A.cost - cost * 0.6) < 1e-8);
  assert.ok(s.cash > cash);
  sell(s, "A", 101, 2000, "RL cash");
  assert.deepEqual(s.positions, {});
  assert.ok(Math.abs(equity(s) - s.budget - s.realized_pnl) < 1e-8);
  assert.throws(() => sell(s, "A", 101, 3000, "oversell", 1));
});
test("live RL reductions respect pending orders and fresh signal checks", () => {
  const bars = data(),
    now = bars.A.at(-1)!.time + 30000 + 300000;
  const snapshot = {
    account_number: "TEST",
    updated_at: new Date(now).toISOString(),
    positions: [
      {
        symbol: "A",
        quantity: 40,
        shares_available_for_sells: 40,
        average_buy_price: 100,
      },
    ],
    orders: [{ id: "entry", side: "buy", symbol: "A", state: "filled" }],
    portfolio: {
      currency: "USD",
      total_value: 10000,
      equity_value: 4000,
      cash: 6000,
      buying_power: { buying_power: 6000, unleveraged_buying_power: 6000 },
    },
    quotes: {
      A: {
        state: "active",
        has_traded: true,
        last_trade_price: 100,
        venue_last_trade_time: new Date(now).toISOString(),
      },
    },
  };
  const state = observation(bars, now, 0.6, 0, ["A"]).state;
  const signals = {
    strategy: "orb_15m_v1",
    bars,
    ranked: [],
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    policy: model(state, 0),
  };
  const tickets = [
    {
      strategy: "orb_15m_v1",
      arguments: { symbol: "A", side: "buy" },
      status: "submitted",
      reviewed_at: new Date(now).toISOString(),
      stop: 90,
      target: 120,
      result: { order: { id: "entry" } },
    },
  ];
  const result = buildActions(
    snapshot,
    signals,
    10000,
    10,
    tickets,
    now,
    10000,
  );
  assert.equal(result.actions[0].action, "EXIT");
  assert.match(result.actions[0].reason, /RL allocation/);
  assert.equal(Number(result.actions[0].quantity), 40);
  assert.equal(
    buildActions(
      {
        ...snapshot,
        orders: [...snapshot.orders, { symbol: "A", state: "queued" }],
      },
      signals,
      10000,
      10,
      tickets,
      now,
      10000,
    ).actions[0].enabled,
    false,
  );
  assert.equal(
    buildActions(
      snapshot,
      { ...signals, fresh: false },
      10000,
      10,
      tickets,
      now,
      10000,
    ).actions[0].action,
    "HOLD",
  );
});

test("paper worker applies learned cash exits while uncovered states preserve holdings", () => {
  const bars = data(),
    last = bars.A.at(-1)!,
    now = last.time + 300000;
  bars.A.push({
    ...last,
    kind: "quote",
    time: now,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 0,
  });
  const account = newAccount();
  buy(account, "A", 100, 10, now - 30000, 90, 130, { session_day: last.date });
  const state = observation(bars, now, account.cash / equity(account), 0, [
    "A",
  ]).state;
  const before = structuredClone(account);
  const result = step(account, bars, now, [], model(state, 0));
  assert.deepEqual(result.positions, {});
  assert.equal(result.rl.action, 0);
  assert.match(result.fills.at(-1).reason, /RL allocation/);
  const uncovered = step(before, bars, now, [], {
    ...model(state, 0),
    q: {},
    visits: {},
  });
  assert.ok(uncovered.positions.A);
  assert.equal(uncovered.fills.length, 1);
});

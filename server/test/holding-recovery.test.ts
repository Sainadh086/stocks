import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { buildActions } from "../src/trading/live.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";
import { STRATEGY } from "../src/trading/orb.js";
import { session } from "../src/shared/calendar.js";
import { store, type Row } from "../src/shared/storage.js";

const day = "2026-11-11",
  hours = session(day)!,
  now = hours[0] + 7200000;
afterEach(() => mock.restoreAll());
function fixture(strategy = ROTATION_STRATEGY) {
  mock.method(store, "json", (_path: string, fallback: Row) =>
    structuredClone(fallback),
  );
  const snapshot: Row = {
    account_number: "TRADE",
    updated_at: new Date(now).toISOString(),
    positions: [
      {
        symbol: "A",
        quantity: "1",
        shares_available_for_sells: "1",
        average_buy_price: "100",
      },
    ],
    quotes: {
      A: {
        state: "active",
        has_traded: true,
        last_trade_price: "100",
        venue_last_trade_time: new Date(now).toISOString(),
      },
    },
    orders: [],
    portfolio: {
      currency: "USD",
      total_value: "1000",
      equity_value: "100",
      cash: "900",
      buying_power: { buying_power: "900", unleveraged_buying_power: "900" },
    },
  };
  const signals = {
    strategy,
    fresh: false,
    asof: null,
    message: "Reloading signals after interruption",
    ranked: [] as Row[],
    candidates: [] as Row[],
    bars: {},
  };
  const ticket: Row = {
    id: "original",
    status: "submitted",
    strategy,
    reviewed_at: "2026-11-10T17:00:00Z",
    stop: "95",
    initial_stop: "95",
    risk_entry: "100",
    target: "110",
    arguments: { account_number: "TRADE", symbol: "A", side: "buy" },
    result: { order: { id: "filled-original", state: "filled" } },
  };
  const action = (tickets = [ticket], time = now) =>
    buildActions(snapshot, signals, 1000, 10, tickets, time, 1000)
      .actions[0] as Row;
  return { snapshot, signals, ticket, action };
}

for (const strategy of [STRATEGY, ROTATION_STRATEGY]) {
  test(`${strategy} retains a prior-session purchase during recovery and sells only when its recorded stop or target is hit`, () => {
    const f = fixture(strategy);
    assert.equal(f.action().action, "HOLD");
    assert.equal(f.action().side, null);
    assert.equal(f.action().stop, "95");
    assert.equal(f.action().target, "110");
    f.snapshot.quotes.A.last_trade_price = "94";
    assert.equal(f.action().action, "EXIT");
    assert.match(f.action().reason, /stop hit/);
    f.snapshot.quotes.A.last_trade_price = "111";
    assert.equal(f.action().action, "EXIT");
    assert.match(f.action().reason, /target hit/);
  });
  test(`${strategy} waits for analysis when an existing holding has no saved risk metadata instead of liquidating it`, () => {
    const f = fixture(strategy);
    f.ticket.stop = null;
    assert.equal(
      f.action().action,
      "HOLD",
      "an intact original stop survives missing later metadata",
    );
    assert.equal(f.action().stop, "95");
    f.ticket.initial_stop = null;
    f.ticket.target = null;
    for (const tickets of [[f.ticket], []]) {
      const a = f.action(tickets);
      assert.equal(a.action, "WAIT");
      assert.equal(a.side, null);
      assert.equal(a.enabled, false);
      assert.match(a.reason, /current analysis and valid risk levels/);
    }
    f.signals.fresh = true;
    f.signals.candidates = [
      { symbol: "A", range_high: 102, range_low: 95, relative_volume: 0 },
    ];
    assert.equal(
      f.action([]).action,
      "HOLD",
      "the existing holding is assessed even outside the buy shortlist",
    );
    assert.equal(f.action([]).stop, "95");
    assert.equal(f.action([]).target, "110");
    f.snapshot.quotes.A.last_trade_price = "94";
    assert.equal(f.action([]).action, "EXIT");
    f.signals.fresh = false;
    assert.equal(
      f.action([]).action,
      "WAIT",
      "stale candidate levels cannot create a recovery sell",
    );
  });
}

test("a failed retry without fills cannot replace the original holding's risk levels", () => {
  const f = fixture();
  for (const state of ["rejected", "failed", "canceled", "expired", "voided"]) {
    const failed: Row = {
      ...f.ticket,
      id: "retry",
      reviewed_at: new Date(now - 10000).toISOString(),
      stop: "105",
      target: "130",
      result: { order: { id: "retry", state, cumulative_quantity: "0" } },
    };
    const a = f.action([f.ticket, failed]);
    assert.equal(a.action, "HOLD", state);
    assert.equal(a.stop, "95", state);
  }
  const latest: Row = {
    ...f.ticket,
    id: "retry",
    reviewed_at: new Date(now - 10000).toISOString(),
    stop: "105",
    result: { order: { id: "retry", state: "filled" } },
  };
  f.snapshot.orders = [
    { id: "retry", ref_id: "retry", state: "rejected", filled_quantity: "0" },
  ];
  assert.equal(
    f.action([f.ticket, latest]).action,
    "HOLD",
    "fresh broker rejection takes precedence over an older receipt",
  );
  for (const fill of [
    { cumulative_quantity: "0.2" },
    { executions: [{ quantity: "0.2" }] },
  ]) {
    f.snapshot.orders = [
      { id: "retry", ref_id: "retry", state: "canceled", ...fill },
    ];
    assert.equal(
      f.action([f.ticket, latest]).action,
      "EXIT",
      "protection for confirmed partial fills remains active",
    );
  }
});

test("missing recovery metadata does not disable known targets, daily-loss exits, closing exits or pending-order guards", () => {
  const f = fixture();
  f.ticket.stop = null;
  f.snapshot.quotes.A.last_trade_price = "111";
  assert.match(f.action().reason, /target hit/);
  f.ticket.target = null;
  f.snapshot.portfolio.total_value = "989";
  assert.match(f.action().reason, /circuit breaker/);
  f.snapshot.portfolio.total_value = "1000";
  const closing = hours[1] - 240000;
  f.snapshot.updated_at = new Date(closing).toISOString();
  f.snapshot.quotes.A.venue_last_trade_time = new Date(closing).toISOString();
  assert.match(f.action([f.ticket], closing).reason, /Scheduled exit/);
  f.ticket.status = "unknown";
  assert.equal(f.action([f.ticket], closing).action, "WAIT");
  assert.match(f.action([f.ticket], closing).reason, /unresolved status/);
});

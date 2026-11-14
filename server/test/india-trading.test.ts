import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import { session } from "../src/shared/calendar.js";
import { history } from "../src/shared/prices.js";
import {
  IndiaTrading,
  indiaActions,
  managedShares,
  indiaTradingFile,
} from "../src/trading/india.js";
import {
  IndiaBrokerError,
  credentialsFile,
  type IndiaSnapshot,
} from "../src/brokers/india.js";
import { shortlist } from "../src/trading/orb.js";
import { Feed, type Signals } from "../src/trading/live.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";

const day = "2026-11-11",
  hours = session(day, "NSE")!,
  now = hours[0] + 7200000;
const settings = { budget: 100000, reserve_pct: 10, symbols: ["INFY"] };
function fixture() {
  mock.timers.enable({ apis: ["Date"], now });
  const records = new Map<string, Row>();
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  const bars = [0, 300000, 600000].map((offset) => ({
    time: hours[0] + offset,
    date: day,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  bars.push({
    time: now - 300000,
    date: day,
    open: 102,
    high: 104,
    low: 102,
    close: 103,
    volume: 1000,
  });
  const signals: Signals = {
    strategy: ROTATION_STRATEGY,
    ranked: [
      { symbol: "INFY", range_high: 101, range_low: 99, relative_volume: 2 },
    ],
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    bars: { INFY: bars },
  };
  const data: IndiaSnapshot = {
    user: "IND123",
    cash: 100000,
    positions: [],
    orders: [],
    quotes: {
      INFY: {
        last_trade_price: 103,
        venue_last_trade_time: new Date(now).toISOString(),
        bid_price: 102.95,
        ask_price: 103.05,
      },
    },
    updated_at: new Date(now).toISOString(),
  };
  return { records, data, signals };
}
function restore() {
  mock.restoreAll();
  mock.timers.reset();
}

test("India signals use NSE opening ranges, holidays and market hours instead of New York hours", async () => {
  const f = fixture();
  try {
    const frames = [...f.signals.bars.INFY];
    const priorDays = [
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ];
    for (const date of priorDays) {
      const s = session(date, "NSE");
      if (!s) continue;
      frames.push(
        ...[0, 300000, 600000].map((offset) => ({
          time: s[0] + offset,
          date,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 50,
        })),
      );
    }
    const ranked = shortlist({ INFY: frames }, day, 4, "NSE");
    assert.equal(ranked[0].symbol, "INFY");
    assert.equal(ranked[0].relative_volume, 2);
    assert.deepEqual(shortlist({ INFY: frames }, day), []);
    const feed = new Feed(
      {
        universe: async () => ["INFY"],
        history: async () => ({
          bars: frames,
          source: "test",
          adjustment: "none",
        }),
        now: () => now,
      },
      "NSE",
    );
    const ready = await feed.refresh([], now);
    assert.equal(ready.fresh, true, ready.message);
    assert.equal(ready.ranked[0].symbol, "INFY");
    assert.equal(ready.policy, undefined);
    const closed = await feed.refresh([], hours[1]);
    assert.equal(closed.fresh, false);
    assert.equal(closed.scan?.phase, "market_closed");
  } finally {
    restore();
  }
});

test("India status shows setup and broker errors without starting unconfigured scans", async () => {
  const f = fixture();
  let historyReads = 0,
    updates = 0,
    unavailable = false;
  const engine = new IndiaTrading(
    () => {
      updates++;
    },
    {
      snapshot: async () => {
        if (unavailable)
          throw new Error("Insufficient permission for that call.");
        return structuredClone(f.data);
      },
      history: async () => {
        historyReads++;
        return { bars: [], source: "fixture", adjustment: "none" };
      },
      place: async () => {
        throw new Error("No orders expected");
      },
      cancel: async () => {
        throw new Error("No cancellation expected");
      },
    },
  );
  try {
    assert.equal(engine.view().broker, null);
    assert.equal(engine.view().signals.scan.phase, "not_selected");
    f.records.set(credentialsFile, {
      groww: { access_token: "test", user: "IND123", day },
    });
    await engine.select("groww");
    assert.equal(engine.view().signals.scan.phase, "not_configured");
    await engine.refresh();
    assert.equal(engine.view().configured, false);
    assert.equal(
      historyReads,
      0,
      "a connection alone must not start scanning the default watchlist",
    );
    await engine.configure(settings);
    assert.equal(engine.view().signals.scan.phase, "idle");
    assert.doesNotMatch(engine.view().signals.message, /Preparing|Loading/);
    unavailable = true;
    const beforeFailure = updates;
    await assert.rejects(engine.refresh(), /Insufficient permission/);
    assert.equal(
      updates,
      beforeFailure + 1,
      "broker errors must notify the open settings and trading screens",
    );
    assert.equal(engine.view().signals.scan.phase, "error");
    assert.match(engine.view().signals.message, /Broker refresh failed/);
    assert.equal(historyReads, 0);
  } finally {
    engine.close();
    restore();
  }
});

test("India buys use whole shares, saved INR reserve, completed signals, risk and entry cutoffs", () => {
  const f = fixture();
  try {
    const action = indiaActions(f.data, f.signals, settings, {}, [], now)[0];
    assert.equal(action.action, "BUY", action.reason);
    assert.ok(Number.isSafeInteger(action.quantity) && action.quantity > 0);
    assert.ok(action.quantity * action.price * 1.01 <= 45000);
    assert.ok(action.planned_risk_inr <= 250);
    assert.equal(
      indiaActions(
        f.data,
        { ...f.signals, fresh: false },
        settings,
        {},
        [],
        now,
      )[0].enabled,
      false,
    );
    assert.equal(
      indiaActions(
        f.data,
        f.signals,
        { ...settings, budget: 1 },
        {},
        [],
        now,
      )[0].enabled,
      false,
    );
    assert.match(
      indiaActions(
        {
          ...f.data,
          updated_at: new Date(hours[1] - 25 * 60000).toISOString(),
        },
        f.signals,
        settings,
        {},
        [],
        hours[1] - 25 * 60000,
      )[0].reason,
      /entry window/,
    );
    assert.match(
      indiaActions(f.data, f.signals, settings, { halted: true }, [], now)[0]
        .reason,
      /loss limit/,
    );
  } finally {
    restore();
  }
});

test("risk exits work without entry signals and sell only managed shares, including cancelled partial fills", () => {
  const f = fixture();
  const tickets = [
    {
      id: "own",
      symbol: "INFY",
      side: "buy",
      quantity: 5,
      filled_quantity: 2,
      status: "cancelled",
      submitted_at: new Date(now - 600000).toISOString(),
      price: 103,
      initial_stop: 100,
      target: 109,
    },
  ];
  f.data.positions = [
    { symbol: "INFY", quantity: 7, average_price: 103, realised_pnl: 0 },
  ];
  try {
    const actions = indiaActions(
      f.data,
      { ...f.signals, ranked: [], fresh: false },
      settings,
      { halted: true },
      tickets,
      now,
    );
    assert.equal(actions[0].action, "EXIT");
    assert.equal(actions[0].quantity, 2);
    assert.equal(
      managedShares(
        [...tickets, { symbol: "INFY", side: "sell", filled_quantity: 1 }],
        "INFY",
      ),
      1,
    );
    const external = indiaActions(
      f.data,
      f.signals,
      settings,
      { halted: true },
      [],
      now,
    )[0];
    assert.equal(external.enabled, false);
    assert.match(external.reason, /External position/);
    const late = hours[1] - 20 * 60000;
    f.data.updated_at = new Date(late).toISOString();
    f.data.quotes.INFY.venue_last_trade_time = f.data.updated_at;
    assert.match(
      indiaActions(f.data, f.signals, settings, {}, tickets, late)[0].reason,
      /Scheduled exit/,
    );
    const blocked = indiaActions(
      f.data,
      f.signals,
      settings,
      {},
      [...tickets, { status: "unknown", symbol: "INFY" }],
      late,
    )[0];
    assert.equal(blocked.enabled, false);
    assert.match(blocked.reason, /unresolved/);
  } finally {
    restore();
  }
});

async function workflow(outcome = "filled") {
  const f = fixture();
  let placements = 0,
    cancellations = 0;
  const engine = new IndiaTrading(() => {}, {
    history,
    snapshot: async () => {
      const data = structuredClone(f.data);
      data.updated_at = new Date(Date.now()).toISOString();
      for (const q of Object.values(data.quotes))
        q.venue_last_trade_time = data.updated_at;
      return data;
    },
    place: async (_broker, ticket, reference) => {
      placements++;
      if (outcome === "timeout") throw new Error("Timed out after send");
      if (outcome === "rejected")
        throw new IndiaBrokerError("Static IP rejected", 403);
      const id = `order-${placements}`;
      f.data.orders.push({
        id,
        reference,
        symbol: ticket.symbol,
        side: ticket.side,
        quantity: ticket.quantity,
        filled_quantity: outcome === "filled" ? ticket.quantity : 0,
        state: outcome,
        exchange: "NSE",
        intraday: true,
      });
      if (outcome === "filled") {
        if (ticket.side === "buy") {
          f.data.positions = [
            {
              symbol: "INFY",
              quantity: ticket.quantity,
              average_price: ticket.price,
              realised_pnl: 0,
              pnl: 0,
            },
          ];
          f.data.cash -= ticket.quantity * ticket.price;
        } else {
          f.data.positions = [];
          f.data.cash += ticket.quantity * ticket.price;
        }
      }
      return id;
    },
    cancel: async () => {
      cancellations++;
      f.data.orders.at(-1)!.state = "cancelled";
    },
  });
  await engine.select("groww");
  await engine.configure(settings);
  mock.method((engine as any).feed, "snapshot", () => f.signals);
  mock.method((engine as any).feed, "refresh", async () => f.signals);
  return {
    ...f,
    engine,
    placements: () => placements,
    cancellations: () => cancellations,
  };
}

test("manual India orders require a current server preview and explicit confirmation and cannot be sent twice", async () => {
  const f = await workflow();
  try {
    const ticket = await f.engine.preview("INFY", "buy");
    assert.equal(f.placements(), 0);
    await assert.rejects(f.engine.confirm(ticket.id, false), /confirmation/);
    await f.engine.confirm(ticket.id, true);
    await f.engine.refresh();
    assert.equal(f.placements(), 1);
    assert.equal(f.engine.view().tickets[0].status, "filled");
    await assert.rejects(
      f.engine.confirm(ticket.id, true),
      /already submitted/,
    );
    assert.equal(f.placements(), 1);
    const view = f.engine.view();
    assert.ok(!JSON.stringify(view).includes("IND123"));
    assert.equal(view.snapshot.user, "••••D123");
  } finally {
    f.engine.close();
    restore();
  }
});

test("India automatic trading needs its own consent and stops entries while handling a daily-loss exit", async () => {
  const f = await workflow();
  try {
    await assert.rejects(f.engine.setAuto(true, false), /consent/);
    await f.engine.setAuto(true, true);
    await f.engine.tick();
    assert.equal(f.placements(), 1);
    await f.engine.tick();
    assert.equal(f.placements(), 1, "filled entry must not repeat");
    assert.equal(f.engine.view().tickets[0].status, "filled");
    await assert.rejects(f.engine.select("upstox"), /Pause India/);
    await assert.rejects(f.engine.preview("INFY", "buy"), /Pause India/);
    f.signals.fresh = false;
    f.data.positions[0].pnl = -1100;
    await f.engine.tick();
    assert.equal(f.placements(), 2);
    await f.engine.tick();
    assert.equal(f.engine.view().tickets[0].side, "sell");
    assert.equal(f.engine.view().tickets[0].status, "filled");
    f.data.positions = [
      {
        symbol: "INFY",
        quantity: 0,
        average_price: 0,
        pnl: 0,
        realised_pnl: 0,
      },
    ];
    f.signals.fresh = true;
    await f.engine.refresh();
    assert.ok(f.engine.view().actions.every((a: Row) => !a.enabled));
    assert.equal(
      f.placements(),
      2,
      "a recovered P&L must not reset the daily halt",
    );
  } finally {
    f.engine.close();
    restore();
  }
});

test("unknown India placements survive restart, block new sends and reconcile only to the exact broker reference", async () => {
  const f = await workflow("timeout");
  try {
    await f.engine.setAuto(true, true);
    await f.engine.tick();
    const ticket = f.engine.view().tickets[0];
    assert.equal(ticket.status, "unknown");
    assert.equal(f.engine.enabled, false);
    await f.engine.tick();
    assert.equal(f.placements(), 1);
    const restarted = new IndiaTrading();
    assert.equal(restarted.view().tickets[0].status, "unknown");
    await assert.rejects(f.engine.setAuto(true, true), /Reconcile pending/);
    f.data.orders.push({
      id: "receipt",
      reference: "similar-ref",
      symbol: "INFY",
      side: "buy",
      quantity: ticket.quantity,
      filled_quantity: ticket.quantity,
      state: "filled",
      exchange: "NSE",
      intraday: true,
    });
    await f.engine.refresh();
    assert.equal(f.engine.view().tickets[0].status, "unknown");
    f.data.orders[0].reference = ticket.reference;
    await f.engine.refresh();
    assert.equal(f.engine.view().tickets[0].status, "filled");
    assert.equal(
      f.engine.enabled,
      false,
      "reconciliation must not authorize a new session",
    );
    assert.equal(f.placements(), 1);
  } finally {
    f.engine.close();
    restore();
  }
});

test("a broker-rejected India order pauses for review without leaving a false unknown placement", async () => {
  const f = await workflow("rejected");
  try {
    await f.engine.setAuto(true, true);
    await f.engine.tick();
    assert.equal(f.engine.view().tickets[0].status, "rejected");
    assert.equal(f.engine.enabled, false);
    assert.equal(f.engine.hasPending, false);
    await f.engine.tick();
    assert.equal(f.placements(), 1);
  } finally {
    f.engine.close();
    restore();
  }
});

test("pending India buys can be cancelled and cannot finance or duplicate new entries", async () => {
  const f = await workflow("pending");
  try {
    await f.engine.setAuto(true, true);
    await f.engine.tick();
    await f.engine.tick();
    assert.equal(f.placements(), 1);
    const ticket = f.engine.view().tickets[0];
    await assert.rejects(f.engine.cancel(ticket.id, false), /Confirm/);
    await f.engine.cancel(ticket.id, true);
    await f.engine.refresh();
    assert.equal(f.cancellations(), 1);
    assert.equal(f.engine.view().tickets[0].status, "cancelled");
    assert.equal(f.engine.enabled, false);
  } finally {
    f.engine.close();
    restore();
  }
});

test("an automatically cancelled partial buy keeps protection running for its filled shares", async () => {
  const f = await workflow("pending");
  try {
    await f.engine.setAuto(true, true);
    await f.engine.tick();
    f.data.orders[0].filled_quantity = 2;
    f.data.positions = [
      {
        symbol: "INFY",
        quantity: 2,
        average_price: 103,
        realised_pnl: 0,
        pnl: 0,
      },
    ];
    mock.timers.setTime(now + 61000);
    await f.engine.tick();
    assert.equal(f.cancellations(), 1);
    await f.engine.tick();
    assert.equal(
      f.engine.enabled,
      true,
      "automatic cancellation must keep partial-fill stops active",
    );
    f.data.quotes.INFY.last_trade_price = 98;
    await f.engine.tick();
    const sale = f.engine.view().tickets[0];
    assert.equal(sale.side, "sell");
    assert.equal(sale.quantity, 2);
    assert.equal(f.placements(), 2);
  } finally {
    f.engine.close();
    restore();
  }
});

test("revoking India consent during final broker checks prevents placement", async () => {
  const f = await workflow();
  try {
    await f.engine.setAuto(true, true);
    const sources = (f.engine as any).sources;
    const original = sources.snapshot;
    let reads = 0;
    mock.method(sources, "snapshot", async (...args: unknown[]) => {
      const result = await original(...args);
      if (++reads === 2) f.engine.stop();
      return result;
    });
    await f.engine.tick();
    assert.equal(f.engine.enabled, false);
    assert.equal(f.placements(), 0);
    assert.equal(f.engine.view().tickets[0].status, "not_submitted");
  } finally {
    f.engine.close();
    restore();
  }
});

test("a broker account change cannot inherit India settings or live consent", async () => {
  const f = await workflow();
  try {
    await f.engine.setAuto(true, true);
    const originalScope = f.engine.view().scope;
    f.data.user = "OTHER";
    await f.engine.tick();
    assert.equal(f.engine.enabled, false);
    assert.equal(f.placements(), 0);
    assert.equal(f.engine.view().scope, originalScope);
    assert.match(f.engine.view().error, /account changed/);
    await f.engine.refresh();
    assert.notEqual(f.engine.view().scope, originalScope);
    await assert.rejects(f.engine.setAuto(true, true), /Save the India budget/);
  } finally {
    f.engine.close();
    restore();
  }
});

test("expired previews stay unsent, settings remain account-scoped and graceful shutdown revokes India consent", async () => {
  const f = await workflow();
  try {
    const ticket = await f.engine.preview("INFY", "buy");
    mock.timers.setTime(now + 17 * 60000);
    await f.engine.confirm(ticket.id, true);
    assert.equal(f.engine.view().tickets[0].status, "superseded");
    assert.equal(f.placements(), 0);
    mock.timers.setTime(now);
    await f.engine.setAuto(true, true);
    f.engine.close();
    const restarted = new IndiaTrading();
    assert.equal(restarted.enabled, false);
    const saved = f.records.get(indiaTradingFile)!;
    assert.equal(
      saved.accounts[saved.current.groww].settings.budget,
      settings.budget,
    );
    await restarted.select("upstox");
    assert.equal(restarted.view().tickets.length, 0);
  } finally {
    restore();
  }
});

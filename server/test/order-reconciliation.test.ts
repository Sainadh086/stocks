import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";
import {
  ticketsFile,
  recoveryOrders,
  linkOrder,
  type connected,
} from "../src/brokers/robinhood.js";
import { ticketPending } from "../src/trading/live.js";
import { tradingProgress } from "../src/trading/progress.js";

function fixture() {
  const records = new Map<string, Row>([
    [rolesFile, { trading: "TRADE", long_term: "LONG" }],
    [ticketsFile, {}],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  let orders: Row[] = [];
  let orderReads = 0;
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
        if (name === "get_portfolio")
          return { currency: "USD", total_value: 1000 };
        assert.fail(`Unexpected broker operation: ${name}`);
      },
      async rows(name) {
        if (name === "get_equity_orders") {
          orderReads++;
          return structuredClone(orders);
        }
        assert.equal(name, "get_equity_positions");
        return [];
      },
    });
  const service = new Service(false, { comparisons: {}, batch: null }, broker);
  mock.method((service as any).feed, "refresh", async () => ({}));
  return {
    service,
    broker,
    records,
    setOrders: (value: Row[]) => {
      orders = value;
    },
    reads: () => orderReads,
  };
}

test("checking order status fetches history once and refreshes the blocked decision", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 25; i++)
      f.records.get(ticketsFile)![`ticket-${i}`] = {
        id: `ticket-${i}`,
        status: "unknown",
        reviewed_at: new Date().toISOString(),
        arguments: {
          account_number: "TRADE",
          symbol: `A${i}`,
          side: "sell",
          quantity: "1",
        },
      };
    await f.service.refreshLive();
    assert.match(f.service.liveView().model.message, /unresolved/);
    f.setOrders(
      Array.from({ length: 25 }, (_, i) => ({
        id: `order-${i}`,
        ref_id: `ticket-${i}`,
        state: "filled",
      })),
    );
    const before = f.reads();
    const view = await f.service.reconcileLive();
    assert.equal(f.reads() - before, 1);
    assert.doesNotMatch(view.model.message, /unresolved/);
    assert.ok(
      view.tickets.every(
        (t: Row) =>
          t.status === "submitted" && t.result.order.state === "filled",
      ),
    );
  } finally {
    mock.restoreAll();
  }
});

function unmatched() {
  const ticket = {
    id: "ticket",
    status: "unknown",
    reviewed_at: "2026-10-26T18:22:40.123Z",
    arguments: {
      account_number: "TRADE",
      symbol: "TSLA",
      side: "sell",
      type: "market",
      quantity: "0.107717",
    },
    error: "Placement timed out",
  };
  const order = {
    id: "receipt",
    ref_id: "different-reference",
    symbol: "TSLA",
    side: "sell",
    type: "market",
    quantity: "0.10771700",
    state: "filled",
    created_at: "2026-10-26T18:22:43.011Z",
  };
  return { ticket, order };
}

test("a matching fill is a suggestion until explicitly confirmed against fresh broker data", async () => {
  const f = fixture();
  const { ticket, order } = unmatched();
  f.records.get(ticketsFile)!.ticket = ticket;
  f.setOrders([order]);
  try {
    await f.service.reconcileLive();
    const view = f.service.liveView();
    assert.equal(
      view.tickets[0].status,
      "unknown",
      "Never link similar trades automatically",
    );
    assert.equal(view.tickets[0].recovery_orders[0].id, order.id);
    await assert.rejects(
      f.service.linkLiveOrder(ticket.id, order.id, false),
      /Confirm/,
    );
    assert.equal(f.records.get(ticketsFile)!.ticket.status, "unknown");
    const result = await f.service.linkLiveOrder(ticket.id, order.id, true);
    assert.doesNotMatch(result.model.message, /unresolved/);
    const saved = f.records.get(ticketsFile)!.ticket;
    assert.equal(saved.status, "submitted");
    assert.equal(saved.result.order.id, order.id);
    assert.equal(saved.result.order.state, "filled");
    assert.equal(saved.error, undefined);
    assert.equal(saved.reconciliation.previous_error, "Placement timed out");
    assert.equal(ticketPending(saved, []), false);
    await assert.rejects(
      f.service.linkLiveOrder(ticket.id, order.id, true),
      /no longer matches/,
    );
  } finally {
    mock.restoreAll();
  }
});

test("receipt linking refuses mismatches, reused receipts and fills that changed after review", async () => {
  const f = fixture();
  const { ticket, order } = unmatched();
  f.records.get(ticketsFile)!.ticket = ticket;
  try {
    for (const change of [
      { symbol: "OTHER" },
      { side: "buy" },
      { type: "limit" },
      { account_number: "OTHER" },
      { quantity: "0.107718" },
      { quantity: "invalid" },
      { quantity: "NaN" },
      { state: "queued" },
      { created_at: "invalid" },
      { created_at: "2026-10-26T18:22:39Z" },
      { created_at: "2026-10-26T18:26:11Z" },
      { id: "" },
    ]) {
      f.setOrders([{ ...order, ...change }]);
      await assert.rejects(
        linkOrder(ticket.id, order.id, true, f.broker),
        /no longer matches/,
      );
      assert.equal(f.records.get(ticketsFile)!.ticket.status, "unknown");
    }
    f.setOrders([order]);
    f.records.get(ticketsFile)!.other = {
      id: "other",
      result: { order },
      arguments: { account_number: "TRADE" },
    };
    await assert.rejects(
      linkOrder(ticket.id, order.id, true, f.broker),
      /already linked/,
    );
    f.records.set(rolesFile, { trading: "OTHER", long_term: "LONG" });
    await assert.rejects(
      linkOrder(ticket.id, order.id, true, f.broker),
      /daily trading account/,
    );
  } finally {
    mock.restoreAll();
  }
});

test("recovery requires the sent amount and time, and cannot replace a known broker ID", () => {
  const { ticket, order } = unmatched();
  assert.equal(
    recoveryOrders(
      { ...ticket, submitted_at: "2026-10-26T18:22:40.123Z" },
      [{ ...order, created_at: "2026-10-26T18:24:11Z" }],
      [ticket],
    ).length,
    0,
  );
  assert.equal(
    recoveryOrders(
      { ...ticket, result: { order: { id: "known-order" } } },
      [order],
      [ticket],
    ).length,
    0,
  );
  const buy = {
    ...ticket,
    arguments: { ...ticket.arguments, side: "buy", dollar_amount: "10.00" },
  };
  assert.equal(
    recoveryOrders(buy, [{ ...order, side: "buy" }], [buy]).length,
    0,
  );
  assert.equal(
    recoveryOrders(buy, [{ ...order, side: "buy", dollar_amount: "10" }], [buy])
      .length,
    1,
  );
});

test("missing order IDs cannot match unrelated filled orders", () => {
  assert.equal(
    ticketPending({ id: "ticket", status: "submitted", result: {} }, [
      { state: "filled", ref_id: "unrelated" },
    ]),
    true,
  );
});

for (const state of [
  "rejected",
  "failed",
  "cancelled",
  "canceled",
  "expired",
  "voided",
]) {
  test(`a pending batch stops when its broker order becomes ${state}`, async () => {
    const f = fixture();
    try {
      f.records.get(ticketsFile)!.ticket = {
        id: "ticket",
        status: "submitted",
        arguments: { account_number: "TRADE" },
        result: { order: { id: "order", state: "queued" } },
      };
      f.setOrders([{ id: "order", state }]);
      const batch = {
        id: "batch",
        account: "TRADE",
        status: "waiting_sales",
        ordered_ids: ["ticket", "unsent"],
        results: [
          { id: "ticket", side: "sell", symbol: "A", status: "pending" },
        ],
      };
      await (f.service as any).advance(batch);
      assert.equal(batch.status, "stopped");
    } finally {
      mock.restoreAll();
    }
  });
}

test("an unresolved order is visible even while signals are loading", () => {
  const result = tradingProgress(
    {
      strategy: "orb_15m_v1",
      fresh: false,
      ranked: [],
      bars: {},
      asof: null,
      message: "Loading prices",
      scan: { phase: "loading_history", completed: 0, total: 100 },
    },
    null,
    null,
    { enabled: true },
    null,
    [
      {
        id: "ticket",
        status: "unknown",
        arguments: { symbol: "TSLA", side: "sell" },
      },
    ],
    null,
  );
  assert.equal(result.stage, "Needs attention");
  assert.match(result.message, /TSLA.*order status/i);
});

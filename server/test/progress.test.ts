import test from "node:test";
import assert from "node:assert/strict";
import { tradingProgress } from "../src/trading/progress.js";
import { Feed, type Signals } from "../src/trading/live.js";
import { session } from "../src/shared/calendar.js";
import type { History } from "../src/shared/prices.js";
const day = "2026-10-12",
  now = session(day)![0] + 1230000;
const signals: Signals = {
  strategy: "orb_15m_v1",
  ranked: [],
  bars: {},
  asof: null,
  fresh: false,
  message: "Loading opening-range history (5/20 stocks)…",
  scan: { phase: "loading_history", completed: 5, total: 20 },
};
test("progress remains visible without a brokerage snapshot or strategy model", () => {
  const p = tradingProgress(
    signals,
    null,
    null,
    { enabled: true },
    null,
    [],
    null,
    now,
  );
  assert.equal(p.stage, "Scanning stocks");
  assert.equal(p.scan.completed, 5);
  assert.equal(p.last_check, null);
  assert.equal(p.total, 0);
  const closed = tradingProgress(
    signals,
    null,
    null,
    { enabled: true },
    null,
    [],
    null,
    session(day)![1],
  );
  assert.equal(closed.stage, "Market closed");
  const ready = tradingProgress(
    {
      ...signals,
      fresh: true,
      scan: { phase: "ready", completed: 20, total: 20 },
    },
    { updated_at: new Date(now).toISOString() },
    { actions: [] },
    { enabled: true },
    null,
    [],
    null,
    now,
  );
  assert.equal(ready.stage, "No qualifying candidates");
});
test("rebalance progress counts confirmed fills, pending orders and all unsent tickets", () => {
  const tickets = ["one", "two", "three"].map((id) => ({
    id,
    status: "preview",
    arguments: {
      symbol: id,
      side: id === "three" ? "buy" : "sell",
      quantity: "2",
    },
  }));
  const batch = {
    status: "waiting_sales",
    progress: "Waiting for two to fill…",
    ticket_ids: ["one", "two", "three"],
    results: [
      { id: "one", status: "filled", broker_state: "filled" },
      { id: "two", status: "pending", broker_state: "partially_filled" },
    ],
  };
  const p = tradingProgress(
    signals,
    null,
    null,
    { enabled: true },
    batch,
    tickets,
    null,
    now,
  );
  assert.equal(p.message, batch.progress);
  assert.equal(p.total, 3);
  assert.equal(p.filled, 1);
  assert.equal(p.pending, 1);
  assert.equal(p.unsent, 1);
  assert.equal(p.orders[2].symbol, "three");
  assert.equal(p.orders[2].status, "queued");
  const stopped = tradingProgress(
    signals,
    null,
    null,
    { enabled: false },
    { ...batch, status: "stopped", error: "Order needs review" },
    tickets,
    null,
    now,
  );
  assert.equal(stopped.message, "Order needs review");
  assert.equal(stopped.orders[2].reason, "Not sent; rebalance stopped");
});

test("reconciled broker receipts override stale pending batch progress", () => {
  for (const state of ["filled", "canceled", "expired", "voided"]) {
    const result = tradingProgress(
      signals,
      null,
      null,
      { enabled: false },
      {
        status: "stopped",
        ticket_ids: ["ticket"],
        results: [{ id: "ticket", status: "pending", broker_state: "queued" }],
      },
      [
        {
          id: "ticket",
          status: "submitted",
          result: { order: { state } },
          arguments: { symbol: "A", side: "sell" },
        },
      ],
      null,
      now,
    );
    assert.equal(result.orders[0].broker_state, state);
    assert.equal(result.orders[0].status, state);
    assert.equal(result.pending, 0);
    assert.equal(result.filled, state === "filled" ? 1 : 0);
    assert.equal(result.orders[0].reason, null);
  }
});
test("feed publishes incremental history scan progress while loading is in flight", async () => {
  const waiting = new Map<string, (frame: History) => void>();
  const frame: History = {
    source: "fixture",
    adjustment: "none",
    bars: [
      {
        time: now - 30000,
        date: day,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      },
    ],
  };
  const feed = new Feed({
    now: () => now,
    universe: async () => ["A", "B"],
    history: async (symbol, period) =>
      period === "60d"
        ? new Promise<History>((resolve) => waiting.set(symbol, resolve))
        : frame,
  });
  const loading = feed.refresh([], now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feed.snapshot(now).scan?.total, 2);
  assert.equal(feed.snapshot(now).scan?.phase, "loading_history");
  waiting.get("A")!(frame);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feed.snapshot(now).scan?.completed, 1);
  waiting.get("B")!(frame);
  const done = await loading;
  assert.equal(done.scan?.phase, "ready");
  assert.equal(done.scan?.completed, 2);
});

test("waiting monitor explains the actual entry blockers instead of reporting healthy refreshes", () => {
  const p = tradingProgress(
    {
      ...signals,
      fresh: true,
      ranked: [{ symbol: "A" }],
      scan: { phase: "ready", completed: 1, total: 1 },
    },
    { updated_at: new Date(now).toISOString() },
    {
      message: "Monitoring intraday breakouts",
      actions: [
        {
          symbol: "A",
          enabled: false,
          reason: "Waiting for a completed close above the opening range.",
        },
      ],
    },
    { enabled: true },
    null,
    [],
    null,
    now,
  );
  assert.equal(p.stage, "Waiting for eligible trades");
  assert.equal(
    p.message,
    "A: Waiting for a completed close above the opening range.",
  );
});

test("an old stopped rebalance cannot replace the current market status", () => {
  const p = tradingProgress(
    signals,
    null,
    null,
    { enabled: false },
    {
      status: "stopped",
      error: "Old validation failure",
      confirmed_at: "2026-10-09T15:00:00.000Z",
    },
    [],
    null,
    session(day)![1],
  );
  assert.equal(p.stage, "Market closed");
  assert.doesNotMatch(p.message, /Old validation/);
});

test("a failed initial history scan is retried instead of leaving an empty daily universe", async () => {
  let reads = 0;
  const feed = new Feed({
    now: () => now,
    universe: async (market) => {
      assert.equal(market, "US");
      return ["A"];
    },
    history: async () => {
      reads++;
      throw new Error("history unavailable");
    },
  });
  await feed.refresh([], now);
  assert.equal(feed.snapshot(now).fresh, false);
  assert.match(feed.snapshot(now).message, /will be retried/);
  await feed.refresh([], now);
  assert.equal(reads, 2);
});

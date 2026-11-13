import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import {
  learningFile,
  learningBucket,
  learningState,
  rememberLearning,
  recordLearningOrders,
  learningView,
  learningEpisodes,
  trainSelection,
  learningAdvisor,
  attributeLearning,
  type LearningContext,
} from "../src/learning.js";

const ctx: LearningContext = {
    market: "US",
    horizon: "long_term",
    broker: "robinhood",
    scope: "account-one",
  },
  start = Date.parse("2026-01-01T12:00:00Z"),
  features = { return_3m_pct: 10, volatility_6m_pct: 20, rsi: 55 };
function setup() {
  const saved = new Map<string, Row>();
  let writes = 0;
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) => {
    saved.set(path, structuredClone(value));
    writes++;
  });
  return { saved, writes: () => writes };
}
function order(
  id: string,
  side: string,
  quantity: number,
  price: number,
  time: number,
  extra: Row = {},
): Row {
  return {
    id,
    symbol: "TEST",
    side,
    state: "filled",
    quantity,
    average_price: price,
    filled_at: new Date(time).toISOString(),
    fees: 0,
    ...extra,
  };
}
test("order journal deduplicates snapshots, preserves revisions and rewards only complete position cycles", () => {
  const f = setup();
  try {
    rememberLearning(ctx, "gems", [{ symbol: "TEST", ...features }], start);
    const buy = order("b", "buy", 10, 100, start + 1000),
      sell = order("s", "sell", 10, 110, start + 86400000),
      tickets = [
        { order_id: "b", strategy: "gems", reason: "Current Gems selection" },
      ];
    recordLearningOrders(ctx, [buy], tickets, start + 2000);
    assert.equal(learningView(learningBucket(ctx)).episodes.length, 0);
    const before = f.writes();
    recordLearningOrders(ctx, [buy], tickets, start + 3000);
    assert.equal(f.writes(), before);
    recordLearningOrders(ctx, [buy, sell], tickets, start + 86401000);
    const view = learningView(learningBucket(ctx));
    assert.equal(view.orders.length, 2);
    assert.equal(view.episodes.length, 1);
    assert.equal(view.episodes[0].net_pnl, 100);
    assert.equal(view.episodes[0].eligible, true);
    assert.equal(
      view.orders.find((o: Row) => o.side === "buy").revisions.length,
      1,
    );
    assert.equal(
      f.saved.get(learningFile)!.policies[learningBucket(ctx)].ready,
      false,
    );
  } finally {
    mock.restoreAll();
  }
});
test("partial fills, canceled remainders and stale broker responses never invent fills or independent samples", () => {
  setup();
  try {
    rememberLearning(ctx, "gems", [{ symbol: "TEST", ...features }], start);
    const ticket = [{ order_id: "b", strategy: "gems" }];
    recordLearningOrders(
      ctx,
      [
        order("b", "buy", 10, 100, start + 1000, {
          state: "pending",
          filled_quantity: 2,
        }),
      ],
      ticket,
      start + 2000,
    );
    recordLearningOrders(
      ctx,
      [
        order("b", "buy", 10, 101, start + 1000, {
          state: "cancelled",
          filled_quantity: 4,
        }),
      ],
      ticket,
      start + 3000,
    );
    recordLearningOrders(
      ctx,
      [
        order("b", "buy", 10, 90, start + 1000, {
          state: "pending",
          filled_quantity: 2,
        }),
      ],
      ticket,
      start + 4000,
    );
    recordLearningOrders(
      ctx,
      [order("s", "sell", 4, 105, start + 10000)],
      [],
      start + 11000,
    );
    const view = learningView(learningBucket(ctx)),
      buy = view.orders.find((o: Row) => o.side === "buy");
    assert.equal(buy.quantity, 4);
    assert.equal(buy.price, 101);
    assert.equal(buy.status, "cancelled");
    assert.equal(buy.revisions.length, 2);
    assert.equal(view.episodes[0].eligible, false);
    assert.equal(view.episodes[0].net_pnl, 16);
  } finally {
    mock.restoreAll();
  }
});
test("top-ups and partial exits form one completed position cycle and accounts stay separate", () => {
  setup();
  try {
    rememberLearning(ctx, "gems", [{ symbol: "TEST", ...features }], start);
    const buys = [
        order("b1", "buy", 2, 100, start + 1000),
        order("b2", "buy", 3, 110, start + 2000),
      ],
      tickets = buys.map((o) => ({ order_id: o.id, strategy: "gems" }));
    recordLearningOrders(
      ctx,
      [...buys, order("s1", "sell", 2, 120, start + 5000)],
      tickets,
      start + 6000,
    );
    assert.equal(learningView(learningBucket(ctx)).episodes.length, 0);
    recordLearningOrders(
      ctx,
      [order("s2", "sell", 3, 120, start + 7000)],
      [],
      start + 8000,
    );
    const view = learningView(learningBucket(ctx));
    assert.equal(view.episodes.length, 1);
    assert.equal(view.episodes[0].net_pnl, 70);
    recordLearningOrders(
      { ...ctx, scope: "another" },
      [buys[0]],
      [],
      start + 9000,
    );
    assert.equal(learningView(learningBucket(ctx)).orders.length, 4);
    assert.equal(
      learningView(learningBucket({ ...ctx, scope: "another" })).orders.length,
      1,
    );
  } finally {
    mock.restoreAll();
  }
});
test("reasoning attribution cannot create pre-entry evidence using later observations", () => {
  setup();
  try {
    recordLearningOrders(
      ctx,
      [
        order("b", "buy", 1, 100, start),
        order("s", "sell", 1, 101, start + 10000),
      ],
      [],
      start + 11000,
    );
    rememberLearning(
      ctx,
      "gems",
      [{ symbol: "TEST", ...features }],
      start + 12000,
    );
    const view = learningView(learningBucket(ctx));
    const updated = attributeLearning(
      view.orders.find((o: Row) => o.side === "buy").key,
      "gems",
      "Documented historical investment reasoning",
    );
    assert.equal(updated.episodes[0].eligible, false);
    assert.equal(updated.episodes[0].state, null);
    const orphan = learningEpisodes(
      [
        {
          key: "s",
          side: "sell",
          symbol: "UNKNOWN",
          quantity: 2,
          price: 10,
          fees: 0,
          filled_at: new Date(start).toISOString(),
        },
      ],
      ctx,
    );
    assert.equal(orphan.episodes.length, 0);
    assert.equal(orphan.unmatched, 1);
  } finally {
    mock.restoreAll();
  }
});
function episodes(): Row[] {
  return Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    source: "broker",
    eligible: true,
    strategy: "gems",
    state: i % 2 ? "down/volatile/weak" : learningState(features),
    entry_time: new Date(start + i * 86400000).toISOString(),
    exit_time: new Date(start + i * 86400000 + 3600000).toISOString(),
    net_return_pct: i % 2 ? -2 : 2,
    double_cost_return_pct: i % 2 ? -3 : 1,
  }));
}
test("Q-learning isolates later outcomes, purges overlapping trades, and activates bounded rankings only after measured improvement", () => {
  const e = episodes(),
    at = start + 60 * 86400000,
    first = trainSelection(e, at),
    changed = structuredClone(e);
  for (const row of changed.slice(35)) row.net_return_pct = 999;
  const second = trainSelection(changed, at);
  assert.deepEqual(first.table, second.table);
  assert.equal(first.ready, true);
  assert.equal(first.validated, true);
  assert.ok(first.double_cost_mean_return_pct > 0);
  const overlap = structuredClone(e);
  for (const row of overlap.slice(0, 35))
    row.exit_time = new Date(start + 40 * 86400000).toISOString();
  assert.ok(trainSelection(overlap, at).train_episodes < first.train_episodes);
  const f = setup();
  try {
    f.saved.set(learningFile, {
      contexts: {},
      orders: {},
      observations: {},
      policies: { [learningBucket(ctx)]: first },
    });
    const recommend = learningAdvisor(ctx, "gems", at);
    assert.ok(recommend(features).learning_adjustment > 0);
    assert.ok(recommend(features).learning_adjustment <= 5);
    assert.equal(
      recommend({ return_3m_pct: 0, volatility_6m_pct: 10, rsi: 80 })
        .learning_adjustment,
      0,
    );
    first.validated = false;
    f.saved.get(learningFile)!.policies[learningBucket(ctx)] = first;
    assert.equal(
      learningAdvisor(ctx, "gems", at)(features).learning_adjustment,
      0,
    );
    assert.equal(trainSelection(e.slice(0, 5), at).ready, false);
  } finally {
    mock.restoreAll();
  }
});

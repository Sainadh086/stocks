import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  readSnapshot,
  type BrokerSession,
  McpConnectionError,
  BrokerError,
  recoverableReadError,
  type connected,
} from "../src/brokers/robinhood.js";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";

test("only temporary read failures recover automatically; order rejection and permission failures require attention", () => {
  assert.equal(
    recoverableReadError(new BrokerError("API error 429", "get_portfolio")),
    true,
  );
  assert.equal(
    recoverableReadError(new BrokerError("API error 503", "get_equity_quotes")),
    true,
  );
  assert.equal(
    recoverableReadError(new BrokerError("API error 403", "get_accounts")),
    false,
  );
  assert.equal(
    recoverableReadError(
      new BrokerError("API error 503", "place_equity_order"),
    ),
    false,
  );
});

test("quotes begin as soon as holdings arrive, while slow account reads are still running", async () => {
  let finishPortfolio!: (value: Row) => void,
    finishOrders!: (value: Row[]) => void,
    quoteStarted!: () => void;
  const portfolio = new Promise<Row>((resolve) => {
    finishPortfolio = resolve;
  });
  const orders = new Promise<Row[]>((resolve) => {
    finishOrders = resolve;
  });
  const quoted = new Promise<void>((resolve) => {
    quoteStarted = resolve;
  });
  const broker: BrokerSession = {
    async call(name, args) {
      if (name === "get_portfolio") return portfolio;
      assert.equal(name, "get_equity_quotes");
      assert.deepEqual(args.symbols, ["WATCH", "HELD"]);
      quoteStarted();
      return {
        results: args.symbols.map((symbol: string) => ({
          quote: { symbol, last_trade_price: "10" },
        })),
      };
    },
    async rows(name) {
      return name === "get_equity_positions" ? [{ symbol: "HELD" }] : orders;
    },
  };
  const pending = readSnapshot(broker, "TEST", ["WATCH", "HELD", "WATCH"]);
  await quoted;
  finishPortfolio({ total_value: "100" });
  finishOrders([]);
  const snapshot = await pending;
  assert.deepEqual(Object.keys(snapshot.quotes), ["WATCH", "HELD"]);
  assert.ok(snapshot.fetch_duration_ms >= 0);
});

test("quote batches stay bounded to two requests of at most 20 symbols", async () => {
  let active = 0,
    peak = 0,
    requests = 0;
  const broker: BrokerSession = {
    async call(name, args) {
      if (name === "get_portfolio") return {};
      assert.equal(name, "get_equity_quotes");
      assert.ok(args.symbols.length <= 20);
      requests++;
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return {
        results: args.symbols.map((symbol: string) => ({ quote: { symbol } })),
      };
    },
    async rows() {
      return [];
    },
  };
  const result = await readSnapshot(
    broker,
    "TEST",
    Array.from({ length: 45 }, (_, i) => `S${i}`),
  );
  assert.equal(Object.keys(result.quotes).length, 45);
  assert.equal(requests, 3);
  assert.equal(peak, 2);
});

test("broker polling has no overlapping workflow and backs off after a read outage", async () => {
  const now = Date.UTC(2026, 9, 22, 15);
  mock.timers.enable({ apis: ["Date"], now });
  mock.method(store, "json", (path: string, fallback: Row) =>
    path === rolesFile ? { trading: "TEST", long_term: "LONG" } : fallback,
  );
  mock.method(store, "save", () => {});
  let requests = 0,
    release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const broker = (async () => {
    requests++;
    await pending;
    throw new McpConnectionError("read timed out");
  }) as typeof connected;
  const service = new Service(false, { comparisons: {}, batch: null }, broker);
  mock.method((service as any).feed, "refresh", async () => ({}));
  service.touch("TEST", true);
  try {
    const first = (service as any).tick();
    await (service as any).tick();
    assert.equal(requests, 1);
    release();
    await first;
    // Feed completion can request one evaluation. Clear that explicit trigger
    // to measure the scheduled outage retry rather than a user refresh.
    (service as any).liveRequested = false;
    mock.timers.setTime(now + 1000);
    await (service as any).tick();
    assert.equal(requests, 1);
    mock.timers.setTime(now + 5000);
    await (service as any).tick();
    assert.equal(requests, 2);
  } finally {
    release();
    mock.restoreAll();
    mock.timers.reset();
  }
});
test("signal refreshes cannot bypass the broker's throttle cooldown", async (t) => {
  const now = Date.UTC(2026, 9, 22, 15);
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(store, "json", (path: string, fallback: Row) =>
    path === rolesFile ? { trading: "TEST", long_term: "LONG" } : fallback,
  );
  t.mock.method(store, "save", () => {});
  let requests = 0;
  const broker = (async () => {
    requests++;
    throw new BrokerError(
      'buying power fetch: API error 429: {"detail":"Request was throttled. Expected available in 25 seconds."}',
      "get_portfolio",
    );
  }) as typeof connected;
  const service = new Service(false, { comparisons: {}, batch: null }, broker);
  t.mock.method((service as any).feed, "refresh", async () => ({}));
  service.touch("TEST", true);
  await (service as any).tick();
  assert.equal(requests, 1);
  t.mock.timers.setTime(now + 25000);
  service.touch("TEST", true);
  (service as any).liveRequested = true;
  await (service as any).tick();
  assert.equal(requests, 1);
  t.mock.timers.setTime(now + 26000);
  await (service as any).tick();
  assert.equal(requests, 2);
});

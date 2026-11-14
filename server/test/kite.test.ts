import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import { tokenFile, journal, submit, connect } from "../src/brokers/kite.js";
import { indiaTradingFile } from "../src/brokers/india-selection.js";
import { localDay } from "../src/shared/calendar.js";
function setup(mode: "filled" | "unknown" | "rejected" | "pending" = "filled") {
  const saved = new Map<string, Row>([
    [indiaTradingFile, { broker: "kite", broker_selected: true }],
    [
      tokenFile,
      { date: localDay(Date.now(), "NSE"), access_token: "fake-token" },
    ],
    [
      journal,
      {
        batch: {
          id: "batch",
          user: "USER",
          status: "review",
          reviewed_at: new Date().toISOString(),
          orders: [
            {
              exchange: "NSE",
              tradingsymbol: "ABC",
              quantity: 1,
              transaction_type: "SELL",
              product: "CNC",
              order_type: "MARKET",
              validity: "DAY",
            },
            {
              exchange: "NSE",
              tradingsymbol: "XYZ",
              quantity: 1,
              transaction_type: "BUY",
              product: "CNC",
              order_type: "MARKET",
              validity: "DAY",
            },
          ],
          results: [],
        },
      },
    ],
  ]);
  const placements: string[] = [];
  let funds = 1000;
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) => {
    saved.set(path, structuredClone(value));
  });
  mock.method(store, "setting", () => "fake-key");
  mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit = {}) => {
      const path = new URL(url).pathname;
      let data: any;
      if (path === "/user/profile") data = { user_id: "USER" };
      else if (path === "/portfolio/holdings")
        data = [{ exchange: "NSE", tradingsymbol: "ABC", quantity: 3 }];
      else if (path === "/orders" && options.method === "GET") data = [];
      else if (path === "/user/margins/equity") data = { net: funds };
      else if (path === "/margins/orders")
        data = [{ total: 100, charges: { total: 1 } }];
      else if (path === "/orders/regular") {
        assert.equal(saved.get(journal)!.batch.status, "submitting");
        assert.equal(
          saved.get(journal)!.batch.results.at(-1).status,
          "submitting",
        );
        const body = new URLSearchParams(String(options.body));
        placements.push(body.get("transaction_type")!);
        if (mode === "unknown") throw new Error("response interrupted");
        if (mode === "rejected")
          return new Response(
            JSON.stringify({
              status: "error",
              error_type: "OrderException",
              message: "rejected",
            }),
            { status: 400 },
          );
        data = { order_id: "order-" + placements.length };
      } else if (path.startsWith("/orders/order-"))
        data = [{ status: mode === "pending" ? "REJECTED" : "COMPLETE" }];
      else if (path === "/session/token")
        data = { access_token: "new-fake-token" };
      else throw new Error("Unexpected request " + path);
      return new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return {
    saved,
    placements,
    setFunds(value: number) {
      funds = value;
    },
  };
}
test("Kite confirmation submits sells before buys and persists every placement", async () => {
  const { placements } = setup();
  try {
    await assert.rejects(submit("batch", false));
    assert.deepEqual(placements, []);
    const result = await submit("batch", true);
    assert.equal(result.status, "completed");
    assert.deepEqual(placements, ["SELL", "BUY"]);
    assert.ok(result.results.every((r: Row) => r.status === "filled"));
    await assert.rejects(submit("batch", true), /confirmed/);
    assert.equal(placements.length, 2);
  } finally {
    mock.restoreAll();
  }
});
test("Kite ambiguous submission becomes unknown and cannot be retried", async () => {
  const { placements } = setup("unknown");
  try {
    const result = await submit("batch", true);
    assert.equal(result.status, "unknown");
    assert.equal(result.results[0].status, "unknown");
    await assert.rejects(submit("batch", true));
    assert.deepEqual(placements, ["SELL"]);
  } finally {
    mock.restoreAll();
  }
});
test("Kite definitive rejection stops the remaining basket", async () => {
  const { placements } = setup("rejected");
  try {
    const result = await submit("batch", true);
    assert.equal(result.status, "stopped");
    assert.equal(result.results[0].status, "rejected");
    assert.deepEqual(placements, ["SELL"]);
  } finally {
    mock.restoreAll();
  }
});
test("Kite insufficient fresh funds after a sell never sends the buy", async () => {
  const { placements, setFunds } = setup();
  const original = globalThis.fetch;
  mock.method(
    globalThis,
    "fetch",
    async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      if (String(args[0]).includes("/orders/order-")) setFunds(0);
      return response;
    },
  );
  try {
    const result = await submit("batch", true);
    assert.equal(result.status, "stopped");
    assert.deepEqual(placements, ["SELL"]);
  } finally {
    mock.restoreAll();
  }
});
test("Kite connection uses the locked session exchange and persists the token encrypted", async () => {
  const { saved } = setup();
  try {
    assert.deepEqual(
      await connect("https://local.example/callback?request_token=one-time"),
      { connected: true },
    );
    assert.equal(saved.get(tokenFile)!.access_token, "new-fake-token");
  } finally {
    mock.restoreAll();
  }
});

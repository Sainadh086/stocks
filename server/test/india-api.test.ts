import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { createApp } from "../src/app.js";
import { store, type Row } from "../src/shared/storage.js";

test("India trading routes preserve local authentication, strict inputs and explicit order consent", async () => {
  const records = new Map<string, Row>();
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  const service = new Service(false),
    app = await createApp(service);
  const options = { headers: { host: "127.0.0.1:8000" } };
  const placed: unknown[] = [];
  mock.method(service.india, "confirm", async (...args: unknown[]) => {
    placed.push(args);
    return {};
  });
  try {
    const response = await app.inject({
      ...options,
      url: "/api/india/trading",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().brokers.map((b: Row) => b.id),
      ["kite", "upstox", "groww"],
    );
    assert.equal(
      records.size,
      0,
      "viewing status must not save settings or submit orders",
    );
    const token = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": token };
    assert.equal(
      (
        await app.inject({
          ...options,
          url: "/api/india/trading/orders/ticket/confirm",
          method: "POST",
          payload: { acknowledged: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          headers: { ...headers, origin: "https://evil.example" },
          url: "/api/india/trading/orders/ticket/confirm",
          method: "POST",
          payload: { acknowledged: true },
        })
      ).statusCode,
      403,
    );
    for (const payload of [
      {},
      { acknowledged: false },
      { acknowledged: true, quantity: 999 },
    ]) {
      assert.equal(
        (
          await app.inject({
            headers,
            url: "/api/india/trading/orders/ticket/confirm",
            method: "POST",
            payload,
          })
        ).statusCode,
        422,
      );
    }
    assert.equal(placed.length, 0);
    assert.equal(
      (
        await app.inject({
          headers,
          url: "/api/india/trading/preview",
          method: "POST",
          payload: { symbol: "INFY", side: "buy", quantity: 999999 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          headers,
          url: "/api/india/trading/connect",
          method: "POST",
          payload: { broker: "groww", access_token: "bad token" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          headers,
          url: "/api/india/trading/broker",
          method: "POST",
          payload: { broker: "robinhood" },
        })
      ).statusCode,
      422,
    );
    const allowed = await app.inject({
      headers,
      url: "/api/india/trading/orders/ticket/confirm",
      method: "POST",
      payload: { acknowledged: true },
    });
    assert.equal(allowed.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(placed, [["ticket", true]]);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});

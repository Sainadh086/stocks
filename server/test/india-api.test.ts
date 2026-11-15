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
    assert.equal(response.json().broker, null);
    assert.deepEqual(response.json().indices, [
      "Nifty 50",
      "Nifty Next 50",
      "Nifty 100",
      "Nifty 200",
      "Nifty 500",
      "Nifty Bank",
      "Nifty IT",
    ]);
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
    const saves: unknown[] = [];
    mock.method(service.india, "configure", async (...args: unknown[]) => {
      saves.push(args);
      return {};
    });
    for (const payload of [
      { budget: 10000, reserve_pct: 10, index: "Wrong index" },
      {
        budget: 10000,
        reserve_pct: 10,
        index: "Nifty 50",
        expected_revision: -1,
      },
      {
        budget: 10000,
        reserve_pct: 10,
        index: "Nifty Bank",
        expected_broker: "wrong-broker",
      },
    ])
      assert.equal(
        (
          await app.inject({
            headers,
            url: "/api/india/trading/settings",
            method: "POST",
            payload,
          })
        ).statusCode,
        422,
      );
    assert.equal(saves.length, 0);
    const settingSave = await app.inject({
      headers,
      url: "/api/india/trading/settings",
      method: "POST",
      payload: {
        budget: 25000,
        reserve_pct: 15,
        index: "Nifty IT",
        expected_revision: 2,
        expected_scope: "a".repeat(20),
        expected_broker: "groww",
      },
    });
    assert.equal(settingSave.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(saves, [
      [
        {
          budget: 25000,
          reserve_pct: 15,
          selection_mode: "automatic",
          index: "Nifty IT",
          symbols: [],
        },
        { revision: 2, scope: "a".repeat(20), broker: "groww" },
      ],
    ]);
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

test("concurrent settings saves get separate jobs and only the current account revision can commit", async () => {
  const { credentialsFile } = await import("../src/brokers/india.js");
  const { investmentScope } = await import("../src/brokers/india-selection.js");
  const records = new Map<string, Row>([
    [
      credentialsFile,
      { groww: { user: "ACCOUNT123", access_token: "fixture" } },
    ],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  const service = new Service(false),
    app = await createApp(service);
  const host = { host: "127.0.0.1:8000" };
  try {
    await service.india.select("groww");
    const token = (
      await app.inject({ url: "/api/bootstrap", headers: host })
    ).json().token;
    const headers = { ...host, "x-varshan-token": token };
    const responses = await Promise.all(
      [25000, 35000].map((budget) =>
        app.inject({
          url: "/api/india/trading/settings",
          method: "POST",
          headers,
          payload: {
            budget,
            reserve_pct: 10,
            selection_mode: "manual",
            symbols: ["INFY"],
            index: "Nifty 50",
            expected_revision: 0,
            expected_broker: "groww",
            expected_scope: investmentScope(),
          },
        }),
      ),
    );
    assert.ok(responses.every((r) => r.statusCode === 200));
    assert.notEqual(
      responses[0].json().id,
      responses[1].json().id,
      "distinct saves must not be deduplicated into the same job",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const jobs = await Promise.all(
      responses.map((r) =>
        app.inject({ url: "/api/jobs/" + r.json().id, headers: host }),
      ),
    );
    assert.deepEqual(jobs.map((r) => r.json().status).sort(), [
      "completed",
      "failed",
    ]);
    assert.match(
      jobs.find((r) => r.json().status === "failed")!.json().error,
      /another window/,
    );
    const committed = jobs
      .find((r) => r.json().status === "completed")!
      .json().result;
    assert.equal(
      service.india.view().settings.budget,
      committed.settings.budget,
    );
    assert.equal(service.india.view().settings_revision, 1);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});

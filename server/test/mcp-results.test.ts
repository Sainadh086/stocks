import test from "node:test";
import assert from "node:assert/strict";
import {
  BrokerError,
  decodeResult,
  readSnapshot,
  mcpRequest,
  McpConnectionError,
  readThrottleDelay,
} from "../src/brokers/robinhood.js";

test("MCP structured and JSON text results decode identically", () => {
  const data = { order: { id: "receipt", state: "filled" } };
  assert.deepEqual(
    decodeResult({ structuredContent: { data } }, "place_equity_order"),
    data,
  );
  assert.deepEqual(
    decodeResult(
      { content: [{ type: "text", text: JSON.stringify({ data }) }] },
      "place_equity_order",
    ),
    data,
  );
});
test("MCP broker errors retain actionable details and redact OAuth secrets", () => {
  assert.throws(
    () =>
      decodeResult(
        {
          isError: true,
          content: [{ type: "text", text: "Insufficient buying power" }],
        },
        "review_equity_order",
      ),
    (e: unknown) =>
      e instanceof BrokerError && /Insufficient buying power/.test(e.message),
  );
  assert.throws(
    () =>
      decodeResult(
        {
          structuredContent: {
            error: {
              message:
                "Permission denied. Bearer private-secret access_token=another-secret",
            },
          },
        },
        "get_accounts",
      ),
    (e: unknown) =>
      e instanceof BrokerError &&
      /Permission denied/.test(e.message) &&
      !/private-secret|another-secret/.test(e.message),
  );
});
test("MCP malformed placement results remain ambiguous rather than definitive rejections", () => {
  assert.throws(
    () =>
      decodeResult(
        { content: [{ type: "text", text: "connection interrupted" }] },
        "place_equity_order",
      ),
    (e: unknown) =>
      e instanceof Error &&
      !(e instanceof BrokerError) &&
      /Verify order status/.test(e.message),
  );
});

test("a malformed MCP quote list surfaces an error instead of silently waiting forever", async () => {
  await assert.rejects(
    readSnapshot(
      {
        async call(name) {
          return name === "get_portfolio" ? { total_value: 100 } : {};
        },
        async rows() {
          return [];
        },
      },
      "TRADE",
      ["A"],
    ),
    /invalid quote list/,
  );
});

test("a transient MCP read timeout retries once and recovers", async () => {
  let calls = 0;
  const result = await mcpRequest("get_portfolio", async () => {
    if (++calls === 1)
      throw Object.assign(new Error("Request timed out"), { code: -32001 });
    return { total_value: 100 };
  });
  assert.equal(calls, 2);
  assert.equal(result.total_value, 100);
});
test("a throttled portfolio result waits for the broker cooldown before retrying once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = mcpRequest("get_portfolio", async () => {
    calls++;
    return decodeResult(
      calls === 1
        ? {
            isError: true,
            content: [
              {
                type: "text",
                text: 'buying power fetch: API error 429: {"detail":"Request was throttled. Expected available in 25 seconds."}',
              },
            ],
          }
        : { structuredContent: { data: { total_value: 100 } } },
      "get_portfolio",
    );
  });
  await Promise.resolve();
  t.mock.timers.tick(25000);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, { total_value: 100 });
  assert.equal(calls, 2);
});
test("throttle retries are bounded and never replay reviews or placements", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const name of [
    "get_portfolio",
    "review_equity_order",
    "place_equity_order",
  ]) {
    let calls = 0;
    const error = new BrokerError(
      "API error 429: Request was throttled. Expected available in 25 seconds.",
      name,
    );
    const pending = assert.rejects(
      mcpRequest(name, async () => {
        calls++;
        throw error;
      }),
      (caught: unknown) => caught === error,
    );
    await Promise.resolve();
    t.mock.timers.tick(26000);
    await pending;
    assert.equal(calls, name === "get_portfolio" ? 2 : 1);
  }
});
test("read throttle delays use a fallback and preserve long broker cooldowns", async () => {
  assert.equal(
    readThrottleDelay(new BrokerError("API error 429", "get_portfolio")),
    30000,
  );
  assert.equal(
    readThrottleDelay(new BrokerError("Permission denied", "get_portfolio")),
    0,
  );
  let calls = 0;
  const error = new BrokerError(
    "Request was throttled. Expected available in 120 seconds.",
    "get_portfolio",
  );
  assert.equal(readThrottleDelay(error), 121000);
  await assert.rejects(
    mcpRequest("get_portfolio", async () => {
      calls++;
      throw error;
    }),
    (caught: unknown) => caught === error,
  );
  assert.equal(calls, 1);
});
test("persistent MCP read failures stop after one retry with an operation-specific error", async () => {
  let calls = 0;
  await assert.rejects(
    mcpRequest("get_equity_quotes", async () => {
      calls++;
      throw Object.assign(new Error("Request timed out"), { code: -32001 });
    }),
    (e: unknown) =>
      e instanceof McpConnectionError &&
      /get_equity_quotes.*after one retry/.test(e.message),
  );
  assert.equal(calls, 2);
});
test("order placements and broker rejections never retry", async () => {
  for (const name of [
    "place_equity_order",
    "review_equity_order",
    "get_accounts",
  ]) {
    let calls = 0;
    await assert.rejects(
      mcpRequest(name, async () => {
        calls++;
        if (name === "get_accounts") throw new BrokerError("Permission denied");
        throw Object.assign(new Error("Request timed out"), { code: -32001 });
      }),
    );
    assert.equal(calls, 1);
  }
});

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import {
  credentialsFile,
  connect,
  snapshot,
  place,
  cancel,
  request,
  orderState,
  type IndiaBroker,
} from "../src/brokers/india.js";
import { localDay, session } from "../src/shared/calendar.js";
import { tokenFile } from "../src/brokers/kite.js";

const now = session("2026-11-11", "NSE")![0] + 7200000;
function setup() {
  mock.timers.enable({ apis: ["Date"], now });
  const records = new Map<string, Row>([
    [
      credentialsFile,
      {
        upstox: {
          access_token: "up-secret",
          user: "UP123",
          day: localDay(now, "NSE"),
        },
        groww: {
          access_token: "gr-secret",
          user: "GR123",
          day: localDay(now, "NSE"),
        },
      },
    ],
    [tokenFile, { access_token: "kite-secret", date: localDay(now, "NSE") }],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  mock.method(store, "setting", () => "kite-key");
  return records;
}
function respond(broker: IndiaBroker, value: unknown) {
  return new Response(
    JSON.stringify(
      broker === "groww"
        ? { status: "SUCCESS", payload: value }
        : { status: "success", data: value },
    ),
  );
}

for (const broker of ["kite", "upstox", "groww"] as const)
  test(`${broker} reads account-bound NSE intraday data and uses its own order protocol`, async () => {
    setup();
    const calls: { url: URL; init?: RequestInit; body: Row }[] = [];
    const symbol = "INFY",
      key = "NSE_EQ|INE009A01021";
    mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body
          ? broker === "kite"
            ? Object.fromEntries(new URLSearchParams(String(init.body)))
            : JSON.parse(String(init.body))
          : {};
        calls.push({ url, init, body });
        const auth = (init?.headers as Row).Authorization;
        assert.equal(
          auth,
          broker === "kite"
            ? "token kite-key:kite-secret"
            : `Bearer ${broker === "upstox" ? "up-secret" : "gr-secret"}`,
        );
        if (broker === "groww")
          assert.equal((init?.headers as Row)["X-API-VERSION"], "1.0");
        const path = url.pathname;
        if (path.endsWith("/user/profile") || path.endsWith("/user/detail"))
          return respond(
            broker,
            broker === "groww"
              ? { ucc: "GR123" }
              : { user_id: broker === "kite" ? "KI123" : "UP123" },
          );
        if (path.includes("margin") && !path.includes("order"))
          return respond(
            broker,
            broker === "groww"
              ? {
                  clear_cash: 10000,
                  equity_margin_details: { mis_balance_available: 9000 },
                }
              : broker === "kite"
                ? { net: 9000 }
                : { equity: { available_margin: 9000 } },
          );
        if (path.includes("positions")) {
          const rows = [
            {
              exchange: "NSE",
              product: broker === "upstox" ? "I" : "MIS",
              trading_symbol: symbol,
              tradingsymbol: symbol,
              quantity: 2,
              average_price: 100,
              realised_pnl: 1,
            },
            { exchange: "NSE", product: "CNC", quantity: 10000 },
            { exchange: "BSE", product: "MIS", quantity: 10000 },
          ];
          return respond(
            broker,
            broker === "groww"
              ? { positions: rows }
              : broker === "kite"
                ? { net: rows }
                : rows,
          );
        }
        if (path.includes("instruments/search")) {
          assert.equal(url.searchParams.get("records"), "30");
          assert.equal(url.searchParams.get("instrument_types"), "EQ");
          return respond(broker, [
            {
              trading_symbol: symbol,
              instrument_key: key,
              segment: "NSE_EQ",
              instrument_type: "EQ",
              lot_size: 1,
            },
          ]);
        }
        if (path.endsWith("/quote") || path.endsWith("/quotes")) {
          const q = {
            last_price: 101,
            last_trade_time:
              broker === "kite" ? "2026-11-11T11:15:00+05:30" : now,
            instrument_token: key,
            bid_price: 100.9,
            offer_price: 101.1,
          };
          return respond(
            broker,
            broker === "groww"
              ? q
              : { [broker === "kite" ? "NSE:INFY" : "NSE_EQ:INFY"]: q },
          );
        }
        if (init?.method === "DELETE" || path.endsWith("/order/cancel"))
          return respond(broker, {});
        if (init?.method === "POST")
          return respond(
            broker,
            broker === "groww"
              ? { groww_order_id: "order-1" }
              : broker === "upstox"
                ? { order_ids: ["order-1"] }
                : { order_id: "order-1" },
          );
        return respond(broker, broker === "groww" ? { order_list: [] } : []);
      },
    );
    try {
      const state = await snapshot(broker, [symbol]);
      assert.equal(state.cash, 9000);
      assert.equal(state.positions.length, 1);
      assert.equal(state.positions[0].quantity, 2);
      assert.equal(state.quotes.INFY.last_trade_price, 101);
      assert.equal(Date.parse(state.quotes.INFY.venue_last_trade_time), now);
      assert.equal(
        await place(
          broker,
          { symbol, side: "buy", quantity: 2 },
          "in1234567890123456",
        ),
        "order-1",
      );
      const placement = calls.find((c) => c.init?.method === "POST")!;
      assert.equal(placement.body.product, broker === "upstox" ? "I" : "MIS");
      assert.equal(placement.body.order_type, "MARKET");
      assert.equal(placement.body.transaction_type, "BUY");
      assert.equal(Number(placement.body.quantity), 2);
      if (broker === "upstox") {
        assert.equal(placement.url.host, "api-hft.upstox.com");
        assert.equal(placement.body.market_protection, -1);
        assert.equal(placement.body.instrument_token, key);
      }
      if (broker === "groww") {
        assert.equal(placement.body.segment, "CASH");
        assert.equal(placement.body.order_reference_id, "in1234567890123456");
      }
      await cancel(broker, "order-1");
      assert.ok(
        calls.some(
          (c) =>
            c.url.pathname.includes("cancel") || c.init?.method === "DELETE",
        ),
      );
    } finally {
      mock.restoreAll();
      mock.timers.reset();
    }
  });

test("daily token connection verifies identity before persisting and never returns a token", async () => {
  const records = setup();
  let valid = false;
  mock.method(globalThis, "fetch", async () =>
    respond("groww", valid ? { ucc: "NEW123" } : {}),
  );
  try {
    await assert.rejects(connect("groww", "new-secret"), /account identity/);
    assert.equal(records.get(credentialsFile)!.groww.access_token, "gr-secret");
    valid = true;
    const result = await connect("groww", "new-secret");
    assert.deepEqual(result, { connected: true, ending: "••••W123" });
    assert.equal(
      records.get(credentialsFile)!.groww.access_token,
      "new-secret",
    );
    assert.ok(!JSON.stringify(result).includes("secret"));
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("Groww paginates all order pages and rejects malformed snapshots instead of trading on partial data", async () => {
  setup();
  const pages: string[] = [];
  let broken = false;
  const order = {
    groww_order_id: "id",
    trading_symbol: "INFY",
    quantity: 1,
    filled_quantity: 1,
    transaction_type: "BUY",
    product: "MIS",
    exchange: "NSE",
    order_status: "EXECUTED",
  };
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/user/detail"))
      return respond("groww", { ucc: "GR123" });
    if (url.pathname.includes("margins"))
      return respond("groww", {
        clear_cash: -10,
        equity_margin_details: { mis_balance_available: -10 },
      });
    if (url.pathname.includes("positions"))
      return respond("groww", { positions: [] });
    pages.push(url.searchParams.get("page")!);
    return respond(
      "groww",
      broken
        ? {}
        : {
            order_list:
              url.searchParams.get("page") === "0"
                ? Array.from({ length: 100 }, () => order)
                : [order],
          },
    );
  });
  try {
    const state = await snapshot("groww", []);
    assert.equal(state.orders.length, 101);
    assert.equal(state.cash, 0);
    assert.equal(state.orders[0].state, "filled");
    assert.deepEqual(pages, ["0", "1"]);
    broken = true;
    await assert.rejects(snapshot("groww", []), /incomplete/);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("broker error bodies cannot expose tokens and order requests are never retried", async () => {
  setup();
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        status: "FAILURE",
        message: "gr-secret",
        error: { code: "STATIC_IP" },
      }),
      { status: 403 },
    );
  });
  try {
    await assert.rejects(
      request("groww", "/order/create", "POST", { quantity: 1 }),
      (error) => {
        assert.match((error as Error).message, /static IP/);
        assert.ok(!(error as Error).message.includes("gr-secret"));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(orderState("PARTIALLY_FILLED"), "pending");
    assert.equal(orderState("COMPLETED"), "filled");
    assert.equal(orderState("REJECTED"), "rejected");
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

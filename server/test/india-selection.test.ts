import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { store, type Row } from "../src/shared/storage.js";
import { IndiaTrading } from "../src/trading/india.js";
import {
  indiaTradingFile,
  selectedBroker,
  investmentDir,
  investmentScope,
} from "../src/brokers/india-selection.js";
import {
  credentialsFile,
  investingState,
  deliveryMargin,
  connect,
} from "../src/brokers/india.js";
import {
  tokenFile,
  journal,
  submit,
  refreshStatus,
} from "../src/brokers/kite.js";
import { indiaHistory, portfolios, refreshAnalysis } from "../src/analysis.js";
import { comparisonIdentity, indiaPlan } from "../src/workspaces.js";
import { scope } from "../src/brokers/accounts.js";
import { localDay } from "../src/shared/calendar.js";

function setup() {
  const records = new Map<string, Row>([
    [
      tokenFile,
      {
        access_token: "kite-secret",
        user: "SAME123",
        date: localDay(Date.now(), "NSE"),
      },
    ],
    [
      credentialsFile,
      {
        upstox: { access_token: "up-secret", user: "SAME123" },
        groww: { access_token: "gr-secret", user: "SAME123" },
      },
    ],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  mock.method(store, "csv", () => []);
  mock.method(store, "setting", () => "kite-key");
  return records;
}
afterEach(() => mock.restoreAll());

test("connected brokers and legacy Kite defaults do not select an account or perform account reads", async () => {
  const records = setup();
  records.set(indiaTradingFile, { broker: "kite", accounts: {}, current: {} });
  let reads = 0;
  mock.method(globalThis, "fetch", async () => {
    reads++;
    throw new Error("Unexpected broker request");
  });
  const engine = new IndiaTrading();
  assert.equal(engine.view().broker, null);
  assert.equal(selectedBroker(), null);
  assert.equal(engine.view().signals.scan.phase, "not_selected");
  await assert.rejects(investingState(), /Choose your India broker/);
  await assert.rejects(refreshAnalysis("India"), /Choose your India broker/);
  await assert.rejects(engine.refresh(), /Choose your India broker/);
  assert.throws(() => indiaPlan("momentum"), /Choose your India broker/);
  assert.equal(reads, 0);
});

test("one explicit choice persists across restart and scopes investments and comparisons by broker and account", async () => {
  const records = setup();
  const engine = new IndiaTrading();
  await engine.select("upstox");
  assert.equal(selectedBroker(), "upstox");
  assert.equal(new IndiaTrading().view().broker, "upstox");
  const firstDir = investmentDir(),
    firstScope = investmentScope(),
    firstComparison = comparisonIdentity("India");
  records.set(join(firstDir, "portfolio_history.json"), {
    snapshots: [{ date: "2026-11-11", holdings: [{ symbol: "INFY" }] }],
  });
  assert.equal(indiaHistory()[0].holdings[0].symbol, "INFY");
  await engine.select("groww");
  assert.notEqual(investmentDir(), firstDir);
  assert.notEqual(investmentScope(), firstScope);
  assert.notEqual(comparisonIdentity("India"), firstComparison);
  assert.deepEqual(portfolios().india.holdings, []);
  records.get(credentialsFile)!.groww.user = "OTHER456";
  const otherScope = investmentScope();
  records.get(credentialsFile)!.groww.user = "SAME123";
  assert.notEqual(investmentScope(), otherScope);
  await engine.select("upstox");
  assert.equal(indiaHistory()[0].holdings[0].symbol, "INFY");
});

for (const broker of ["upstox", "groww"] as const) {
  test(`${broker} long-term holdings, funds, margins and confirmed delivery orders use only the chosen account`, async () => {
    const records = setup();
    const engine = new IndiaTrading();
    await engine.select(broker);
    const orders: Row[] = [],
      placements: Row[] = [],
      paths: string[] = [];
    let user = "SAME123";
    mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input)),
          path = url.pathname;
        paths.push(path);
        assert.equal(
          url.hostname,
          broker === "groww"
            ? "api.groww.in"
            : path.startsWith("/v3/order/")
              ? "api-hft.upstox.com"
              : "api.upstox.com",
        );
        assert.equal(
          (init.headers as Row).Authorization,
          `Bearer ${broker === "groww" ? "gr-secret" : "up-secret"}`,
        );
        const body = init.body ? JSON.parse(String(init.body)) : {};
        let data: unknown;
        if (path.endsWith("/user/profile")) data = { user_id: user };
        else if (path.endsWith("/user/detail")) data = { ucc: user };
        else if (path.includes("long-term-holdings"))
          data = [
            {
              trading_symbol: "INFY",
              exchange: "NSE",
              quantity: 5,
              collateral_quantity: 1,
            },
          ];
        else if (path.endsWith("/holdings/user"))
          data = {
            holdings: [
              { trading_symbol: "INFY", quantity: 5, demat_free_quantity: 3 },
            ],
          };
        else if (path.includes("get-funds-and-margin"))
          data = { equity: { available_margin: 5000 } };
        else if (path.endsWith("/margins/detail/user"))
          data = {
            clear_cash: 5000,
            equity_margin_details: {
              cnc_balance_available: 4000,
              mis_balance_available: 99999,
            },
          };
        else if (path.includes("retrieve-all")) data = orders;
        else if (path.endsWith("/order/list")) data = { order_list: orders };
        else if (path.endsWith("/instruments/search"))
          data = [
            {
              trading_symbol: "INFY",
              segment: "NSE_EQ",
              instrument_type: "EQ",
              lot_size: 1,
              instrument_key: "NSE_EQ|INE009A01021",
            },
          ];
        else if (path.endsWith("/charges/margin")) {
          assert.equal(body.instruments[0].product, "D");
          data = { required_margin: 100 };
        } else if (path.endsWith("/margins/detail/orders")) {
          assert.equal(body[0].product, "CNC");
          data = { total_requirement: 100 };
        } else if (
          path.endsWith("/order/place") ||
          path.endsWith("/order/create")
        ) {
          assert.equal(
            records.get(journal)!.batch.results.at(-1).status,
            "submitting",
          );
          assert.equal(body.product, broker === "groww" ? "CNC" : "D");
          placements.push(body);
          const id = "order-" + placements.length;
          orders.push({
            order_id: id,
            groww_order_id: id,
            tag: body.tag,
            order_reference_id: body.order_reference_id,
            trading_symbol: "INFY",
            quantity: 1,
            filled_quantity: 1,
            average_price: 100,
            transaction_type: body.transaction_type,
            product: body.product,
            exchange: "NSE",
            status: "COMPLETE",
          });
          data =
            broker === "groww" ? { groww_order_id: id } : { order_ids: [id] };
        } else throw new Error("Unexpected request " + path);
        return new Response(
          JSON.stringify(
            broker === "groww"
              ? { status: "SUCCESS", payload: data }
              : { status: "success", data },
          ),
        );
      },
    );
    const account = await investingState();
    assert.equal(account.broker, broker);
    assert.equal(account.user, "SAME123");
    assert.equal(account.funds, broker === "groww" ? 4000 : 5000);
    assert.equal(account.holdings[0].used_quantity, broker === "groww" ? 2 : 1);
    const basket = ["SELL", "BUY"].map((transaction_type) => ({
      exchange: "NSE",
      tradingsymbol: "INFY",
      quantity: 1,
      transaction_type,
      product: "CNC",
      order_type: "MARKET",
      validity: "DAY",
    }));
    assert.equal(await deliveryMargin(broker, basket), 100);
    records.set(journal, {
      batch: {
        id: "batch",
        broker,
        user: "SAME123",
        status: "review",
        reviewed_at: new Date().toISOString(),
        orders: basket,
        results: [],
      },
    });
    await assert.rejects(submit("batch", false), /Confirm/);
    assert.equal(placements.length, 0);
    const result = await submit("batch", true);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      placements.map((o) => o.transaction_type),
      ["SELL", "BUY"],
    );
    await assert.rejects(submit("batch", true), /confirmed/);
    assert.equal((await refreshStatus("batch")).status, "completed");
    assert.ok(
      !paths.some((path) => path.includes("positions")),
      "long-term funds must not come from an intraday snapshot",
    );
    user = "OTHER";
    await assert.rejects(investingState(), /account changed/);
  });
}

test("pending investment orders block switching, changed-account reconnects and stale cross-broker confirmations", async () => {
  const records = setup();
  const engine = new IndiaTrading();
  await engine.select("groww");
  records.set(journal, {
    old: {
      id: "old",
      broker: "groww",
      user: "SAME123",
      status: "unknown",
      results: [{ status: "unknown" }],
    },
  });
  await assert.rejects(engine.select("upstox"), /pending investment orders/);
  assert.equal(selectedBroker(), "groww");
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ status: "SUCCESS", payload: { ucc: "OTHER" } }),
      ),
  );
  await assert.rejects(connect("groww", "new-secret"), /different account/);
  assert.equal(records.get(credentialsFile)!.groww.user, "SAME123");
  records.set(journal, {
    old: {
      id: "old",
      broker: "groww",
      user: "SAME123",
      status: "review",
      reviewed_at: new Date().toISOString(),
      results: [],
    },
  });
  await engine.select("upstox");
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Unexpected broker read");
  });
  await assert.rejects(submit("old", true), /Broker changed/);
  await assert.rejects(refreshStatus("old"), /original broker account/);
  assert.equal(calls, 0);
});

test("confirming a migrated broker preserves unresolved tickets and cannot reactivate old automation", async () => {
  const records = setup();
  records.set(indiaTradingFile, {
    broker: "kite",
    current: { kite: scope("kite:SAME123") },
    accounts: {
      [scope("kite:SAME123")]: {
        auto: { enabled: true },
        tickets: [{ id: "pending", status: "unknown" }],
      },
    },
  });
  const engine = new IndiaTrading();
  assert.equal(engine.enabled, false);
  await engine.select("kite");
  assert.equal(engine.view().auto.enabled, false);
  assert.equal(engine.view().tickets[0].id, "pending");
  await assert.rejects(
    engine.select("groww"),
    /Reconcile pending India orders/,
  );
});

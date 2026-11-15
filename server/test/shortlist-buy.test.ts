import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { scope, rolesFile } from "../src/brokers/accounts.js";
import { ticketsFile, type connected } from "../src/brokers/robinhood.js";
import { store, type Row } from "../src/shared/storage.js";
import { session } from "../src/shared/calendar.js";
import { STRATEGY } from "../src/trading/orb.js";

const day = "2026-11-11",
  now = session(day)![0] + 1230000;
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});
function fixture() {
  mock.timers.enable({ apis: ["Date"], now });
  const records = new Map<string, Row>([
    [rolesFile, { long_term: "LONG", trading: "TRADE" }],
  ]);
  mock.method(store, "json", (file: string, fallback: Row) =>
    file.includes("live_trading_settings_")
      ? { version: 1, account_number: "TRADE", budget: 1000, reserve_pct: 10 }
      : structuredClone(records.get(file) ?? fallback),
  );
  mock.method(store, "save", (file: string, value: Row) =>
    records.set(file, structuredClone(value)),
  );
  const signals = {
    strategy: STRATEGY,
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    ranked: ["A", "B"].map((symbol) => ({
      symbol,
      range_high: 101,
      range_low: 99,
      relative_volume: 2,
    })),
    bars: Object.fromEntries(
      ["A", "B"].map((symbol) => [
        symbol,
        [
          {
            time: now - 330000,
            date: day,
            open: 100,
            high: 103,
            low: 100,
            close: 102,
            volume: 100,
          },
          {
            time: now - 1000,
            date: day,
            open: 102,
            high: 102,
            low: 102,
            close: 102,
            volume: 0,
            kind: "quote",
          },
        ],
      ]),
    ),
  };
  const positions: Row[] = [],
    orders: Row[] = [],
    reviewed: Row[] = [],
    placed: Row[] = [];
  let reads = 0;
  const portfolio: Row = {
    currency: "USD",
    total_value: "1000",
    equity_value: "0",
    cash: "1000",
    buying_power: { buying_power: "1000", unleveraged_buying_power: "1000" },
  };
  const broker: typeof connected = async (action) => {
    reads++;
    return action({
      async call(name, args) {
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
        if (name === "get_portfolio") return structuredClone(portfolio);
        if (name === "get_equity_quotes")
          return {
            results: args.symbols.map((symbol: string) => ({
              quote: {
                symbol,
                state: "active",
                has_traded: true,
                last_trade_price:
                  symbol === "A" && positions.length ? "100" : "102",
                venue_last_trade_time: new Date(now).toISOString(),
              },
            })),
          };
        if (name === "review_equity_order") {
          reviewed.push(structuredClone(args));
          return { symbol: args.symbol, side: args.side, type: args.type };
        }
        if (name === "place_equity_order") {
          placed.push(structuredClone(args));
          const order = {
            id: "order-" + placed.length,
            ref_id: args.ref_id,
            symbol: args.symbol,
            side: args.side,
            state: "filled",
            created_at: new Date(now).toISOString(),
          };
          orders.push(order);
          return { order };
        }
        throw new Error("Unexpected broker request " + name);
      },
      async rows(name) {
        return structuredClone(
          name === "get_equity_positions" ? positions : orders,
        );
      },
    });
  };
  const service = new Service(false, { comparisons: {}, batch: null }, broker);
  mock.method((service as any).feed, "snapshot", () => signals);
  mock.method((service as any).feed, "refresh", async () => signals);
  function requireSale() {
    positions.push({
      symbol: "A",
      quantity: "9",
      shares_available_for_sells: "9",
      average_buy_price: "105",
    });
    Object.assign(portfolio, {
      equity_value: "900",
      cash: "100",
      buying_power: { buying_power: "100", unleveraged_buying_power: "100" },
    });
    const all = records.get(ticketsFile) ?? {};
    all.entry = {
      id: "entry",
      status: "submitted",
      strategy: STRATEGY,
      reviewed_at: new Date(now - 600000).toISOString(),
      stop: "101",
      target: "115",
      arguments: { account_number: "TRADE", symbol: "A", side: "buy" },
      result: { order: { id: "entry", state: "filled" } },
    };
    records.set(ticketsFile, all);
  }
  return {
    service,
    records,
    signals,
    reviewed,
    placed,
    requireSale,
    reads: () => reads,
  };
}

test("a shortlisted US buy previews and confirms only the chosen stock, with no unrelated orders", async () => {
  const f = fixture();
  const preview = await f.service.previewLive("B", scope("TRADE"));
  assert.equal(preview.batch.buy_symbol, "B");
  assert.equal(preview.batch.ticket_ids.length, 1);
  assert.deepEqual(
    f.reviewed.map((t) => t.symbol),
    ["B"],
  );
  assert.equal(f.placed.length, 0);
  await assert.rejects(
    f.service.confirmLive(preview.batch.id, false),
    /confirm/,
  );
  assert.equal(f.placed.length, 0);
  await f.service.confirmLive(preview.batch.id, true);
  assert.equal(f.placed.length, 1);
  assert.equal(f.placed[0].symbol, "B");
  assert.equal(f.placed[0].side, "buy");
  assert.equal(f.placed[0].account_number, "TRADE");
  await assert.rejects(
    f.service.confirmLive(preview.batch.id, true),
    /already confirmed/,
  );
  assert.equal(f.placed.length, 1);
});

test("stale accounts, stale shortlists, unknown symbols and unresolved orders cannot produce a direct buy", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.previewLive("B", scope("OTHER")),
    /account changed/,
  );
  assert.equal(f.reads(), 0);
  await assert.rejects(
    f.service.previewLive("UNKNOWN", scope("TRADE")),
    /current US trading shortlist/,
  );
  f.signals.fresh = false;
  await assert.rejects(
    f.service.previewLive("B", scope("TRADE")),
    /current US trading shortlist/,
  );
  f.signals.fresh = true;
  f.records.set(ticketsFile, {
    uncertain: {
      id: "uncertain",
      status: "unknown",
      reviewed_at: new Date(now).toISOString(),
      arguments: { account_number: "TRADE", symbol: "A", side: "buy" },
    },
  });
  await assert.rejects(
    f.service.previewLive("B", scope("TRADE")),
    /unresolved/,
  );
  assert.deepEqual(f.reviewed, []);
  assert.deepEqual(f.placed, []);
});

test("a direct US buy cannot finance itself with unrelated sales or silently add those sales", async () => {
  const f = fixture();
  f.requireSale();
  await assert.rejects(
    f.service.previewLive("B", scope("TRADE")),
    /depends on confirmed sales/,
  );
  assert.deepEqual(f.reviewed, []);
  assert.deepEqual(f.placed, []);
});

test("a reviewed direct buy is rejected if its stock leaves the shortlist or later depends on sales", async () => {
  const f = fixture();
  const preview = await f.service.previewLive("B", scope("TRADE"));
  f.signals.ranked = f.signals.ranked.filter((p) => p.symbol !== "B");
  await assert.rejects(
    f.service.confirmLive(preview.batch.id, true),
    /decisions changed|no longer/,
  );
  assert.deepEqual(f.placed, []);
  f.signals.ranked.push({
    symbol: "B",
    range_high: 101,
    range_low: 99,
    relative_volume: 2,
  });
  const next = await f.service.previewLive("B", scope("TRADE"));
  f.requireSale();
  await assert.rejects(
    f.service.confirmLive(next.batch.id, true),
    /independently/,
  );
  assert.deepEqual(f.placed, []);
});

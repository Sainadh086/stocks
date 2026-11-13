import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { buildActions } from "../src/trading/live.js";
import { ROTATION_STRATEGY } from "../src/trading/rotation.js";
import { session } from "../src/shared/calendar.js";
import { store, type Row } from "../src/shared/storage.js";
import { Service } from "../src/service.js";
import { rolesFile } from "../src/brokers/accounts.js";
import type { connected } from "../src/brokers/robinhood.js";

const day = "2026-10-19",
  hours = session(day)!,
  now = hours[0] + 7290000;
function fixture(count: number) {
  const symbols = "ABCDE".slice(0, count).split("");
  const ranked = symbols.map((symbol) => ({
    symbol,
    range_high: 109.8,
    range_low: 109.7,
    relative_volume: 2,
  }));
  const signals = {
    strategy: ROTATION_STRATEGY,
    fresh: true,
    asof: new Date(now).toISOString(),
    message: "Ready",
    ranked,
    candidates: ranked,
    bars: Object.fromEntries(
      symbols.map((symbol) => [
        symbol,
        [
          {
            time: hours[0] + 6900000,
            date: day,
            open: 109.85,
            high: 110,
            low: 109.8,
            close: 109.9,
            volume: 100,
          },
        ],
      ]),
    ),
  };
  const snapshot: Row = {
    account_number: "TRADE",
    updated_at: new Date(now).toISOString(),
    positions: [],
    orders: [],
    portfolio: {
      currency: "USD",
      total_value: "100",
      equity_value: "0",
      cash: "100",
      buying_power: { buying_power: "100", unleveraged_buying_power: "100" },
    },
    quotes: Object.fromEntries(
      symbols.map((symbol) => [
        symbol,
        {
          state: "active",
          has_traded: true,
          last_trade_price: "110",
          venue_last_trade_time: new Date(now).toISOString(),
        },
      ]),
    ),
  };
  return { signals, snapshot };
}
function plan(f: ReturnType<typeof fixture>) {
  return buildActions(f.snapshot, f.signals, 100, 10, [], now, 100);
}
for (const count of [1, 2, 3, 4, 5]) {
  test(`$100 with 10% reserve splits across ${count} available candidates with 2–4 allocation slots`, () => {
    const f = fixture(count),
      p = plan(f),
      buys = p.actions.filter((a: Row) => a.enabled);
    const slots = Math.min(4, Math.max(2, count));
    assert.equal(p.sizing_mode, "equal_budget");
    assert.equal(p.allocation_slots, slots);
    assert.equal(p.target_usd, 90 / slots);
    assert.equal(buys.length, Math.min(count, 4));
    assert.ok(
      buys.every((a: Row) => Number(a.dollar_amount) === 90 / slots),
      "tight-stop trades can use the full equal-budget allocation within risk limits",
    );
    const invested = buys.reduce(
      (sum: number, a: Row) => sum + Number(a.dollar_amount),
      0,
    );
    assert.equal(invested, count === 1 ? 45 : 90);
  });
}

test("sub-dollar allocations stay in cash while exactly $1 allocations qualify", () => {
  const f = fixture(2);
  for (const power of ["0.01", "1.98", "1.99", "2.00"]) {
    f.snapshot.portfolio.buying_power = {
      buying_power: power,
      unleveraged_buying_power: power,
    };
    const buys = plan(f).actions.filter((a: Row) => a.enabled);
    assert.equal(buys.length, power === "2.00" ? 2 : 0);
    assert.ok(buys.every((a: Row) => a.dollar_amount === "1.00"));
    if (!buys.length && power !== "0.01")
      assert.ok(
        plan(f).actions.every((a: Row) => /\$1 minimum/.test(a.reason)),
      );
  }
});

test("only qualified stocks determine the equal split", () => {
  const f = fixture(4);
  f.signals.bars.C[0].close = 99;
  f.signals.bars.D[0].close = 99;
  const p = plan(f);
  assert.equal(p.allocation_slots, 2);
  assert.deepEqual(
    p.actions.filter((a: Row) => a.enabled).map((a: Row) => a.dollar_amount),
    ["45.00", "45.00"],
  );
});

test("limited buying power is shared equally instead of being spent on the first stock", () => {
  const f = fixture(2);
  f.snapshot.portfolio.buying_power = {
    buying_power: "20",
    unleveraged_buying_power: "20",
  };
  const p = plan(f);
  assert.equal(p.deployable_budget, 20);
  assert.deepEqual(
    p.actions.filter((a: Row) => a.enabled).map((a: Row) => a.dollar_amount),
    ["10.00", "10.00"],
  );
  f.snapshot.portfolio.buying_power = {
    buying_power: "0",
    unleveraged_buying_power: "0",
  };
  assert.equal(
    plan(f).actions.some((a: Row) => a.enabled),
    false,
  );
});

test("leveraged broker buying power cannot exceed cash, unleveraged funds or the budget", () => {
  for (const [cash, unleveraged, expected] of [
    [100, 100, 90],
    [20, 100, 20],
    [100, 20, 20],
    [0, 100, 0],
    [100, 0, 0],
    [-10, 100, 0],
  ]) {
    const f = fixture(4);
    f.snapshot.portfolio.cash = String(cash);
    f.snapshot.portfolio.buying_power = {
      buying_power: "400",
      unleveraged_buying_power: String(unleveraged),
    };
    const buys: Row[] = plan(f).actions.filter((a: Row) => a.enabled);
    assert.equal(
      buys.reduce((sum, a) => sum + Number(a.dollar_amount), 0),
      expected,
    );
  }
});

test("malformed broker balances block buys instead of being coerced into money", () => {
  for (const invalid of [
    null,
    undefined,
    true,
    false,
    [],
    [100],
    {},
    "",
    " ",
    "0x64",
    "NaN",
    "Infinity",
    NaN,
    Infinity,
  ]) {
    for (const field of [
      "cash",
      "total_value",
      "equity_value",
      "buying_power",
      "unleveraged_buying_power",
    ]) {
      const f = fixture(2);
      const target = field.includes("buying_power")
        ? f.snapshot.portfolio.buying_power
        : f.snapshot.portfolio;
      target[field] = invalid;
      assert.equal(
        plan(f).actions.some((a: Row) => a.enabled && a.side === "buy"),
        false,
        `${field}=${String(invalid)} must block buys`,
      );
    }
  }
});

test("existing holdings count toward targets and share funds with new buys", () => {
  const f = fixture(2);
  f.snapshot.positions = [
    {
      symbol: "A",
      quantity: "0.1",
      shares_available_for_sells: "0.1",
      average_buy_price: "110",
    },
  ];
  f.snapshot.portfolio.equity_value = "11";
  f.snapshot.portfolio.cash = "89";
  f.snapshot.portfolio.buying_power = {
    buying_power: "89",
    unleveraged_buying_power: "89",
  };
  const p = plan(f),
    buys: Row[] = p.actions.filter((a: Row) => a.enabled);
  assert.equal(p.allocation_slots, 2);
  assert.equal(buys.find((a) => a.symbol === "A")!.dollar_amount, "34.00");
  assert.equal(buys.find((a) => a.symbol === "A")!.top_up, true);
  assert.equal(buys.find((a) => a.symbol === "B")!.dollar_amount, "45.00");
  assert.equal(
    buys.reduce((sum, a) => sum + Number(a.dollar_amount), 0),
    79,
  );
});

test("stops, daily loss and unresolved orders still block budget-sized buys", () => {
  const f = fixture(2);
  f.snapshot.quotes.A.last_trade_price = "79";
  assert.equal(
    plan(f).actions.find((a: Row) => a.symbol === "A").enabled,
    false,
  );
  f.snapshot.portfolio.total_value = "98";
  assert.equal(
    plan(f).actions.some((a: Row) => a.enabled),
    false,
  );
  f.snapshot.portfolio.total_value = "100";
  const blocked = buildActions(
    f.snapshot,
    f.signals,
    100,
    10,
    [
      {
        status: "unknown",
        arguments: { symbol: "X", side: "buy" },
        reviewed_at: new Date(now).toISOString(),
      },
    ],
    now,
    100,
  );
  assert.equal(
    blocked.actions.some((a: Row) => a.enabled),
    false,
  );
});

test("automatic execution buys the full two-stock split once and retains reserve", async () => {
  mock.timers.enable({ apis: ["Date"], now });
  const f = fixture(2),
    placements: Row[] = [];
  const records = new Map<string, Row>([
    [rolesFile, { long_term: "LONG", trading: "TRADE" }],
  ]);
  mock.method(store, "json", (path: string, fallback: Row) =>
    path.includes("live_trading_settings_")
      ? { version: 1, account_number: "TRADE", budget: 100, reserve_pct: 10 }
      : structuredClone(records.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    records.set(path, structuredClone(value)),
  );
  const broker: typeof connected = async (action) =>
    action({
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
        if (name === "get_portfolio")
          return structuredClone(f.snapshot.portfolio);
        if (name === "get_equity_quotes")
          return {
            results: args.symbols.map((symbol: string) => ({
              quote: { symbol, ...f.snapshot.quotes[symbol] },
            })),
          };
        if (name === "review_equity_order")
          return { symbol: args.symbol, side: args.side, type: args.type };
        if (name === "place_equity_order") {
          placements.push({ ...args });
          assert.equal(args.side, "buy");
          const dollars = Number(args.dollar_amount),
            quantity = String(dollars / 110);
          f.snapshot.positions.push({
            symbol: args.symbol,
            quantity,
            shares_available_for_sells: quantity,
            average_buy_price: "110",
          });
          const cash = Number(f.snapshot.portfolio.cash) - dollars;
          f.snapshot.portfolio.cash = String(cash);
          f.snapshot.portfolio.equity_value = String(100 - cash);
          f.snapshot.portfolio.buying_power = {
            buying_power: String(cash),
            unleveraged_buying_power: String(cash),
          };
          const order = {
            id: args.ref_id,
            ref_id: args.ref_id,
            symbol: args.symbol,
            side: args.side,
            state: "filled",
            created_at: new Date(now).toISOString(),
          };
          f.snapshot.orders.push(order);
          return { order };
        }
        throw new Error(`Unexpected ${name}`);
      },
      async rows(name) {
        return structuredClone(
          name === "get_equity_positions"
            ? f.snapshot.positions
            : f.snapshot.orders,
        );
      },
    });
  const service = new Service(false, { comparisons: {}, batch: null }, broker);
  mock.method((service as any).feed, "snapshot", () => f.signals);
  mock.method((service as any).feed, "refresh", async () => f.signals);
  try {
    service.touch("fixture", true);
    await service.setAuto(true, "fixture", true, true);
    await (service as any).tick();
    assert.equal(
      service.liveView().batch.status,
      "completed",
      service.liveView().batch.error,
    );
    assert.deepEqual(
      placements.map((a) => [a.symbol, a.dollar_amount]),
      [
        ["A", "45.00"],
        ["B", "45.00"],
      ],
    );
    assert.equal(f.snapshot.portfolio.cash, "10");
    (service as any).liveRequested = true;
    await (service as any).tick();
    assert.equal(
      placements.length,
      2,
      "stocks at their targets must not keep generating duplicate buys",
    );
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

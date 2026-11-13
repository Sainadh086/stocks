import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { assessGems, gemsTechnical, rankGems } from "../src/brokers/gems.js";
import { Fundamentals } from "../src/brokers/long-term.js";
import { analyze } from "../src/shared/indicators.js";
import { yahoo, type Bar } from "../src/shared/prices.js";
import { store, type Row } from "../src/shared/storage.js";
import { refreshGems } from "../src/analysis.js";
import { completedDay } from "../src/shared/calendar.js";

const now = Date.parse("2026-11-11T22:00:00Z");
const technical: Row = {
  exchange: "US",
  price: 100,
  sma200: 90,
  rsi: 55,
  atr: 2,
  volatility_6m_pct: 20,
  price_date: "2026-11-11",
};
function facts(): Row {
  return {
    data_status: "CURRENT",
    fetched_at: new Date(now).toISOString(),
    statements_aligned: true,
    sector: "Technology",
    quote_type: "EQUITY",
    currency: "USD",
    price_currency: "USD",
    trailing_pe: 20,
    return_on_equity: 0.2,
    debt_to_equity: 0.5,
    periods: [2025, 2024, 2023].map((year, i) => ({
      date: `${year}-12-31`,
      revenue: 1440 / 1.2 ** i,
      earnings: 144 / 1.2 ** i,
      operating_cash_flow: 180 / 1.2 ** i,
      free_cash_flow: 100 / 1.2 ** i,
    })),
  };
}
test("Gems finds reasonably valued, growing cash generators while keeping qualitative review pending", () => {
  const result = assessGems(facts(), technical, now);
  assert.equal(result.gems_candidate, true);
  assert.equal(result.gems_status, "RESEARCH CANDIDATE");
  assert.ok(Math.abs(result.revenue_cagr_pct - 20) < 0.1);
  assert.match(
    result.qualitative_review,
    /government policies.*management.*3–5 year/,
  );
  assert.match(result.gems_reasons, /qualitative review/);
  assert.equal(
    assessGems(
      { ...facts(), currency: "INR", price_currency: "INR" },
      { ...technical, exchange: "NSE", price_date: "2026-11-11" },
      now,
    ).gems_candidate,
    true,
  );
});
test("Gems rejects weak valuation, overbought prices, volatility and missing evidence", () => {
  for (const patch of [
    { trailing_pe: 51 },
    { trailing_pe: 0 },
    { trailing_pe: -5 },
    { trailing_pe: null },
    { debt_to_equity: 3.1 },
    { debt_to_equity: null },
    { currency: null },
    { sector: "Financial Services" },
    { sector: "Real Estate" },
    { quote_type: "ETF" },
    { statements_aligned: false },
    { data_status: "UNAVAILABLE" },
    { fetched_at: new Date(now - 86400000).toISOString() },
    { fetched_at: "invalid" },
    { periods: [] },
  ])
    assert.equal(
      assessGems({ ...facts(), ...patch }, technical, now).gems_candidate,
      false,
      JSON.stringify(patch),
    );
  for (const patch of [
    { rsi: 70 },
    { rsi: 80 },
    { rsi: null },
    { rsi: -1 },
    { volatility_6m_pct: 51 },
    { volatility_6m_pct: NaN },
    { volatility_6m_pct: -1 },
    { atr: 5.01 },
    { atr: null },
    { price: 70 },
    { price_date: "2026-10-01" },
    { price_date: "2026-11-12" },
  ])
    assert.equal(
      assessGems(facts(), { ...technical, ...patch }, now).gems_candidate,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    gemsTechnical({ ...technical, rsi: 35, volatility_6m_pct: 30, atr: 3 }),
    true,
  );
});
test("Gems preserves comparable periods, positive long-term growth and latest cash-flow requirements", () => {
  for (const [index, field, value] of [
    [0, "date", "2024-01-01"],
    [1, "date", "2025-11-01"],
    [2, "date", "2021-12-31"],
    [0, "revenue", 900],
    [2, "earnings", 0],
    [0, "earnings", 0],
    [0, "operating_cash_flow", 0],
    [0, "free_cash_flow", -10],
    [0, "operating_cash_flow", null],
  ] as const) {
    const data = facts();
    data.periods[index][field] = value;
    assert.equal(
      assessGems(data, technical, now).gems_candidate,
      false,
      `${index} ${field}`,
    );
  }
});
test("six-month annualized volatility measures log-return dispersion", () => {
  const bars: Bar[] = Array.from({ length: 220 }, (_, i) => {
    const close = 100 * Math.exp(i * 0.001 + (i % 2) * 0.01);
    return {
      time: i,
      date: "2026-11-11",
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
  const result = analyze("TEST", "US", bars)!;
  const expected = 0.01 * Math.sqrt(126 / 125) * Math.sqrt(252) * 100;
  assert.ok(Math.abs(result.volatility_6m_pct - expected) < 1e-8);
  assert.equal(result.price_date, "2026-11-11");
});
test("scored Gems admits strong companies missed by rigid PE, cash-conversion and RSI rules without forcing weak stocks through", () => {
  const data = facts();
  data.trailing_pe = 32;
  data.periods[0].operating_cash_flow = 130;
  const candidate = assessGems(
    data,
    { ...technical, rsi: 66, volatility_6m_pct: 35 },
    now,
  );
  assert.equal(candidate.gems_candidate, true);
  assert.ok(candidate.gems_score >= 70 && candidate.gems_score <= 100);
  assert.equal(
    assessGems(data, { ...technical, rsi: 70 }, now).gems_candidate,
    false,
  );
  data.periods[0].free_cash_flow = -1;
  assert.equal(assessGems(data, technical, now).gems_candidate, false);
  const peers = [20, 30, 40, 45, 50].map((pe, i) => ({
    symbol: "P" + i,
    ...assessGems({ ...facts(), trailing_pe: pe }, technical, now),
  }));
  const ranked = rankGems(peers);
  assert.equal(ranked[0].sector_median_pe, 40);
  assert.ok(ranked.some((r) => r.sector_valuation_bonus > 0));
  assert.ok(ranked.every((r) => r.gems_score <= 100));
  assert.equal(
    assessGems({ ...facts(), currency: "EUR" }, technical, now).gems_candidate,
    true,
    "Dimensionless ratios can compare a USD quote with EUR financial statements",
  );
});
test("fundamental adapter refreshes old caches and normalizes Yahoo debt/equity percentages", async () => {
  mock.method(store, "json", () => ({
    TEST: { fetched_at: new Date(now).toISOString() },
  }));
  const summary = mock.method(yahoo, "quoteSummary", async () => ({
    summaryDetail: { trailingPE: 20 },
    summaryProfile: { sector: "Technology" },
    price: { currency: "USD", quoteType: "EQUITY" },
    financialData: {
      financialCurrency: "USD",
      returnOnEquity: 0.2,
      debtToEquity: 50,
    },
  }));
  mock.method(
    yahoo,
    "fundamentalsTimeSeries",
    async (_symbol: string, options: Row) =>
      facts().periods.map((p: Row) =>
        options.module === "financials"
          ? { date: p.date, totalRevenue: p.revenue, netIncome: p.earnings }
          : {
              date: p.date,
              operatingCashFlow: p.operating_cash_flow,
              freeCashFlow: p.free_cash_flow,
            },
      ),
  );
  try {
    const fundamentals = new Fundamentals(),
      data = await fundamentals.get("TEST", now);
    assert.equal(data.debt_to_equity, 0.5);
    assert.equal(data.trailing_pe, 20);
    assert.equal(assessGems(data, technical, now).gems_candidate, true);
    await fundamentals.get("TEST", now + 1);
    assert.equal(summary.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});
test("India Gems scans independently of brokerage holdings and preserves a dated rejection audit", async () => {
  const saved: [string, Row[]][] = [];
  mock.method(globalThis, "fetch", async () => new Response("Symbol\nTEST\n"));
  mock.method(store, "json", (_path: string, fallback: unknown) => fallback);
  mock.method(store, "save", () => {});
  mock.method(store, "saveCsv", (path: string, rows: Row[]) =>
    saved.push([path, rows]),
  );
  const financial = mock.method(yahoo, "quoteSummary", async () => {
    throw new Error("Must not fetch financials for failed technical screen");
  });
  const day = completedDay(Date.now(), "NSE");
  mock.method(yahoo, "chart", async () => ({
    quotes: Array.from({ length: 220 }, (_, i) => {
      const close = 100 + (i % 2 ? 30 : -30);
      return {
        date: new Date(Date.parse(`${day}T06:00:00Z`) - (219 - i) * 86400000),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
      };
    }),
  }));
  try {
    const result = await refreshGems("India");
    assert.equal(result.analyzed, 1);
    assert.equal(result.candidates, 0);
    assert.equal(financial.mock.callCount(), 0);
    assert.match(saved[0][0], /india_stocks\/gems_ranked_.*\.csv$/);
    assert.equal(saved[0][1][0].symbol, "TEST");
    assert.equal(saved[0][1][0].gems_status, "REJECT");
    assert.match(saved[0][1][0].gems_reasons, /Price\/risk/);
  } finally {
    mock.restoreAll();
  }
});

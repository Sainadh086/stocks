import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  beta,
  riskMetrics,
  comparisonInsights,
  datedHeadlines,
  parseNewsRss,
} from "../src/insights.js";
import { compare, comparisonIdentity } from "../src/workspaces.js";
import { Service } from "../src/service.js";
import { store } from "../src/shared/storage.js";
import { rolesFile, scope } from "../src/brokers/accounts.js";
import { createApp } from "../src/app.js";

test("risk metrics use aligned returns, sample volatility, drawdown and minimum history", () => {
  const prices = Array.from(
    { length: 140 },
    (_, i) => 100 * Math.exp(i * 0.001 + Math.sin(i) * 0.02),
  );
  const metrics = riskMetrics(prices);
  assert.equal(metrics.observations, 139);
  assert.ok(metrics.volatility_pct! > 0);
  assert.ok(metrics.max_drawdown_pct < 0);
  assert.ok(metrics.momentum_6m_pct! > 0);
  assert.ok(Math.abs(beta(prices, prices)! - 1) < 1e-10);
  assert.equal(beta([100, 101], [100, 102]), null);
  assert.equal(riskMetrics([100, 90]).volatility_pct, null);
  assert.equal(riskMetrics([100, 90]).max_drawdown_pct, -9.999999999999998);
  assert.equal(riskMetrics([100, 90]).momentum_6m_pct, null);
  assert.throws(() => riskMetrics([100, 0]), /Positive/);
});
test("multi-index insights keep weights and benchmark excess returns correct", () => {
  const dates = Array.from(
    { length: 30 },
    (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`,
  );
  const maps = new Map(
    ["A", "B", "IDX", "OTHER"].map((symbol, k) => [
      symbol,
      new Map(dates.map((date, i) => [date, 100 + i * (k + 1)])),
    ]),
  );
  const result = comparisonInsights(
    [
      { symbol: "A", qty: 3 },
      { symbol: "B", qty: 1 },
    ],
    dates,
    maps,
    ["One", "Two"],
    { One: "IDX", Two: "OTHER" },
  );
  assert.equal(result.comparisons.length, 2);
  assert.ok(
    Math.abs(
      result.stocks.reduce((sum: number, row: any) => sum + row.weight_pct, 0) -
        100,
    ) < 1e-10,
  );
  assert.equal(
    result.comparisons[0].excess_return_pp,
    result.portfolio.return_pct - result.comparisons[0].return_pct,
  );
  assert.equal(result.stocks[0].quality_status, "Evidence needed");
});
test("news filtering excludes future, old, unsafe, duplicate and unrelated holdings headlines", () => {
  const now = Date.parse("2026-10-10T12:00:00Z"),
    headline = {
      title: "Dated company results",
      publisher: "Fixture",
      link: "https://example.com/news",
      providerPublishTime: new Date(now - 86400000),
      relatedTickers: ["A"],
    };
  const rows = datedHeadlines(
    [
      headline,
      headline,
      { ...headline, link: "javascript:alert(1)" },
      {
        ...headline,
        link: "https://example.com/future",
        providerPublishTime: new Date(now + 1),
      },
      {
        ...headline,
        link: "https://example.com/old",
        providerPublishTime: new Date(now - 8 * 86400000),
      },
      {
        ...headline,
        link: "https://example.com/unrelated",
        relatedTickers: ["B"],
      },
    ],
    now - 7 * 86400000,
    now,
    "A",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "A");
});
test("comparison rejects cross-market and duplicate indices before reading accounts", async () => {
  await assert.rejects(
    compare("India", ["Nifty 50", "S&P 500"], "1y"),
    /same market/,
  );
  await assert.rejects(
    compare("long_term", ["S&P 500", "S&P 500"], "1y"),
    /distinct/,
  );
  await assert.rejects(compare("trading", [], "1y"), /distinct/);
});
test("top-bar preferences persist, validate supported indices and require API token", async () => {
  const data = new Map<string, any>();
  mock.method(store, "json", (path: string, fallback: any) =>
    structuredClone(data.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: any) =>
    data.set(path, structuredClone(value)),
  );
  const service = new Service(false),
    app = await createApp(service);
  try {
    const headers = { host: "127.0.0.1:8000" };
    const token = (await app.inject({ url: "/api/bootstrap", headers })).json()
      .token;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/preferences",
          headers,
          payload: { top_benchmarks: ["Nifty Bank"] },
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({
      method: "POST",
      url: "/api/preferences",
      headers: { ...headers, "x-varshan-token": token },
      payload: { top_benchmarks: ["Nifty Bank", "Nasdaq-100"] },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(new Service(false).preferences().top_benchmarks, [
      "Nifty Bank",
      "Nasdaq-100",
    ]);
    assert.throws(() => service.savePreferences(["unknown"]), /supported/);
    assert.throws(
      () => service.savePreferences(["Nifty 50", "Nifty 50"]),
      /distinct/,
    );
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("saved weekly reports stay isolated when an account role changes", async () => {
  mock.method(store, "json", (path: string, fallback: any) =>
    path === rolesFile ? { long_term: "ONE", trading: "TWO" } : fallback,
  );
  const identity = comparisonIdentity("long_term");
  const service = new Service(false, {
    comparisons: {},
    weeklies: {
      [identity]: {
        scope: scope("ONE"),
        positions: [],
        generated_at: "2026-10-09T12:00:00Z",
      },
    },
  });
  try {
    assert.equal(service.weekly("long_term")?.scope, scope("ONE"));
    mock.method(store, "json", (path: string, fallback: any) =>
      path === rolesFile ? { long_term: "THREE", trading: "TWO" } : fallback,
    );
    assert.equal(service.weekly("long_term"), null);
  } finally {
    await service.close();
    mock.restoreAll();
  }
});

test("fallback RSS retains publisher and dates and rejects entity declarations", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const xml = `<rss><channel><item><title>Company earnings &amp; growth</title><link>https://example.com/results</link><pubDate>Fri, 09 Oct 2026 12:00:00 GMT</pubDate><source url="https://example.com">Fixture publisher</source></item></channel></rss>`;
  const result = parseNewsRss(xml, now - 7 * 86400000, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].publisher, "Fixture publisher");
  assert.equal(result[0].title, "Company earnings & growth");
  assert.throws(
    () => parseNewsRss("<!DOCTYPE rss><rss/>", now - 7 * 86400000, now),
    /Unsupported/,
  );
});

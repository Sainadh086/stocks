import { XMLParser } from "fast-xml-parser";
import { history, yahoo, concurrent, type History } from "./shared/prices.js";
import type { Row } from "./shared/storage.js";
import { completedDay } from "./shared/calendar.js";

export const finite = (value: unknown): number | null =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;
const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const variance = (values: number[]) => {
  if (values.length < 2) return null;
  const average = mean(values);
  return (
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1)
  );
};
export const returns = (prices: number[]) =>
  prices.slice(1).map((price, i) => price / prices[i] - 1);
interface RiskMetrics {
  return_pct: number;
  volatility_pct: number | null;
  max_drawdown_pct: number;
  momentum_3m_pct: number | null;
  momentum_6m_pct: number | null;
  observations: number;
}
export function riskMetrics(prices: number[]): RiskMetrics {
  if (
    prices.length < 2 ||
    prices.some((price) => !Number.isFinite(price) || price <= 0)
  )
    throw new Error("Positive aligned prices are required.");
  let peak = prices[0],
    drawdown = 0;
  for (const price of prices) {
    peak = Math.max(peak, price);
    drawdown = Math.min(drawdown, price / peak - 1);
  }
  const daily = returns(prices),
    v = variance(daily);
  return {
    return_pct: (prices.at(-1)! / prices[0] - 1) * 100,
    volatility_pct:
      daily.length >= 20 && v !== null ? Math.sqrt(v * 252) * 100 : null,
    max_drawdown_pct: drawdown * 100,
    momentum_3m_pct:
      prices.length > 63 ? (prices.at(-1)! / prices.at(-64)! - 1) * 100 : null,
    momentum_6m_pct:
      prices.length > 126
        ? (prices.at(-1)! / prices.at(-127)! - 1) * 100
        : null,
    observations: daily.length,
  };
}
export function beta(prices: number[], benchmark: number[]): number | null {
  const a = returns(prices),
    b = returns(benchmark),
    v = variance(b);
  if (a.length !== b.length || a.length < 20 || v === null || v === 0)
    return null;
  const averageA = mean(a),
    averageB = mean(b);
  const covariance =
    a.reduce(
      (sum, value, i) => sum + (value - averageA) * (b[i] - averageB),
      0,
    ) /
    (a.length - 1);
  return covariance / v;
}
export function comparisonInsights(
  held: Row[],
  dates: string[],
  maps: Map<string, Map<string, number>>,
  names: string[],
  benchmarks: Record<string, string>,
  facts: Row[] = [],
): Row {
  const prices = (symbol: string) =>
    dates.map((date) => maps.get(symbol)!.get(date)!);
  const basket = dates.map((date) =>
    held.reduce(
      (sum, row) => sum + row.qty * maps.get(row.symbol)!.get(date)!,
      0,
    ),
  );
  const finalValue = basket.at(-1)!;
  const primary = prices(benchmarks[names[0]]);
  const stocks = held
    .map((row) => {
      const plain = String(row.symbol).replace(/\.(NS|BO)$/, "");
      const evidence = facts.find((item) => item.symbol === plain) || {};
      const metric = riskMetrics(prices(row.symbol));
      return {
        symbol: plain,
        weight_pct: ((row.qty * prices(row.symbol).at(-1)!) / finalValue) * 100,
        ...metric,
        beta: beta(prices(row.symbol), primary),
        revenue_growth_pct: finite(evidence.revenue_growth_pct),
        earnings_growth_pct: finite(evidence.earnings_growth_pct),
        operating_cash_flow: finite(evidence.operating_cash_flow),
        free_cash_flow: finite(evidence.free_cash_flow),
        financial_period: evidence.financial_period || null,
        financial_fetched_at: evidence.financial_fetched_at || null,
        quality_review:
          evidence.long_term_reasons ||
          "Company financial evidence unavailable; review filings",
        quality_status: evidence.long_term_action || "Evidence needed",
      };
    })
    .sort((a, b) => b.weight_pct - a.weight_pct);
  const weights = stocks.map((row) => row.weight_pct / 100);
  const portfolio = {
    name: "Current holdings basket",
    ...riskMetrics(basket),
    beta: beta(basket, primary),
  };
  const comparisons = names.map((name) => ({
    name,
    ...riskMetrics(prices(benchmarks[name])),
    beta: beta(prices(benchmarks[name]), primary),
    excess_return_pp:
      portfolio.return_pct - riskMetrics(prices(benchmarks[name])).return_pct,
  }));
  const avgVol = stocks.every((row) => row.volatility_pct !== null)
    ? stocks.reduce(
        (sum, row) => sum + (row.weight_pct / 100) * row.volatility_pct!,
        0,
      )
    : null;
  return {
    portfolio,
    comparisons,
    stocks,
    effective_positions: 1 / weights.reduce((sum, w) => sum + w * w, 0),
    top_three_weight_pct: stocks
      .slice(0, 3)
      .reduce((sum, row) => sum + row.weight_pct, 0),
    weighted_stock_volatility_pct: avgVol,
    diversification_reduction_pct:
      avgVol && portfolio.volatility_pct !== null
        ? (1 - portfolio.volatility_pct / avgVol) * 100
        : null,
    start_date: dates[0],
    end_date: dates.at(-1),
    methodology:
      "Annualized volatility uses sample standard deviation of daily simple returns × √252 (at least 20 observations). Beta uses aligned daily returns against the first selected index. Momentum uses 63 and 126 sessions when available. Price returns exclude dividends, cash and costs. Effective positions = 1 / sum of squared current weights; it does not measure sector diversity.",
  };
}
const priceCache = new Map<
  string,
  { expires: number; promise: Promise<History> }
>();
export function insightHistory(
  symbol: string,
  period = "1y",
): Promise<History> {
  const key = `${symbol}:${period}`,
    cached = priceCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = history(symbol, period, "1d", false).then((result) => ({
    ...result,
    bars: result.bars.filter(
      (bar) =>
        bar.date <=
        completedDay(
          Date.now(),
          symbol.endsWith(".NS") ||
            symbol.endsWith(".BO") ||
            symbol.startsWith("^NSE") ||
            symbol === "^BSESN" ||
            symbol.startsWith("NSE:") ||
            symbol.startsWith("BSE:")
            ? "NSE"
            : "NYSE",
        ),
    ),
  }));
  priceCache.set(key, { expires: Date.now() + 900000, promise });
  if (priceCache.size > 250) priceCache.delete(priceCache.keys().next().value!);
  void promise.catch(() => priceCache.delete(key));
  return promise;
}
export function datedHeadlines(
  items: Row[],
  from: number,
  until: number,
  symbol?: string,
): Row[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const time = new Date(item.providerPublishTime).getTime();
    let url: URL;
    try {
      url = new URL(item.link);
    } catch {
      return [];
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !item.title ||
      time < from ||
      time > until ||
      !Number.isFinite(time) ||
      seen.has(url.href)
    )
      return [];
    if (
      symbol &&
      !(
        Array.isArray(item.relatedTickers) &&
        item.relatedTickers.includes(symbol)
      )
    )
      return [];
    seen.add(url.href);
    return [
      {
        title: String(item.title),
        url: url.href,
        publisher: String(item.publisher || "Publisher unavailable"),
        published_at: new Date(time).toISOString(),
        symbol: symbol || null,
      },
    ];
  });
}
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  processEntities: false,
});
export function parseNewsRss(xml: string, from: number, until: number): Row[] {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported news feed.");
  const items = xmlParser.parse(xml)?.rss?.channel?.item ?? [];
  const decode = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
  return datedHeadlines(
    (Array.isArray(items) ? items : [items]).map((item: Row) => ({
      title: decode(item.title),
      link: decode(item.link),
      publisher: decode(item.source),
      providerPublishTime: item.pubDate,
    })),
    from,
    until,
  );
}
async function rssNews(
  query: string,
  region: string,
  from: number,
  until: number,
): Promise<Row[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: query + " when:7d",
    hl: region === "India" ? "en-IN" : "en-US",
    gl: region === "India" ? "IN" : "US",
    ceid: region === "India" ? "IN:en" : "US:en",
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("News feed unavailable.");
  return parseNewsRss(await response.text(), from, until);
}
function headlineThemes(headlines: Row[]): string {
  const topics = [
    ["Earnings and results", /earnings|profit|quarterly|results|revenue/i],
    [
      "Monetary policy",
      /interest rate|federal reserve|\bfed\b|\brbi\b|rate cut|rate hike/i,
    ],
    ["Inflation and economy", /inflation|\bgdp\b|jobs|employment|economy/i],
    [
      "Company developments",
      /launch|merger|acquisition|buyback|dividend|contract|approval/i,
    ],
    [
      "Market and geopolitical developments",
      /market|stocks|shares|tariff|trade war|oil|war/i,
    ],
  ] as const;
  const matches = topics
    .map(
      ([name, expression]) =>
        [
          name,
          headlines.filter((item) => expression.test(item.title)).length,
        ] as const,
    )
    .filter(([, count]) => count > 0);
  return matches.length
    ? "Reported headline themes: " +
        matches.map(([name, count]) => `${name} (${count})`).join("; ") +
        "."
    : headlines.length
      ? `${headlines.length} dated company or market headlines available below.`
      : "No dated headlines returned for this window.";
}
export async function weeklyEvents(
  held: Row[],
  role: "India" | "long_term" | "trading",
  now = Date.now(),
): Promise<Row> {
  const from = now - 7 * 86400000;
  const queries = [
    {
      label: "India",
      query: "India stock market Nifty Sensex",
      symbol: "^NSEI",
    },
    {
      label: "US",
      query: "US stock market S&P 500 Federal Reserve",
      symbol: "^GSPC",
    },
  ];
  const markets = await concurrent(queries, 2, async (entry) => {
    let headlines: Row[] = [],
      error: string | null = null;
    try {
      const found = await yahoo.search(
        entry.query,
        { newsCount: 15, quotesCount: 0 },
        { fetchOptions: { signal: AbortSignal.timeout(12000) } },
      );
      headlines = datedHeadlines(found.news, from, now).slice(0, 6);
    } catch {
      error = "Headlines are unavailable from the news provider.";
    }
    if (!headlines.length) {
      try {
        headlines = (
          await rssNews(
            entry.label === "India"
              ? "India stock market Nifty Sensex"
              : "US stock market S&P 500",
            entry.label,
            from,
            now,
          )
        ).slice(0, 6);
        error = null;
      } catch {
        error = "Yahoo Finance and the secondary news feed are unavailable.";
      }
    }
    let summary = "Completed-session prices are unavailable.",
      price_source: string | null = null;
    try {
      const result = await insightHistory(entry.symbol, "1m"),
        end = result.bars.at(-1)!;
      if (!end || Date.parse(end.date) < from)
        throw new Error("No current completed prices.");
      const target = Date.parse(end.date) - 7 * 86400000;
      const start = result.bars
        .filter((bar) => Date.parse(bar.date) <= target)
        .at(-1);
      if (start)
        summary = `${entry.symbol === "^NSEI" ? "Nifty 50" : "S&P 500"} moved ${((end.close / start.close - 1) * 100).toFixed(2)}% between ${start.date} and ${end.date}. ${headlines.length} dated market headlines are available for the last seven days.`;
      price_source = result.source;
    } catch {
      /* Preserve source headlines when price data is unavailable. */
    }
    return {
      region: entry.label,
      summary: summary + " " + headlineThemes(headlines),
      price_source,
      headlines,
      error,
    };
  });
  const holdings = await concurrent(held, 4, async (row) => {
    let headlines: Row[] = [],
      error: string | null = null,
      change: number | null = null,
      start_date: string | null = null,
      end_date: string | null = null,
      source: string | null = null,
      company: string | null = null;
    try {
      const result = await yahoo.search(
        row.symbol,
        { newsCount: 10, quotesCount: 1 },
        { fetchOptions: { signal: AbortSignal.timeout(12000) } },
      );
      const quote = result.quotes.find(
        (item) => "symbol" in item && item.symbol === row.symbol,
      );
      company =
        quote && "shortname" in quote && typeof quote.shortname === "string"
          ? quote.shortname
          : null;
      headlines = datedHeadlines(result.news, from, now, row.symbol).slice(
        0,
        3,
      );
    } catch {
      error = "Holdings news unavailable.";
    }
    if (!headlines.length) {
      const match = (company || String(row.symbol).replace(/\.(NS|BO)$/, ""))
        .replace(
          /\b(incorporated|inc|corporation|corp|limited|ltd|plc|class [abc])\b/gi,
          "",
        )
        .replace(/[.,]/g, "")
        .trim();
      if (match.length >= 3) {
        try {
          headlines = (
            await rssNews(
              `"${match}" stock`,
              role === "India" ? "India" : "US",
              from,
              now,
            )
          )
            .filter((item) =>
              String(item.title).toLowerCase().includes(match.toLowerCase()),
            )
            .slice(0, 3)
            .map((item) => ({ ...item, symbol: row.symbol }));
          error = null;
        } catch {
          error = "Yahoo Finance and the secondary news feed are unavailable.";
        }
      }
    }
    try {
      const result = await insightHistory(row.symbol, "1m"),
        end = result.bars.at(-1)!;
      if (!end || Date.parse(end.date) < from)
        throw new Error("No current completed prices.");
      const target = Date.parse(end.date) - 7 * 86400000,
        start = result.bars
          .filter((bar) => Date.parse(bar.date) <= target)
          .at(-1);
      if (start) {
        change = (end.close / start.close - 1) * 100;
        start_date = start.date;
        end_date = end.date;
        source = result.source;
      }
    } catch {
      /* Missing price evidence stays null. */
    }
    return {
      symbol: row.symbol,
      weekly_price_change_pct: change,
      news_summary: headlineThemes(headlines),
      start_date,
      end_date,
      source,
      headlines,
      error,
    };
  });
  return {
    role,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    generated_at: new Date(now).toISOString(),
    markets,
    holdings,
    summary: `${holdings.length} holdings reviewed. ${holdings.filter((row) => row.weekly_price_change_pct !== null && row.weekly_price_change_pct > 0).length} rose and ${holdings.filter((row) => row.weekly_price_change_pct !== null && row.weekly_price_change_pct < 0).length} fell over their displayed completed-session windows; ${holdings.filter((row) => row.weekly_price_change_pct === null).length} lack comparable prices. ${holdings.reduce((sum, row) => sum + row.headlines.length, 0)} dated holdings headlines are available. Headlines describe reported events, not proven causes of price changes.`,
  };
}

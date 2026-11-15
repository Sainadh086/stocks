import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import {
  store,
  INDIA,
  US,
  latest,
  errorMessage,
  type Row,
} from "./shared/storage.js";
import { history, yahoo, concurrent } from "./shared/prices.js";
import { analyze, potential } from "./shared/indicators.js";
import { localDay, completedDay } from "./shared/calendar.js";
import { roles, scope, holdingsPath, rolesFile } from "./brokers/accounts.js";
import { Fundamentals, assess } from "./brokers/long-term.js";
import { assessGems, gemsTechnical, rankGems } from "./brokers/gems.js";
import {
  rememberLearning,
  learningAdvisor,
  researchLearningContext,
} from "./learning.js";
import { investingState } from "./brokers/india.js";
import {
  requireBroker,
  investmentDir,
  investmentScope,
} from "./brokers/india-selection.js";
import {
  indiaTradingIndices,
  type IndiaTradingIndex,
} from "./trading/india-indices.js";
const frame = (dir: string, prefix: string) => {
  const path = latest(dir, prefix);
  return path ? store.csv(path) : [];
};
export const gemsRows = (market: "India" | "US"): Row[] => {
  const advisor = learningAdvisor(
    researchLearningContext({
      market,
      horizon: "long_term",
      broker: market === "US" ? "robinhood" : "research",
      scope: market === "US" ? scope(roles().long_term) : "india-research",
    }),
    "gems",
  );
  return frame(market === "US" ? US : INDIA, "gems_ranked_")
    .map((row): Row => ({ ...row, ...advisor(row) }))
    .sort(
      (a, b) =>
        Number(b.gems_candidate) - Number(a.gems_candidate) ||
        b.gems_score +
          b.learning_adjustment -
          (a.gems_score + a.learning_adjustment),
    );
};
export const indiaHistory = (): Row[] =>
  store.json<Row>(join(investmentDir(), "portfolio_history.json"), {
    snapshots: [],
  }).snapshots;
export const indiaSnapshot = (): Row => indiaHistory().at(-1) ?? {};
export function holdings(): Row[] {
  const combined = new Map<string, number | null>();
  for (const r of store.csv(holdingsPath())) {
    const symbol = String(r.symbol ?? "")
      .trim()
      .toUpperCase()
      .replaceAll(".", "-");
    if (!/^[A-Z0-9-]+$/.test(symbol)) continue;
    const qty =
      r.quantity == null || r.quantity === "" ? null : Number(r.quantity);
    if (qty != null && (!Number.isFinite(qty) || qty < 0))
      throw new Error(`Invalid share quantity for ${symbol}.`);
    combined.set(
      symbol,
      qty == null ? null : (combined.get(symbol) ?? 0) + qty,
    );
  }
  return [...combined].map(([symbol, quantity]) => ({ symbol, quantity }));
}
export function reportCurrent(report: Row[], file?: string): boolean {
  const source = holdingsPath();
  if (
    !file ||
    !existsSync(source) ||
    !report.length ||
    report.some(
      (r) =>
        r.policy_version !== 1 ||
        r.holdings_source !== source ||
        !r.long_term_action,
    )
  )
    return false;
  const modified = statSync(file).mtimeMs,
    oldest = Math.max(
      statSync(source).mtimeMs,
      existsSync(rolesFile) ? statSync(rolesFile).mtimeMs : 0,
    ),
    age = Date.now() - modified;
  return modified >= oldest && age >= 0 && age < 86400000;
}
export function portfolios(): Row {
  const result: Row = {};
  try {
    const snapshot = indiaSnapshot(),
      weekly = latest(investmentDir(), "weekly_review_");
    result.india = {
      scope: investmentScope(),
      holdings: snapshot.holdings ?? [],
      as_of: snapshot.date,
      ranked: frame(INDIA, "nifty_midsmallcap_400_momentum_ranked_"),
      replacements: frame(investmentDir(), "zerodha_potential_replacements_"),
      plan: frame(investmentDir(), "zerodha_target_plan_"),
      history: indiaHistory(),
      weekly: weekly ? store.read(weekly) : null,
      gems: gemsRows("India"),
    };
  } catch (e) {
    result.india = { holdings: [], error: errorMessage(e) };
  }
  try {
    const held = holdings(),
      file = latest(US, "us_portfolio_momentum_"),
      report = file ? store.csv(file) : [],
      current = reportCurrent(report, file);
    const review = current
      ? held.map((h) => {
          const r = report.find((r) => r.symbol === h.symbol) ?? {},
            sell =
              r.long_term_action === "EXIT REVIEW" && h.quantity > 0
                ? h.quantity
                : 0;
          return {
            ...h,
            ...r,
            proposed_sell_quantity: sell,
            proposed_target_quantity:
              h.quantity == null ? null : h.quantity - sell,
            review_instruction:
              r.long_term_action === "EXIT REVIEW"
                ? "Review filings, taxes and liquidity before selling; proceeds may stay in cash"
                : "Retain pending business-quality review",
          };
        })
      : [];
    result.us = {
      scope: scope(roles().long_term),
      holdings: held.map((h) => {
        const r = current ? report.find((r) => r.symbol === h.symbol) : null;
        return {
          ...h,
          price: r?.price ?? null,
          market_value:
            r?.price && h.quantity != null ? h.quantity * r.price : null,
        };
      }),
      report: current ? report : [],
      report_current: current,
      review,
      picks: frame(US, "us_nasdaq_100_momentum_picks_"),
      ranked: frame(US, "us_nasdaq_100_momentum_ranked_"),
      gems: gemsRows("US"),
    };
  } catch (e) {
    result.us = { holdings: [], error: errorMessage(e) };
  }
  return result;
}
let universeCache: { asof: number; symbols: string[] } | null = null;
export function nasdaqConstituents(text: string): string[] {
  const table = text.match(
    /<table\b[^>]*\bid=["']constituents["'][^>]*>[\s\S]*?<\/table>/i,
  )?.[0];
  if (!table) throw new Error("Could not find Nasdaq-100 constituent table.");
  const symbols = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => row[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "")
    .map((cell) =>
      cell
        .replace(/<[^>]*>/g, "")
        .trim()
        .toUpperCase()
        .replaceAll(".", "-"),
    )
    .filter((symbol) => /^[A-Z0-9-]+$/.test(symbol));
  if (!symbols.length) throw new Error("Index list has no usable symbols.");
  return [...new Set(symbols)];
}
export const indiaIndexCacheFile = join(
  INDIA,
  "trading_index_constituents.json",
);
export async function indiaTradingUniverse(
  index: IndiaTradingIndex = "Nifty 100",
): Promise<string[]> {
  const spec = indiaTradingIndices[index];
  if (!spec) throw new Error("Choose a supported India trading index.");
  const day = localDay(Date.now(), "NSE");
  const cache = store.json<Record<string, Row>>(indiaIndexCacheFile, {});
  const valid = (symbols: unknown): symbols is string[] =>
    Array.isArray(symbols) &&
    symbols.length >= spec.min &&
    symbols.length <= spec.max &&
    new Set(symbols).size === symbols.length &&
    symbols.every(
      (s) => typeof s === "string" && /^[A-Z0-9][A-Z0-9&.\-]{0,29}$/.test(s),
    );
  if (cache[index]?.day === day && valid(cache[index].symbols))
    return [...cache[index].symbols];
  const response = await fetch(
    "https://nsearchives.nseindia.com/content/indices/" + spec.file,
    {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Could not load the ${index} trading universe. New entries wait for a successful scan.`,
    );
  const rows: Row[] = parse(await response.text(), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const symbols = [
    ...new Set(
      rows
        .filter((r) => r.Series === "EQ")
        .map((r) => String(r.Symbol ?? "").toUpperCase())
        .filter((s) => /^[A-Z0-9][A-Z0-9&.\-]{0,29}$/.test(s)),
    ),
  ];
  if (!valid(symbols))
    throw new Error(
      `${index} constituent list is incomplete. New entries wait for a valid universe.`,
    );
  cache[index] = { day, fetched_at: new Date().toISOString(), symbols };
  store.save(indiaIndexCacheFile, cache);
  return symbols;
}
export async function universe(market: "India" | "US"): Promise<string[]> {
  if (
    market === "US" &&
    universeCache &&
    Date.now() - universeCache.asof < 86400000
  )
    return universeCache.symbols;
  const url =
      market === "India"
        ? "https://nsearchives.nseindia.com/content/indices/ind_niftymidsmallcap400list.csv"
        : "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
    response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20000),
    });
  if (!response.ok)
    throw new Error(`Could not load ${market} index constituents.`);
  const text = await response.text();
  let symbols: string[];
  if (market === "India") {
    const rows: Row[] = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    symbols = rows
      .map((r) => r.Symbol)
      .filter((s) => typeof s === "string" && /^[A-Za-z0-9&.-]+$/.test(s));
  } else {
    symbols = nasdaqConstituents(text);
  }
  symbols = [...new Set(symbols)];
  if (!symbols.length) throw new Error("Index list has no usable symbols.");
  if (market === "US") universeCache = { asof: Date.now(), symbols };
  return symbols;
}
export async function analyzeSymbol(
  symbol: string,
  exchange: string,
  completedOnly = false,
): Promise<Row> {
  try {
    const h = await history(
      symbol + (exchange === "NSE" ? ".NS" : exchange === "BSE" ? ".BO" : ""),
      "2y",
    );
    const bars = completedOnly
      ? h.bars.filter(
          (b) =>
            b.date <=
            completedDay(Date.now(), exchange === "US" ? "NYSE" : "NSE"),
        )
      : h.bars;
    const result = analyze(symbol, exchange, bars);
    if (result)
      return { ...result, ...potential(result), price_source: h.source };
  } catch {}
  return {
    symbol,
    exchange,
    action: "NO DATA",
    momentum_score: null,
    price: null,
    warnings: "History unavailable or fewer than 200 trading days",
    strengths: "",
  };
}
export async function refreshGems(market: "India" | "US"): Promise<Row> {
  const symbols = await universe(market),
    now = Date.now(),
    fundamentals = new Fundamentals(),
    rows = await concurrent(symbols, 4, async (symbol): Promise<Row> => {
      const technical = await analyzeSymbol(
          symbol,
          market === "India" ? "NSE" : "US",
          true,
        ),
        facts = gemsTechnical(technical)
          ? await fundamentals.get(symbol + (market === "India" ? ".NS" : ""))
          : {};
      return {
        symbol,
        exchange: technical.exchange ?? (market === "India" ? "NSE" : "US"),
        price: technical.price ?? null,
        price_date: technical.price_date ?? null,
        rsi: technical.rsi ?? null,
        volatility_6m_pct: technical.volatility_6m_pct ?? null,
        return_3m_pct: technical.return_3m_pct ?? null,
        action: technical.action,
        ...assessGems(facts, technical),
        ...(!gemsTechnical(technical)
          ? {
              gems_status: technical.price ? "REJECT" : "DATA GAP",
              gems_reasons: technical.price
                ? "Price/risk eligibility failed; financial statements were not requested"
                : "Price history unavailable; financial statements were not requested",
            }
          : {}),
        scanned_at: new Date(now).toISOString(),
      };
    });
  if (rows.every((r) => r.action === "NO DATA"))
    throw new Error(
      "No current price analysis available; previous Gems scan was retained.",
    );
  fundamentals.save();
  const context = {
      market,
      horizon: "long_term" as const,
      broker: market === "US" ? "robinhood" : "research",
      scope: market === "US" ? scope(roles().long_term) : "india-research",
    },
    advisor = learningAdvisor(researchLearningContext(context), "gems"),
    rankedGems = rankGems(rows).map((row) => ({ ...row, ...advisor(row) }));
  rankedGems.sort(
    (a, b) =>
      Number(b.gems_candidate) - Number(a.gems_candidate) ||
      b.gems_score +
        b.learning_adjustment -
        (a.gems_score + a.learning_adjustment),
  );
  rememberLearning(
    context,
    "gems",
    rankedGems.filter((r) => r.gems_candidate),
  );
  const date = localDay(now, market === "India" ? "NSE" : "NYSE").replaceAll(
    "-",
    "_",
  );
  store.saveCsv(
    join(market === "India" ? INDIA : US, `gems_ranked_${date}.csv`),
    rankedGems,
  );
  return {
    message: `${market} Gems research updated; policy, management and vision review pending`,
    analyzed: rows.length,
    candidates: rankedGems.filter((r) => r.gems_candidate).length,
  };
}
export async function refreshAnalysis(market: "India" | "US"): Promise<Row> {
  const account = market === "India" ? await investingState() : null,
    accountNumber = market === "US" ? roles().long_term : null,
    symbols = await universe(market),
    ranked = (
      await concurrent(symbols, 6, (s) =>
        analyzeSymbol(s, market === "India" ? "NSE" : "US"),
      )
    )
      .filter((r) => r.action !== "NO DATA")
      .sort((a, b) => b.momentum_score - a.momentum_score);
  if (!ranked.length)
    throw new Error(
      "No current price analysis available; previous analysis was retained.",
    );
  const day = localDay(Date.now(), market === "India" ? "NSE" : "NYSE"),
    date = day.replaceAll("-", "_");
  if (market === "US") {
    const fundamentals = new Fundamentals(),
      benchmarkRow = await analyzeSymbol("^GSPC", "US"),
      benchmark = benchmarkRow.return_6m_pct ?? null,
      held = holdings();
    const enriched = await concurrent(ranked, 4, async (r) => ({
      ...r,
      ...assess(await fundamentals.get(r.symbol), r, benchmark),
    }));
    const report = await concurrent(held, 4, async (h) => {
      const row =
        enriched.find((r) => r.symbol === h.symbol) ??
        (await analyzeSymbol(h.symbol, "US"));
      return {
        ...row,
        ...assess(await fundamentals.get(h.symbol), row, benchmark),
        holdings_source: holdingsPath(),
      };
    });
    fundamentals.save();
    rememberLearning(
      {
        market: "US",
        horizon: "long_term",
        broker: "robinhood",
        scope: scope(accountNumber),
      },
      "momentum",
      enriched,
    );
    if (roles().long_term !== accountNumber)
      throw new Error(
        "Long-term account changed during analysis; rerun for the selected account.",
      );
    const picks = enriched
      .filter(
        (r) =>
          ["HOLD", "STRONG HOLD"].includes(r.action) &&
          r.long_term_eligible &&
          r.potential === "HIGH",
      )
      .slice(0, 4)
      .map((r) => ({
        ...r,
        target_weight_pct: 25,
        target_usd: 2500,
        estimated_shares: Math.round((2500 / r.price) * 1000) / 1000,
      }));
    store.saveCsv(
      join(US, `us_nasdaq_100_momentum_ranked_${date}.csv`),
      enriched,
    );
    store.saveCsv(join(US, `us_nasdaq_100_momentum_picks_${date}.csv`), picks);
    if (report.length)
      store.saveCsv(join(US, `us_portfolio_momentum_${date}.csv`), report);
  } else {
    await saveIndiaAnalysis(account!, ranked, day, date);
  }
  return {
    message: `${market} analysis updated`,
    analyzed: ranked.length,
    unavailable: symbols.length - ranked.length,
  };
}
async function indiaQuality(row: Row): Promise<Row> {
  const file = join(INDIA, "fundamentals_cache.json"),
    cache = store.json<Record<string, Row>>(file, {});
  let data: Row =
    cache[row.symbol]?.version === 2 &&
    Date.now() - Date.parse(cache[row.symbol].checked_at) < 86400000
      ? cache[row.symbol].data
      : null;
  try {
    if (!data) {
      const summary = await yahoo.quoteSummary(
          row.symbol + ".NS",
          {
            modules: [
              "price",
              "summaryDetail",
              "financialData",
              "defaultKeyStatistics",
              "summaryProfile",
            ],
          },
          { fetchOptions: { signal: AbortSignal.timeout(12000) } },
        ),
        balance = await yahoo.fundamentalsTimeSeries(row.symbol + ".NS", {
          period1: new Date(Date.now() - 3 * 366 * 86400000),
          type: "annual",
          module: "balance-sheet",
        }),
        cash = await yahoo.fundamentalsTimeSeries(row.symbol + ".NS", {
          period1: new Date(Date.now() - 3 * 366 * 86400000),
          type: "annual",
          module: "cash-flow",
        }),
        b = balance.at(-1) as Row | undefined,
        c = cash.at(-1) as Row | undefined;
      data = {
        market_cap_inr: summary.price?.marketCap,
        average_volume: summary.summaryDetail?.averageVolume,
        revenue_inr: summary.financialData?.totalRevenue,
        net_income_inr: summary.defaultKeyStatistics?.netIncomeToCommon,
        operating_margin: summary.financialData?.operatingMargins,
        sector: summary.summaryProfile?.sector,
        currency: summary.financialData?.financialCurrency,
        revenue_growth: summary.financialData?.revenueGrowth,
        earnings_growth: summary.financialData?.earningsGrowth,
        trailing_pe: summary.summaryDetail?.trailingPE,
        equity_inr: b?.commonStockEquity ?? b?.stockholdersEquity,
        total_debt_inr: b?.totalDebt,
        operating_cash_flow_inr: c?.operatingCashFlow,
      };
      cache[row.symbol] = {
        version: 2,
        checked_at: new Date().toISOString(),
        data,
      };
      store.save(file, cache);
    }
  } catch {
    data = { error: "Yahoo financial data unavailable" };
  }
  const n = (key: string) =>
      data[key] != null && Number.isFinite(Number(data[key]))
        ? Number(data[key])
        : null,
    cap = n("market_cap_inr"),
    volume = n("average_volume"),
    rev = n("revenue_inr"),
    earn = n("net_income_inr"),
    equity = n("equity_inr"),
    debt = n("total_debt_inr"),
    ocf = n("operating_cash_flow_inr"),
    margin = n("operating_margin"),
    atr = row.price > 0 ? (row.atr / row.price) * 100 : null,
    financial = data.sector === "Financial Services";
  const checks = [
      data.currency === "INR",
      cap != null && cap >= 1e10,
      volume != null && volume * row.price >= 1e7,
      rev != null && rev > 0,
      earn != null && earn > 0,
      !!data.sector,
      atr != null && atr <= 8,
      financial
        ? equity != null && equity > 0 && earn != null && earn / equity >= 0.05
        : margin != null &&
          margin > 0 &&
          ocf != null &&
          ocf > 0 &&
          debt != null &&
          equity != null &&
          equity > 0 &&
          debt / equity <= 2,
    ],
    pass = checks.every(Boolean),
    naked =
      pass &&
      n("revenue_growth") != null &&
      data.revenue_growth > 0 &&
      n("earnings_growth") != null &&
      data.earnings_growth > 0 &&
      n("trailing_pe") != null &&
      data.trailing_pe > 0 &&
      data.trailing_pe <= 40;
  return {
    symbol: row.symbol,
    status: pass ? "PASS" : "REJECT",
    reason: pass
      ? "Market cap, liquidity, earnings, cash flow and risk checks pass"
      : "Financial or risk checks failed; missing data blocks eligibility",
    naked_style_status: naked ? "PASS" : "REJECT",
    atr_pct: atr,
  };
}
async function saveIndiaAnalysis(
  account: Row,
  ranked: Row[],
  day: string,
  date: string,
): Promise<void> {
  const accountScope = scope(account.broker + ":" + account.user);
  if (requireBroker() !== account.broker || investmentScope() !== accountScope)
    throw new Error(
      "India broker account changed during analysis. Refresh for the selected account.",
    );
  const dir = investmentDir();
  for (const strategy of ["momentum", "weekend_style", "naked_style"])
    rememberLearning(
      {
        market: "India",
        horizon: "long_term",
        broker: account.broker,
        scope: scope(account.broker + ":" + account.user),
      },
      strategy,
      ranked,
    );
  const prior = indiaHistory()
      .filter((s) => s.date < day)
      .at(-1),
    raw: Row[] = structuredClone(account.holdings),
    existing = new Set(raw.map((h) => h.exchange + ":" + h.tradingsymbol)),
    activity = new Map<string, Row>();
  for (const o of account.orders) {
    if (
      !["NSE", "BSE"].includes(o.exchange) ||
      !["CNC", "MTF"].includes(o.product) ||
      !(o.filled_quantity > 0)
    )
      continue;
    const key = o.exchange + ":" + o.tradingsymbol,
      a = activity.get(key) ?? {
        buy: 0,
        sell: 0,
        value: 0,
        exchange: o.exchange,
        symbol: o.tradingsymbol,
      };
    if (o.transaction_type === "BUY") {
      a.buy += o.filled_quantity;
      a.value += o.filled_quantity * o.average_price;
    } else if (o.transaction_type === "SELL") a.sell += o.filled_quantity;
    activity.set(key, a);
  }
  for (const [key, a] of activity) {
    if (!existing.has(key) && a.buy > a.sell)
      raw.push({
        exchange: a.exchange,
        tradingsymbol: a.symbol,
        quantity: 0,
        t1_quantity: a.buy - a.sell,
        average_price: a.value / a.buy,
        last_price: a.value / a.buy,
      });
  }
  const report: Row[] = await concurrent(
    raw.filter((h) => Number(h.quantity ?? 0) + Number(h.t1_quantity ?? 0) > 0),
    4,
    async (h) => {
      const technical =
          ranked.find(
            (r) => r.symbol === h.tradingsymbol && r.exchange === h.exchange,
          ) ?? (await analyzeSymbol(h.tradingsymbol, h.exchange)),
        shares = Number(h.quantity ?? 0) + Number(h.t1_quantity ?? 0),
        price = technical.price ?? h.last_price ?? null,
        incoming =
          Number(h.t1_quantity ?? 0) > 0 ||
          (activity.get(h.exchange + ":" + h.tradingsymbol)?.buy ?? 0) >
            (activity.get(h.exchange + ":" + h.tradingsymbol)?.sell ?? 0),
        old = prior?.holdings.find(
          (p: Row) => p.symbol === h.tradingsymbol && p.exchange === h.exchange,
        ),
        confirmed =
          technical.action === "REPLACE" &&
          old?.action === "REPLACE" &&
          !incoming;
      return {
        ...technical,
        price,
        shares,
        quantity: shares,
        market_value_inr:
          Number(h.last_price) > 0
            ? shares * Number(h.last_price)
            : price != null
              ? shares * price
              : null,
        incoming,
        confirmed,
      };
    },
  );
  const priority: Record<string, number> = {
      "STRONG HOLD": 0,
      HOLD: 1,
      WATCH: 2,
      REPLACE: 3,
      "NO DATA": 4,
    },
    kept = new Set(
      report
        .filter((r) => !r.confirmed)
        .sort(
          (a, b) =>
            (a.incoming ? -1 : priority[a.action]) -
              (b.incoming ? -1 : priority[b.action]) ||
            (b.momentum_score ?? -1) - (a.momentum_score ?? -1),
        )
        .slice(0, 8)
        .map((r) => r.exchange + ":" + r.symbol),
    );
  for (const r of report) {
    r.portfolio_plan = kept.has(r.exchange + ":" + r.symbol) ? "KEEP" : "SELL";
    r.plan_reason = r.confirmed
      ? "REPLACE on two dated scans; verify price, thesis, costs and taxes"
      : r.portfolio_plan === "SELL"
        ? "Capacity limit; review before exit"
        : r.action === "REPLACE"
          ? "First REPLACE scan; reassess next trading day"
          : r.action === "NO DATA"
            ? "Price history unavailable; verify manually"
            : "Trend and allocation review";
  }
  const held = new Set(report.map((r) => r.symbol)),
    candidates = ranked
      .filter(
        (r) =>
          !held.has(r.symbol) && ["HOLD", "STRONG HOLD"].includes(r.action),
      )
      .slice(0, 40),
    audit: Row[] = [],
    replacements: Row[] = [];
  for (const r of candidates) {
    const quality = await indiaQuality(r);
    audit.push(quality);
    if (quality.status !== "PASS") continue;
    const strategies = ["momentum"];
    if (r.price > r.sma200 && r.return_3m_pct > 0 && r.return_6m_pct > 0)
      strategies.push("weekend_style");
    if (quality.naked_style_status === "PASS") strategies.push("naked_style");
    replacements.push({
      stock: r.symbol,
      momentum_score: r.momentum_score,
      strategies: strategies.join(", "),
      reason: quality.reason,
    });
    if (replacements.length >= 12) break;
  }
  const total =
    report.length &&
    report.every(
      (r) => r.market_value_inr > 0 && Number.isFinite(r.market_value_inr),
    )
      ? report.reduce((n, r) => n + r.market_value_inr, 0)
      : null;
  let score: number | null = null;
  const components: Row = {};
  if (total) {
    const weights = report.map((r) => r.market_value_inr / total);
    report.forEach((r, i) => {
      r.weight_pct = Math.round(weights[i] * 1000) / 10;
    });
    const weighted = report.reduce(
        (n, r, i) => n + weights[i] * (r.momentum_score ?? 0),
        0,
      ),
      coverage = report.reduce(
        (n, r, i) => n + (r.momentum_score != null ? weights[i] * 100 : 0),
        0,
      ),
      effective = 1 / weights.reduce((n, w) => n + w * w, 0),
      diversification =
        100 *
        Math.min(effective / 8, 1) *
        (report.length > 8 ? 8 / report.length : 1);
    score =
      Math.round(
        (0.8 * weighted + 0.1 * coverage + 0.1 * diversification) * 10,
      ) / 10;
    Object.assign(components, {
      weighted_momentum: Math.round(weighted * 10) / 10,
      data_coverage_pct: Math.round(coverage * 10) / 10,
      diversification_score: Math.round(diversification * 10) / 10,
      portfolio_value_inr: Math.round(total * 100) / 100,
    });
  }
  if (requireBroker() !== account.broker || investmentScope() !== accountScope)
    throw new Error(
      "India broker account changed during analysis. Refresh for the selected account.",
    );
  const snapshot = {
    scope: accountScope,
    broker: account.broker,
    date: day,
    as_of: new Date().toISOString(),
    holdings: report,
    score,
    components,
    orders: [...activity.values()],
    total_value_inr: total,
  };
  const snapshots = indiaHistory().filter((s) => s.date !== day);
  snapshots.push(snapshot);
  store.save(join(dir, "portfolio_history.json"), {
    snapshots: snapshots.slice(-500),
  });
  store.saveCsv(
    join(INDIA, `nifty_midsmallcap_400_momentum_ranked_${date}.csv`),
    ranked,
  );
  store.saveCsv(join(dir, `zerodha_portfolio_momentum_${date}.csv`), report);
  store.saveCsv(
    join(dir, `zerodha_potential_replacements_${date}.csv`),
    replacements,
  );
  store.saveCsv(join(INDIA, `fundamentals_audit_${date}.csv`), audit);
  const plan: Row[] = [];
  for (const strategy of ["momentum", "weekend_style", "naked_style"]) {
    const approved = replacements.filter((r) =>
      r.strategies.split(", ").includes(strategy),
    );
    for (const r of approved.slice(0, Math.max(0, 8 - kept.size))) {
      const quote = ranked.find((q) => q.symbol === r.stock)!;
      plan.push({
        strategy,
        buy: r.stock,
        buy_exchange: quote.exchange,
        buy_price: quote.price,
        momentum_score: r.momentum_score,
      });
    }
  }
  store.saveCsv(join(dir, `zerodha_target_plan_${date}.csv`), plan);
  store.write(
    join(dir, "portfolio_memory.md"),
    `# Portfolio review · ${day}\n\n${report.map((r) => `${r.symbol}: ${r.portfolio_plan} — ${r.plan_reason}`).join("\n")}`,
  );
  if (new Date(day).getUTCDay() === 5)
    store.write(
      join(dir, `weekly_review_${date}.md`),
      `# Weekly review · ${day}\n\nHoldings: ${report.length}. Review concentration, business quality, taxes and costs before executing any proposed changes.\n\n${report.map((r) => `${r.symbol}: ${r.action}; ${r.plan_reason}`).join("\n")}`,
    );
}

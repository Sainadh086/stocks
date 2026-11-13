import { join } from "node:path";
import { store, US, type Row } from "../shared/storage.js";
import { yahoo } from "../shared/prices.js";
export const POLICY_VERSION = 1;
const finite = (n: unknown): number | null =>
  n == null || n === "" ? null : Number.isFinite(Number(n)) ? Number(n) : null;
const growth = (a: number | null, b: number | null) =>
  a != null && b != null && b > 0 ? (a / b - 1) * 100 : null;
const weakCash = (p: Row) => {
  const e = finite(p.earnings),
    o = finite(p.operating_cash_flow),
    f = finite(p.free_cash_flow);
  return (
    e != null &&
    o != null &&
    f != null &&
    (o <= 0 || f <= 0 || (e > 0 && o / e < 0.7))
  );
};
export function assess(
  facts: Row,
  technical: Row,
  benchmark: number | null = null,
  now = Date.now(),
): Row {
  const result: Row = {
    policy_version: 1,
    long_term_action: "REVIEW",
    long_term_eligible: false,
    long_term_score: null,
    long_term_reasons:
      "Financial statements unavailable; inspect company filings",
    financial_period: null,
    financial_currency: facts.currency ?? null,
    financial_source: facts.source ?? "Unavailable",
    financial_fetched_at: facts.fetched_at ?? null,
    revenue_growth_pct: null,
    earnings_growth_pct: null,
    net_income: null,
    operating_cash_flow: null,
    free_cash_flow: null,
    cash_conversion: null,
    relative_return_6m_pp:
      finite(technical.return_6m_pct) != null && benchmark != null
        ? technical.return_6m_pct - benchmark
        : null,
    next_year_earnings_growth_pct: facts.next_year_earnings?.growth_pct ?? null,
    next_year_revenue_growth_pct: facts.next_year_revenue?.growth_pct ?? null,
    earnings_forecast_analysts: facts.next_year_earnings?.analysts ?? null,
    revenue_forecast_analysts: facts.next_year_revenue?.analysts ?? null,
  };
  if (facts.data_status !== "CURRENT") return result;
  if (["ETF", "MUTUALFUND"].includes(facts.quote_type)) {
    result.long_term_reasons =
      "Fund: company earnings/cash-flow rules do not apply";
    return result;
  }
  if (["Financial Services", "Real Estate"].includes(facts.sector)) {
    result.long_term_reasons = "Sector-specific financial review required";
    return result;
  }
  if (
    !facts.sector ||
    facts.quote_type !== "EQUITY" ||
    facts.statements_aligned === false
  )
    return result;
  const periods: Row[] = facts.periods ?? [];
  if (periods.length < 2) return result;
  const [p, prior, older] = periods,
    date = Date.parse(p.date),
    gap = (date - Date.parse(prior.date)) / 86400000,
    age = (now - date) / 86400000;
  result.financial_period = p.date;
  if (!Number.isFinite(gap) || gap < 300 || gap > 430 || age < 0 || age > 450) {
    result.long_term_reasons =
      "Stale or non-comparable annual statements; inspect filings";
    return result;
  }
  const rev = finite(p.revenue),
    e = finite(p.earnings),
    ocf = finite(p.operating_cash_flow),
    fcf = finite(p.free_cash_flow),
    prevR = finite(prior.revenue),
    prevE = finite(prior.earnings),
    rg = growth(rev, prevR),
    eg = growth(e, prevE);
  Object.assign(result, {
    net_income: e,
    operating_cash_flow: ocf,
    free_cash_flow: fcf,
    revenue_growth_pct: rg,
    earnings_growth_pct: eg,
  });
  if (
    rev == null ||
    e == null ||
    ocf == null ||
    fcf == null ||
    prevR == null ||
    prevE == null ||
    rev <= 0 ||
    prevR <= 0
  )
    return result;
  result.cash_conversion = e > 0 ? ocf / e : null;
  const checks = [
    e > 0,
    ocf > 0,
    fcf > 0,
    rg != null && rg > 0,
    eg != null && eg > 0,
    result.cash_conversion != null && result.cash_conversion >= 0.7,
  ];
  result.long_term_score = Math.round(
    (checks.filter(Boolean).length / 6) * 100,
  );
  const forecastWeak = ["earnings", "revenue"].some(
    (m) =>
      facts[`next_year_${m}`]?.analysts >= 3 &&
      finite(facts[`next_year_${m}`]?.growth_pct) != null &&
      facts[`next_year_${m}`].growth_pct <= 0,
  );
  const repeated =
    e <= 0 &&
    prevE <= 0 &&
    ocf <= 0 &&
    finite(prior.operating_cash_flow) != null &&
    prior.operating_cash_flow <= 0;
  const olderGap = older
      ? (Date.parse(prior.date) - Date.parse(older.date)) / 86400000
      : 0,
    priorRg = older ? growth(prevR, finite(older.revenue)) : null,
    priorEg = older ? growth(prevE, finite(older.earnings)) : null;
  const persistent =
    older &&
    olderGap >= 300 &&
    olderGap <= 430 &&
    rg != null &&
    rg <= 0 &&
    eg != null &&
    eg <= 0 &&
    priorRg != null &&
    priorRg <= 0 &&
    priorEg != null &&
    priorEg <= 0;
  const under =
    result.relative_return_6m_pp != null &&
    result.relative_return_6m_pp <= -10 &&
    technical.price > 0 &&
    technical.price < technical.sma200;
  const reasons: string[] = [];
  if (e <= 0) reasons.push("Annual earnings are non-positive");
  if (ocf <= 0) reasons.push("Operating cash flow is non-positive");
  if (fcf <= 0) reasons.push("Free cash flow is non-positive");
  if (result.cash_conversion != null && result.cash_conversion < 0.7)
    reasons.push("Operating cash flow is below 70% of earnings");
  if (rg != null && rg <= 0) reasons.push("Annual revenue is not growing");
  if (eg == null)
    reasons.push("Prior earnings were non-positive; recovery needs review");
  else if (eg <= 0) reasons.push("Annual earnings are not growing");
  if (forecastWeak)
    reasons.push(
      "Next-year consensus is non-growing; estimate, not a guarantee",
    );
  if (repeated || (persistent && weakCash(p) && weakCash(prior) && under)) {
    result.long_term_action = "EXIT REVIEW";
    reasons.push(
      repeated
        ? "Non-positive earnings and operating cash flow in two annual periods"
        : "Two annual growth declines, weak cash generation, and persistent S&P 500 underperformance",
    );
  } else if (checks.every(Boolean)) {
    result.long_term_action =
      ["WATCH", "REPLACE", "NO DATA"].includes(technical.action) ||
      under ||
      forecastWeak
        ? "WATCH"
        : "HOLD";
    result.long_term_eligible = result.long_term_action === "HOLD";
    reasons.push(
      "Positive earnings, cash generation, revenue and earnings growth",
    );
  } else {
    result.long_term_action = "WATCH";
    reasons.push(
      "Weakness needs follow-up; exit evidence is not yet persistent",
    );
  }
  result.long_term_reasons = reasons.join(" | ");
  return result;
}
const cacheFile = join(US, "long_term_fundamentals.json");
export class Fundamentals {
  private cache: Record<string, Row> = store.json(cacheFile, {});
  async get(symbol: string, now = Date.now()): Promise<Row> {
    const cached = this.cache[symbol] ?? {},
      age = now - Date.parse(cached.fetched_at),
      retry = now - Date.parse(cached.attempted_at);
    if (age >= 0 && age < 86400000 && cached.gems_data_version === 1)
      return { ...cached, data_status: "CURRENT" };
    if (retry >= 0 && retry < 300000)
      return { ...cached, data_status: "UNAVAILABLE" };
    try {
      const summary = await yahoo.quoteSummary(
        symbol,
        {
          modules: [
            "summaryProfile",
            "price",
            "earningsTrend",
            "financialData",
            "summaryDetail",
            "defaultKeyStatistics",
          ],
        },
        { fetchOptions: { signal: AbortSignal.timeout(12000) } },
      );
      const income = await yahoo.fundamentalsTimeSeries(
          symbol,
          {
            period1: new Date(now - 5 * 366 * 86400000),
            type: "annual",
            module: "financials",
          },
          { fetchOptions: { signal: AbortSignal.timeout(12000) } },
        ),
        cash = await yahoo.fundamentalsTimeSeries(
          symbol,
          {
            period1: new Date(now - 5 * 366 * 86400000),
            type: "annual",
            module: "cash-flow",
          },
          { fetchOptions: { signal: AbortSignal.timeout(12000) } },
        );
      const dateOf = (r: Row) =>
          new Date(r.date ?? r.timestamp * 1000).toISOString().slice(0, 10),
        dates = income
          .map((r) => dateOf(r))
          .filter((d) => cash.some((r) => dateOf(r) === d))
          .sort()
          .reverse()
          .slice(0, 3);
      const periods = dates.map((date) => {
        const i = income.find((r) => dateOf(r) === date)! as Row,
          c = cash.find((r) => dateOf(r) === date)! as Row,
          ocf = finite(c.operatingCashFlow),
          capex = finite(c.capitalExpenditure),
          fcf = finite(c.freeCashFlow);
        return {
          date,
          revenue: finite(i.totalRevenue),
          earnings: finite(i.netIncome),
          operating_cash_flow: ocf,
          free_cash_flow:
            fcf ??
            (ocf != null && capex != null ? ocf - Math.abs(capex) : null),
        };
      });
      const trend = summary.earningsTrend?.trend.find(
          (r) => r.period === "+1y",
        ),
        forecast = (m: "earningsEstimate" | "revenueEstimate") => ({
          growth_pct:
            finite(trend?.[m]?.growth) != null
              ? Number(trend![m]!.growth) * 100
              : null,
          analysts: finite(trend?.[m]?.numberOfAnalysts),
        });
      if (
        !periods.length &&
        !["ETF", "MUTUALFUND"].includes(summary.price?.quoteType ?? "")
      )
        throw new Error("No matched annual statements");
      return (this.cache[symbol] = {
        periods,
        gems_data_version: 1,
        trailing_pe: finite(summary.summaryDetail?.trailingPE),
        price_currency: summary.price?.currency,
        return_on_equity: finite(summary.financialData?.returnOnEquity),
        debt_to_equity:
          finite(summary.financialData?.debtToEquity) != null
            ? Number(summary.financialData!.debtToEquity) / 100
            : null,
        sector: summary.summaryProfile?.sector,
        quote_type: summary.price?.quoteType,
        currency: summary.financialData?.financialCurrency,
        source: "Yahoo Finance annual financial statements",
        statements_aligned:
          income.length > 0 &&
          cash.length > 0 &&
          income.map(dateOf).sort().at(-1) === cash.map(dateOf).sort().at(-1),
        next_year_earnings: forecast("earningsEstimate"),
        next_year_revenue: forecast("revenueEstimate"),
        data_status: "CURRENT",
        fetched_at: new Date(now).toISOString(),
      });
    } catch {
      return (this.cache[symbol] = {
        ...cached,
        data_status: "UNAVAILABLE",
        attempted_at: new Date(now).toISOString(),
      });
    }
  }
  save(): void {
    const bounded = Object.entries(this.cache)
      .sort(([, a], [, b]) =>
        String(b.fetched_at ?? b.attempted_at ?? "").localeCompare(
          String(a.fetched_at ?? a.attempted_at ?? ""),
        ),
      )
      .slice(0, 500);
    store.save(cacheFile, Object.fromEntries(bounded));
  }
}

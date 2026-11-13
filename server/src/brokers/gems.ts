import type { Row } from "../shared/storage.js";
import { completedDay, localDay } from "../shared/calendar.js";

export const GEMS_REVIEW =
  "Review current government policies and regulatory exposure, management's capital allocation and governance record, and the company's 3–5 year growth plan in dated filings before investing.";
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function gemsTechnical(row: Row): boolean {
  const rsi = number(row.rsi),
    volatility = number(row.volatility_6m_pct),
    price = number(row.price),
    atr = number(row.atr),
    average = number(row.sma200);
  return (
    rsi != null &&
    rsi >= 0 &&
    rsi < 70 &&
    volatility != null &&
    volatility <= 50 &&
    volatility >= 0 &&
    price != null &&
    price > 0 &&
    atr != null &&
    atr >= 0 &&
    atr / price <= 0.05 &&
    average != null &&
    average > 0 &&
    price >= average * 0.8
  );
}

export function assessGems(facts: Row, technical: Row, now = Date.now()): Row {
  const periods: Row[] = facts.periods ?? [],
    [current, prior, oldest] = periods,
    base = oldest ?? prior,
    years =
      current && base
        ? (Date.parse(current.date) - Date.parse(base.date)) /
          (365.25 * 86400000)
        : NaN,
    cagr = (key: string) => {
      const a = number(current?.[key]),
        b = number(base?.[key]);
      const value =
        a != null && a > 0 && b != null && b > 0 && years > 0
          ? ((a / b) ** (1 / years) - 1) * 100
          : NaN;
      return Number.isFinite(value) ? value : null;
    },
    revenueGrowth = cagr("revenue"),
    earningsGrowth = cagr("earnings"),
    pe = number(facts.trailing_pe),
    peg =
      pe != null && earningsGrowth != null && earningsGrowth > 0
        ? pe / earningsGrowth
        : null,
    roe = number(facts.return_on_equity),
    debt = number(facts.debt_to_equity),
    earnings = number(current?.earnings),
    cash = number(current?.operating_cash_flow),
    free = number(current?.free_cash_flow),
    revenue = number(current?.revenue),
    conversion =
      earnings != null && earnings > 0 && cash != null ? cash / earnings : null,
    margin =
      revenue != null && revenue > 0 && free != null ? free / revenue : null,
    age = current ? (now - Date.parse(current.date)) / 86400000 : NaN,
    fetchedAge = now - Date.parse(facts.fetched_at),
    comparable =
      periods.length >= 2 &&
      periods.slice(0, Math.min(2, periods.length - 1)).every((p, i) => {
        const gap =
          (Date.parse(p.date) - Date.parse(periods[i + 1].date)) / 86400000;
        return gap >= 300 && gap <= 430;
      }),
    exchange = technical.exchange === "US" ? "NYSE" : "NSE",
    dataChecks: [boolean, string][] = [
      [
        facts.data_status === "CURRENT" &&
          fetchedAge >= 0 &&
          fetchedAge < 86400000,
        "Current financial data required",
      ],
      [
        facts.statements_aligned === true &&
          comparable &&
          age >= 0 &&
          age <= 450,
        "At least two comparable recent annual statements required",
      ],
      [
        !!facts.currency && !!facts.price_currency,
        "Financial and quote currencies required; ratios do not require them to match",
      ],
      [
        typeof technical.price_date === "string" &&
          technical.price_date >= completedDay(now, exchange) &&
          technical.price_date <= localDay(now, exchange),
        "Fresh completed daily prices required",
      ],
    ],
    coreChecks: [boolean, string][] = [
      [
        facts.quote_type === "EQUITY" &&
          !!facts.sector &&
          !["Financial Services", "Real Estate"].includes(facts.sector),
        "Financials, property and funds need sector-specific analysis",
      ],
      [
        pe != null && pe > 0 && pe <= 50,
        "Positive trailing P/E at most 50 required; cheaper valuation earns more points",
      ],
      [
        earnings != null &&
          earnings > 0 &&
          cash != null &&
          cash > 0 &&
          free != null &&
          free > 0,
        "Latest earnings, operating cash flow and free cash flow must be positive",
      ],
      [
        revenueGrowth != null &&
          revenueGrowth > 0 &&
          earningsGrowth != null &&
          earningsGrowth > 0,
        "Revenue and earnings must grow across comparable annual statements",
      ],
      [
        debt != null && debt >= 0 && debt <= 3,
        "Known debt/equity at most 3 required; lower leverage earns more points",
      ],
      [
        gemsTechnical(technical),
        "RSI below 70, volatility at most 50%, ATR/price at most 5%, and price at least 80% of its 200-day average required",
      ],
    ],
    valuationScore =
      pe == null
        ? 0
        : (pe <= 20 ? 15 : pe <= 30 ? 10 : pe <= 40 ? 5 : 0) +
          (peg == null
            ? 0
            : peg <= 1.5
              ? 10
              : peg <= 2.5
                ? 6
                : peg <= 4
                  ? 2
                  : 0),
    growthScore =
      (revenueGrowth == null
        ? 0
        : revenueGrowth >= 10
          ? 12
          : revenueGrowth >= 5
            ? 8
            : revenueGrowth > 0
              ? 3
              : 0) +
      (earningsGrowth == null
        ? 0
        : earningsGrowth >= 15
          ? 13
          : earningsGrowth >= 8
            ? 9
            : earningsGrowth > 0
              ? 3
              : 0),
    cashScore =
      (conversion == null
        ? 0
        : conversion >= 1
          ? 10
          : conversion >= 0.7
            ? 7
            : conversion > 0
              ? 2
              : 0) +
      (margin == null
        ? 0
        : margin >= 0.1
          ? 10
          : margin >= 0.05
            ? 7
            : margin > 0
              ? 3
              : 0) +
      (periods.length >= 2 &&
      periods
        .slice(0, 3)
        .every((p) => number(p.free_cash_flow) != null && p.free_cash_flow > 0)
        ? 5
        : 0),
    capitalScore =
      (roe == null ? 0 : roe >= 0.15 ? 5 : roe >= 0.1 ? 3 : 0) +
      (debt == null ? 0 : debt <= 1 ? 5 : debt <= 2 ? 3 : debt <= 3 ? 1 : 0),
    vol = number(technical.volatility_6m_pct),
    rsi = number(technical.rsi),
    riskScore =
      (vol == null ? 0 : vol <= 20 ? 6 : vol <= 30 ? 4 : vol <= 40 ? 2 : 0) +
      (rsi == null ? 0 : rsi >= 35 && rsi <= 60 ? 5 : rsi < 70 ? 2 : 0) +
      (technical.price >= technical.sma200
        ? 4
        : technical.price >= 0.9 * technical.sma200
          ? 2
          : 0),
    score = valuationScore + growthScore + cashScore + capitalScore + riskScore,
    gaps = dataChecks.filter(([pass]) => !pass).map(([, reason]) => reason),
    failures = coreChecks.filter(([pass]) => !pass).map(([, reason]) => reason),
    core = !gaps.length && !failures.length;
  return {
    gems_version: 2,
    gems_core_eligible: core,
    gems_candidate: core && score >= 70,
    gems_status: gaps.length
      ? "DATA GAP"
      : failures.length
        ? "REJECT"
        : score >= 70
          ? "RESEARCH CANDIDATE"
          : "WATCHLIST",
    gems_score: score,
    valuation_score: valuationScore,
    growth_score: growthScore,
    cash_score: cashScore,
    capital_score: capitalScore,
    risk_score: riskScore,
    gems_reasons:
      [
        ...gaps,
        ...failures,
        ...(core && score < 70
          ? [`Score ${score}/100 is below the 70-point shortlist threshold`]
          : []),
      ].join(" | ") ||
      "Quality/value/risk score passes; dated qualitative review still required",
    trailing_pe: pe,
    historical_growth_pe_ratio: peg,
    revenue_cagr_pct: revenueGrowth,
    earnings_cagr_pct: earningsGrowth,
    operating_cash_flow: cash,
    free_cash_flow: free,
    cash_conversion: conversion,
    free_cash_flow_margin_pct: margin == null ? null : margin * 100,
    return_on_equity_pct: roe == null ? null : roe * 100,
    debt_to_equity: debt,
    financial_period: current?.date ?? null,
    annual_periods: periods.length,
    financial_currency: facts.currency ?? null,
    price_currency: facts.price_currency ?? null,
    sector: facts.sector ?? null,
    financial_source: facts.source ?? "Unavailable",
    financial_fetched_at: facts.fetched_at ?? null,
    qualitative_review: GEMS_REVIEW,
  };
}

export function rankGems(rows: Row[]): Row[] {
  const groups = new Map<string, number[]>();
  for (const row of rows)
    if (row.sector && row.trailing_pe > 0 && Number.isFinite(row.trailing_pe)) {
      const values = groups.get(row.sector) ?? [];
      values.push(row.trailing_pe);
      groups.set(row.sector, values);
    }
  return rows
    .map((row): Row => {
      const peers = (groups.get(row.sector) ?? []).sort((a, b) => a - b),
        middle = Math.floor(peers.length / 2),
        median =
          peers.length >= 5
            ? peers.length % 2
              ? peers[middle]
              : (peers[middle - 1] + peers[middle]) / 2
            : null,
        bonus =
          median != null && row.trailing_pe > 0 && row.trailing_pe <= median
            ? Math.min(5, 25 - row.valuation_score)
            : 0,
        score = row.gems_score + bonus,
        candidate = row.gems_core_eligible && score >= 70;
      return {
        ...row,
        sector_median_pe: median,
        sector_valuation_bonus: bonus,
        gems_score: score,
        gems_candidate: candidate,
        gems_status: row.gems_core_eligible
          ? candidate
            ? "RESEARCH CANDIDATE"
            : "WATCHLIST"
          : row.gems_status,
        gems_reasons: candidate
          ? "Quality/value/risk score passes; dated qualitative review still required"
          : row.gems_core_eligible
            ? `Score ${score}/100 is below the 70-point shortlist threshold`
            : row.gems_reasons,
      };
    })
    .sort(
      (a, b) =>
        Number(b.gems_candidate) - Number(a.gems_candidate) ||
        b.gems_score - a.gems_score ||
        String(a.symbol).localeCompare(String(b.symbol)),
    );
}

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  store,
  INDIA,
  US,
  latest,
  type Row,
  errorMessage,
} from "./shared/storage.js";
import { history, concurrent } from "./shared/prices.js";
import { insightHistory, comparisonInsights, riskMetrics } from "./insights.js";
import {
  localDay,
  completedDay,
  phase,
  nextReview,
} from "./shared/calendar.js";
import { indiaSnapshot, holdings, portfolios } from "./analysis.js";
import { roles, scope } from "./brokers/accounts.js";
export type Role = "India" | "long_term" | "trading";
const frame = (prefix: string) => {
  const path = latest(INDIA, prefix);
  return path ? store.csv(path) : [];
};
function indiaBreadth(day: string): string {
  const files = readdirSync(INDIA)
    .filter((n) =>
      /^nifty_midsmallcap_400_momentum_ranked_\d{4}_\d{2}_\d{2}\.csv$/.test(n),
    )
    .sort()
    .reverse();
  if (files.length < 2 || !files[0].includes(day.replaceAll("-", "_")))
    return "unknown";
  const current = store.csv(join(INDIA, files[0])),
    prior = store.csv(join(INDIA, files[1]));
  let up = 0,
    down = 0;
  for (const row of current) {
    const old = prior.find((r) => r.symbol === row.symbol);
    if (!old || !(old.price > 0) || !(row.price > 0)) continue;
    if (row.price > old.price) up++;
    else if (row.price < old.price) down++;
  }
  return up + down === 0
    ? "unknown"
    : up > down
      ? "bullish"
      : down > up
        ? "bearish"
        : "mixed";
}
export function indiaPlan(
  strategy: string,
  selected?: string[],
  exits?: string[],
): Row {
  const snapshot = indiaSnapshot(),
    held: Row[] = snapshot.holdings ?? [];
  if (!held.length)
    throw new Error("Run India analysis to load holdings first.");
  const ranked = frame("nifty_midsmallcap_400_momentum_ranked_"),
    potential = frame("zerodha_potential_replacements_"),
    saved = frame("zerodha_target_plan_"),
    heldSymbols = new Set(held.map((h) => h.symbol)),
    candidates: Row[] = [];
  for (const r of potential) {
    if (
      !String(r.strategies)
        .split(",")
        .map((s) => s.trim())
        .includes(strategy)
    )
      continue;
    const quote = ranked.find((q) => q.symbol === r.stock);
    if (quote)
      candidates.push({
        buy: r.stock,
        buy_exchange: quote.exchange ?? "NSE",
        buy_price: quote.price,
        momentum_score: r.momentum_score,
        reason: r.reason,
      });
  }
  for (const r of saved.filter((r) => r.strategy === strategy))
    candidates.push({ ...r, reason: "Vetted candidate in saved target plan" });
  const choices = [
    ...new Map(
      candidates
        .filter(
          (r) =>
            !heldSymbols.has(r.buy) &&
            Number.isFinite(r.buy_price) &&
            r.buy_price > 0 &&
            ["NSE", "BSE"].includes(r.buy_exchange),
        )
        .map((r) => [r.buy, r]),
    ).values(),
  ];
  exits =
    exits ??
    held
      .filter((h) => h.portfolio_plan === "SELL")
      .map((h) => (h.exchange ?? "NSE") + ":" + h.symbol);
  selected =
    selected ??
    choices
      .slice(0, Math.max(0, 8 - (held.length - exits.length)))
      .map((r) => r.buy);
  const keys = new Set(held.map((h) => (h.exchange ?? "NSE") + ":" + h.symbol));
  if (
    exits.some((k) => !keys.has(k)) ||
    selected.some((s) => !choices.some((c) => c.buy === s)) ||
    new Set(selected).size !== selected.length ||
    new Set(exits).size !== exits.length
  )
    throw new Error("Stock selection changed or duplicated. Reopen the plan.");
  if (held.length - exits.length + selected.length > 8)
    throw new Error("Target portfolio is limited to eight stocks.");
  const view: Row[] = held.map((h) => {
    const status = exits!.includes((h.exchange ?? "NSE") + ":" + h.symbol)
      ? "Exit"
      : ["WATCH", "NO DATA", "REPLACE"].includes(h.action)
        ? "Review"
        : "Keep";
    return {
      symbol: h.symbol,
      exchange: h.exchange ?? "NSE",
      status,
      signal: h.action,
      plan_reason: h.plan_reason,
      current_shares: h.shares,
      estimated_value_inr: h.market_value_inr,
      price_inr:
        h.shares > 0 && h.market_value_inr != null
          ? h.market_value_inr / h.shares
          : null,
    };
  });
  for (const symbol of selected) {
    const c = choices.find((r) => r.buy === symbol)!;
    view.push({
      symbol,
      exchange: c.buy_exchange,
      status: "New",
      signal: "Candidate",
      plan_reason: "Vetted replacement candidate",
      current_shares: 0,
      estimated_value_inr: null,
      price_inr: c.buy_price,
    });
  }
  const total = view
      .filter((r) => r.status !== "New")
      .every(
        (r) =>
          r.estimated_value_inr > 0 && Number.isFinite(r.estimated_value_inr),
      )
      ? view.reduce((n, r) => n + (r.estimated_value_inr ?? 0), 0)
      : null,
    reviewValue = view
      .filter((r) => r.status === "Review")
      .reduce((n, r) => n + (r.estimated_value_inr ?? 0), 0),
    count = view.filter((r) => ["Keep", "New"].includes(r.status)).length,
    budget = total != null ? total - reviewValue : null;
  for (const r of view) {
    r.current_allocation_pct = total
      ? ((r.estimated_value_inr ?? 0) / total) * 100
      : null;
    r.target_allocation_pct =
      r.status === "Review"
        ? r.current_allocation_pct
        : ["Keep", "New"].includes(r.status) && total && count
          ? (budget! / total / count) * 100
          : 0;
    r.target_shares =
      r.status === "Exit"
        ? 0
        : r.status === "Review"
          ? r.current_shares
          : budget && count && r.price_inr > 0
            ? Math.floor(budget / count / r.price_inr)
            : null;
    r.shares_to_buy =
      r.target_shares == null
        ? 0
        : Math.max(0, r.target_shares - r.current_shares);
    r.shares_to_sell =
      r.target_shares == null
        ? 0
        : Math.max(0, r.current_shares - r.target_shares);
  }
  const now = Date.now(),
    stale = snapshot.date !== localDay(now, "NSE"),
    missing = view.some(
      (r) => r.target_shares == null || r.signal === "NO DATA",
    ),
    opened = phase(now, "NSE") === "Market open",
    changed = view.some((r) => r.shares_to_buy || r.shares_to_sell),
    urgent = held.some(
      (h) =>
        h.action === "REPLACE" &&
        String(h.plan_reason).includes("two dated scans") &&
        exits!.includes((h.exchange ?? "NSE") + ":" + h.symbol),
    );
  let decision = "Hold";
  const reasons: string[] = [];
  if (stale || missing) {
    decision = "Watch";
    reasons.push(
      stale
        ? "Run today’s India analysis before deciding."
        : "Some target quantities or signals lack usable data.",
    );
  } else if (urgent && changed) {
    decision = "Rebalance needed";
    reasons.push(
      "Confirmed REPLACE signals on two dated scans; prioritize reviewing exits.",
    );
  } else if (!changed) reasons.push("Proposed basket has no quantity changes.");
  else if (!opened) {
    decision = "Watch";
    reasons.push(
      "Regular NSE session is closed; reassess with fresh prices at the next session.",
    );
  } else if (view.some((r) => ["WATCH", "REPLACE"].includes(r.signal))) {
    decision = "Watch";
    reasons.push("Watch or first-scan REPLACE signals need follow-up.");
  } else if (["bearish", "unknown"].includes(indiaBreadth(snapshot.date))) {
    decision = "Watch";
    reasons.push(
      "Saved market breadth is bearish or unavailable; confirm with a fresh scan.",
    );
  } else if (
    view.some((r) => ["New", "Exit"].includes(r.status)) ||
    view.some(
      (r) =>
        r.current_allocation_pct != null &&
        r.target_allocation_pct != null &&
        Math.abs(r.current_allocation_pct - r.target_allocation_pct) >= 5,
    )
  ) {
    decision = "Rebalance";
    reasons.push(
      "Basket additions/removals or allocation drift of at least five percentage points.",
    );
  } else {
    reasons.push(
      "Only small allocation adjustments are proposed; no confirmed exit is present.",
    );
  }
  return {
    view,
    choices,
    selected,
    exits,
    holdings: held,
    assessment: {
      decision,
      reasons,
      next_review: nextReview(now),
      good_day:
        opened &&
        ["Rebalance", "Rebalance needed"].includes(decision) &&
        !stale &&
        !missing,
      scan_date: snapshot.date,
      strategy,
    },
  };
}
export function comparisonIdentity(role: Role): string {
  const identity =
    role === "India" ? "India" : role + ":" + (roles()[role] ?? "local");
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}
export function comparisonHoldings(
  role: Role,
  live?: Row | null,
): { rows: Row[]; scope: string } {
  let rows: Row[], identity: string;
  if (role === "India") {
    rows = (indiaSnapshot().holdings ?? []).map((h: Row) => ({
      symbol: h.symbol + (h.exchange === "BSE" ? ".BO" : ".NS"),
      qty: h.shares,
    }));
    identity = "India";
  } else {
    const number = roles()[role];
    identity = role + ":" + (number ?? "local");
    if (role === "long_term")
      rows = holdings().map((h) => ({ symbol: h.symbol, qty: h.quantity }));
    else {
      if (!number || live?.account_number !== number)
        throw new Error("Refresh the saved daily trading account first.");
      rows = live.positions.map((p: Row) => ({
        symbol: p.symbol,
        qty: p.quantity,
      }));
    }
  }
  for (const h of rows)
    if (h.qty == null || !Number.isFinite(Number(h.qty)) || Number(h.qty) < 0)
      throw new Error(`Share quantity unavailable for ${h.symbol}.`);
  rows = rows
    .filter((h) => Number(h.qty) > 0)
    .map((h) => ({ ...h, qty: Number(h.qty) }));
  return {
    rows,
    scope: createHash("sha256").update(identity).digest("hex").slice(0, 20),
  };
}
export const benchmarks: Record<string, string> = {
  "Nifty 50": "^NSEI",
  "Nifty Bank": "^NSEBANK",
  "Nifty MidSmallCap 400": "NSE:NIFTYMIDSML400",
  Sensex: "^BSESN",
  "S&P 500": "^GSPC",
  "Nasdaq-100": "^NDX",
  "Dow Jones": "^DJI",
  "Russell 2000": "^RUT",
};
export async function compare(
  role: Role,
  benchmark: string | string[],
  period: string,
  live?: Row | null,
): Promise<Row> {
  const names = Array.isArray(benchmark) ? benchmark : [benchmark];
  if (
    !names.length ||
    names.length > 6 ||
    new Set(names).size !== names.length ||
    names.some((name) => !benchmarks[name])
  )
    throw new Error("Choose one to six distinct available benchmarks.");
  if (
    names.some(
      (name) =>
        (role === "India") !==
        ["Nifty 50", "Nifty Bank", "Sensex", "Nifty MidSmallCap 400"].includes(
          name,
        ),
    )
  )
    throw new Error("Choose benchmarks in the same market and currency.");
  const symbol = benchmarks[names[0]];
  const held = comparisonHoldings(role, live);
  if (!held.rows.length)
    throw new Error("No holdings with positive quantities are available.");
  const symbols = [
      ...new Set([
        ...held.rows.map((h) => h.symbol),
        ...names.map((name) => benchmarks[name]),
      ]),
    ],
    series = await concurrent(symbols, 5, async (s) => ({
      symbol: s,
      ...(await insightHistory(s, period)),
    })),
    maps = new Map(
      series.map((s) => [
        s.symbol,
        new Map(s.bars.map((b) => [b.date, b.close])),
      ]),
    ),
    dates = [...maps.get(symbol)!.keys()]
      .filter((d) => symbols.every((s) => maps.get(s)!.has(d)))
      .sort();
  if (dates.length < 2)
    throw new Error("At least two common price dates are required.");
  const basket = (d: string) =>
      held.rows.reduce((n, h) => n + h.qty * maps.get(h.symbol)!.get(d)!, 0),
    start = basket(dates[0]),
    curve = dates.map((date) => ({
      date,
      "Current holdings basket": (basket(date) / start) * 100,
      ...Object.fromEntries(
        names.map((name) => [
          name,
          (maps.get(benchmarks[name])!.get(date)! /
            maps.get(benchmarks[name])!.get(dates[0])!) *
            100,
        ]),
      ),
    }));
  const saved = portfolios(),
    facts: Row[] =
      role === "India"
        ? (indiaSnapshot().holdings ?? [])
        : role === "long_term"
          ? (saved.us.report ?? [])
          : [];
  const insights = comparisonInsights(
    held.rows,
    dates,
    maps,
    names,
    benchmarks,
    facts,
  );
  const candidates: Row[] =
    role === "long_term"
      ? (saved.us.picks ?? [])
          .filter((row: Row) => row.long_term_eligible === true)
          .slice(0, 8)
      : [];
  insights.candidates = await concurrent(candidates, 3, async (row) => {
    try {
      const data = await insightHistory(row.symbol, period);
      const metric = riskMetrics(data.bars.map((bar) => bar.close));
      return {
        symbol: row.symbol,
        ...metric,
        revenue_growth_pct: row.revenue_growth_pct,
        earnings_growth_pct: row.earnings_growth_pct,
        free_cash_flow: row.free_cash_flow,
        quality_review: row.long_term_reasons,
        financial_period: row.financial_period,
        financial_fetched_at: row.financial_fetched_at,
        price_source: data.source,
        start_date: data.bars[0]?.date,
        end_date: data.bars.at(-1)?.date,
        review_priority:
          "Research candidate · verify latest filings and allocation",
      };
    } catch {
      return {
        symbol: row.symbol,
        review_priority: "Price evidence unavailable",
        quality_review: row.long_term_reasons,
      };
    }
  });
  return {
    insights,
    scope: role === "India" ? "India" : scope(roles()[role]),
    holdings: held.rows,
    role,
    benchmark: names[0],
    benchmarks: names,
    period,
    updated_at: new Date().toISOString(),
    curve,
    sources: series.map((s) => ({
      symbol: s.symbol,
      source: s.source,
      adjustment: s.adjustment,
    })),
  };
}
const definitions = [
  {
    code: "IND",
    name: "India",
    ticker: "^NSEI",
    benchmark: "Nifty 50",
    exchange: "NSE" as const,
    education_url:
      "https://investor.sebi.gov.in/investment_risk_managment.html",
  },
  {
    code: "US",
    name: "US",
    ticker: "^GSPC",
    benchmark: "S&P 500",
    exchange: "NYSE" as const,
    education_url:
      "https://www.investor.gov/introduction-investing/getting-started/asset-allocation",
  },
];
export const indexCatalog = Object.entries(benchmarks).map(
  ([name, ticker]) => ({
    name,
    ticker,
    region: [
      "Nifty 50",
      "Nifty Bank",
      "Sensex",
      "Nifty MidSmallCap 400",
    ].includes(name)
      ? "India"
      : "US",
  }),
);
for (const entry of indexCatalog)
  if (!definitions.some((market) => market.benchmark === entry.name)) {
    const base = definitions.find((market) => market.name === entry.region)!;
    definitions.push({ ...base, ticker: entry.ticker, benchmark: entry.name });
  }
const marketFile = (market: (typeof definitions)[number]) =>
  ["Nifty 50", "S&P 500"].includes(market.benchmark)
    ? "daily_market_briefing.json"
    : `daily_market_briefing_${market.ticker.replace(/[^A-Z0-9]/gi, "")}.json`;
export class DailyMarkets {
  private states = new Map<
    string,
    {
      key: string;
      attempted: number;
      pending: boolean;
      report: Row | null;
      error?: string;
    }
  >(
    definitions.map((m) => [
      m.benchmark,
      { key: "", attempted: 0, pending: false, report: null },
    ]),
  );
  constructor() {
    for (const market of definitions) {
      const state = this.states.get(market.benchmark)!;
      try {
        state.report = store.json<Row | null>(
          join(market.code === "IND" ? INDIA : US, marketFile(market)),
          null,
        );
      } catch (error) {
        state.error = errorMessage(error);
      }
    }
  }
  snapshot(now = Date.now(), selected = ["Nifty 50", "S&P 500"]): Row[] {
    return definitions
      .filter((market) => selected.includes(market.benchmark))
      .map((m) => {
        const s = this.states.get(m.benchmark)!,
          sessionPhase = phase(now, m.exchange),
          key =
            localDay(now, m.exchange) +
            ":" +
            (sessionPhase === "After market close");
        if (
          !s.pending &&
          (s.key !== key ||
            ((s.error || s.report?.stale) && now - s.attempted >= 300000))
        ) {
          s.key = key;
          s.attempted = now;
          s.pending = true;
          void this.load(m, now)
            .then((report) => {
              s.report = report;
              s.error = undefined;
            })
            .catch((e) => {
              s.error = errorMessage(e);
            })
            .finally(() => {
              s.pending = false;
            });
        }
        const report = s.report,
          theme = report
            ? report.stale || report.briefing_date !== localDay(now, m.exchange)
              ? "stale"
              : report.theme
            : "unavailable";
        return {
          code: m.code,
          name: m.name,
          benchmark: m.benchmark,
          theme,
          phase: sessionPhase,
          pending: s.pending,
          error: s.error,
          report: report ?? {},
          history: report?.history ?? [],
          education_url: m.education_url,
          reflection: {
            opening:
              theme === "bullish"
                ? "Let the opening confirm momentum; avoid chasing."
                : theme === "bearish"
                  ? "Protect capital and follow your risk plan."
                  : "Wait for clear, current signals before deciding.",
            closing:
              "Review what worked, check your risk, and carry the lessons forward.",
          },
        };
      });
  }
  private async load(
    m: (typeof definitions)[number],
    now: number,
  ): Promise<Row> {
    const expected = completedDay(now, m.exchange),
      h = await history(m.ticker, "1y"),
      bars = h.bars.filter((b) => b.date <= expected);
    if (bars.length < 50)
      throw new Error("At least fifty completed daily prices are required.");
    const current = bars.at(-1)!,
      previous = bars.at(-2)!,
      average = bars.slice(-50).reduce((n, b) => n + b.close, 0) / 50;
    const report = {
      theme:
        current.close > average
          ? "bullish"
          : current.close < average
            ? "bearish"
            : "mixed",
      price: current.close,
      change_pct: (current.close / previous.close - 1) * 100,
      sma50: average,
      distance_pct: (current.close / average - 1) * 100,
      date: current.date,
      expected_date: expected,
      generated_at: new Date(now).toISOString(),
      briefing_date: localDay(now, m.exchange),
      stale: current.date < expected,
      source: h.source,
      history: bars.slice(-60).map((b) => ({ date: b.date, value: b.close })),
    };
    store.save(join(m.code === "IND" ? INDIA : US, marketFile(m)), report);
    return report;
  }
}

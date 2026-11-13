import { Decimal } from "decimal.js";
import { validateBudget } from "./accounts.js";
import type { Row } from "../shared/storage.js";

export const GEMS_PLAN_RULES = {
  max_stocks: 8,
  max_stock_pct: 12.5,
  max_sector_pct: 30,
  review_days: 90,
} as const;
export function reviewCurrent(
  review: Row | undefined,
  now = Date.now(),
): boolean {
  const age = now - Date.parse(review?.reviewed_at);
  return (
    review?.acknowledged === true &&
    age >= 0 &&
    age < GEMS_PLAN_RULES.review_days * 86400000 &&
    ["policy_notes", "management_notes", "vision_notes"].every(
      (key) =>
        typeof review[key] === "string" && review[key].trim().length >= 20,
    ) &&
    Array.isArray(review.source_urls) &&
    review.source_urls.length > 0 &&
    review.source_urls.every((url: unknown) => {
      try {
        return typeof url === "string" && new URL(url).protocol === "https:";
      } catch {
        return false;
      }
    })
  );
}

// Model targets for a dedicated Gems allocation; existing holdings are not trade instructions.
export function gemsPlan(
  rows: Row[],
  budget: number,
  reserve: number,
  reviews: Record<string, Row> = {},
  now = Date.now(),
  startedAt = now,
): Row {
  validateBudget(budget, reserve);
  const cents = (value: number) =>
    new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_DOWN).toNumber();
  const age = now - Date.parse(rows[0]?.scanned_at),
    fresh = age >= 0 && age < 86400000,
    cap = Decimal.min(
      new Decimal(budget).times(GEMS_PLAN_RULES.max_stock_pct).div(100),
      new Decimal(budget)
        .times(new Decimal(100).minus(reserve))
        .div(100)
        .div(GEMS_PLAN_RULES.max_stocks),
    )
      .toDecimalPlaces(2, Decimal.ROUND_DOWN)
      .toNumber(),
    sectorTotals = new Map<string, number>(),
    seen = new Set<string>(),
    picks: Row[] = [];
  for (const row of fresh ? rows : []) {
    const rowAge = now - Date.parse(row.scanned_at);
    if (
      row.gems_version !== 2 ||
      row.gems_candidate !== true ||
      !Number.isFinite(rowAge) ||
      rowAge < 0 ||
      rowAge >= 86400000 ||
      !/^[A-Z0-9-]+$/.test(row.symbol) ||
      seen.has(row.symbol) ||
      !row.sector ||
      typeof row.price !== "number" ||
      !Number.isFinite(row.price) ||
      row.price <= 0 ||
      row.price_currency !== "USD" ||
      cap <= 0
    )
      continue;
    const sectorTotal = sectorTotals.get(row.sector) ?? 0;
    if (
      sectorTotal + cap >
      (budget * GEMS_PLAN_RULES.max_sector_pct) / 100 + 1e-8
    )
      continue;
    const reviewed = reviewCurrent(reviews[row.symbol], now);
    const initial = cents(cap * 0.4),
      second = cents(cap * 0.3),
      final = cents(new Decimal(cap).minus(initial).minus(second).toNumber());
    picks.push({
      symbol: row.symbol,
      sector: row.sector,
      price: row.price,
      price_date: row.price_date,
      target_usd: cap,
      target_weight_pct: (cap / budget) * 100,
      suggested_shares: new Decimal(cap)
        .div(row.price)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN)
        .toNumber(),
      initial_usd: initial,
      after_30_days_usd: second,
      after_60_days_usd: final,
      ready_initial_usd: reviewed ? initial : 0,
      qualitative_status: reviewed
        ? "REVIEWED — investor attestation"
        : "REVIEW REQUIRED",
      review_due: reviewed
        ? new Date(
            Date.parse(reviews[row.symbol].reviewed_at) +
              GEMS_PLAN_RULES.review_days * 86400000,
          ).toISOString()
        : null,
      review_sources: reviewed
        ? reviews[row.symbol].source_urls.join(" | ")
        : null,
    });
    seen.add(row.symbol);
    sectorTotals.set(row.sector, sectorTotal + cap);
    if (picks.length === GEMS_PLAN_RULES.max_stocks) break;
  }
  const invested = new Decimal(cap).times(picks.length).toNumber();
  return {
    strategy: "gems",
    horizon: "3–5 years",
    budget,
    reserve_pct: reserve,
    rules: GEMS_PLAN_RULES,
    generated_at: new Date(now).toISOString(),
    scan_as_of: rows[0]?.scanned_at ?? null,
    scan_current: fresh,
    picks,
    proposed_investment_usd: invested,
    target_cash_usd: cents(new Decimal(budget).minus(invested).toNumber()),
    ready_initial_usd: cents(
      Decimal.sum(0, ...picks.map((row) => row.ready_initial_usd)).toNumber(),
    ),
    schedule: [
      {
        stage: "Initial 40%",
        earliest: new Date(startedAt).toISOString(),
        condition:
          "Current Gems screen and dated policy, management and vision review",
      },
      {
        stage: "Next 30%",
        earliest: new Date(startedAt + 30 * 86400000).toISOString(),
        condition:
          "Refresh the screen; add only if the thesis and valuation still qualify",
      },
      {
        stage: "Final 30%",
        earliest: new Date(startedAt + 60 * 86400000).toISOString(),
        condition: "Refresh again; retain cash when the thesis or screen fails",
      },
    ],
    review_policy:
      "Review filings each quarter and after material policy, governance or earnings events. Rebalance only for thesis changes or allocation drift of at least 5 percentage points; review taxes and costs. A failed technical screen pauses additions and is not an automatic sell.",
    message: !fresh
      ? "Refresh US Gems analysis before building current targets."
      : !picks.length
        ? "No candidates with current USD prices and sector evidence fit the allocation rules; retain cash."
        : "Model portfolio targets only. Compare with existing holdings before investing. Unreviewed candidates have no ready initial allocation; no orders are created.",
  };
}

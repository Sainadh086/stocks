import { execution } from "./orb.js";
import type { Row } from "../shared/storage.js";

export const ENTRY_QUALITY_RULES = {
  min_net_reward_risk: 1,
  cost_stress_multiplier: 2,
  india_round_trip_cost_pct: 0.4,
} as const;

// A target is a scenario, not a forecast. Reject setups whose apparent edge is consumed by costs.
export function entryQuality(
  market: "US" | "India",
  price: number,
  stop: number,
  target: number,
  quote: Row = {},
): Row {
  const invalid = {
    eligible: false,
    reason: "Valid entry, stop and target prices are required.",
    net_reward_risk: null,
    stressed_reward_risk: null,
    risk_per_share: null,
    estimated_round_trip_cost_pct: null,
  };
  if (
    ![price, stop, target].every(Number.isFinite) ||
    !(stop > 0 && price > stop && target > price)
  )
    return invalid;
  const bid = Number(quote.bid_price),
    ask = Number(quote.ask_price);
  if (
    (quote.bid_price != null || quote.ask_price != null) &&
    !([bid, ask].every(Number.isFinite) && bid > 0 && ask >= bid)
  )
    return invalid;
  const modeledCost =
    market === "US"
      ? execution(price, 1, "BUY").total_cost +
        Math.max(
          execution(stop, 1, "SELL").total_cost,
          execution(target, 1, "SELL").total_cost,
        )
      : (price * ENTRY_QUALITY_RULES.india_round_trip_cost_pct) / 100;
  const cost = Math.max(modeledCost, ask >= bid && bid > 0 ? ask - bid : 0),
    risk = price - stop + cost,
    reward = target - price - cost,
    ratio = reward / risk,
    stressed =
      (target - price - cost * ENTRY_QUALITY_RULES.cost_stress_multiplier) /
      (price - stop + cost * ENTRY_QUALITY_RULES.cost_stress_multiplier),
    eligible = ratio >= ENTRY_QUALITY_RULES.min_net_reward_risk && stressed > 0;
  return {
    eligible,
    reason: eligible
      ? null
      : "Reward after estimated costs is below 1× risk, or the target has no positive reward at doubled costs; wait for a better setup.",
    net_reward_risk: ratio,
    stressed_reward_risk: stressed,
    risk_per_share: risk,
    estimated_round_trip_cost_pct: (cost / price) * 100,
  };
}

import type { Bar } from "../shared/prices.js";
import type { Row } from "../shared/storage.js";
import { intradayEntryCheck } from "./intraday.js";

export const ROTATION_STRATEGY = "intraday_rotation_v1";
export const MIN_STRENGTH_IMPROVEMENT = 0.25;

export function completedCandle(
  frame: Bar[] | undefined,
  now: number,
): Bar | undefined {
  let latest: Bar | undefined;
  for (const bar of frame ?? [])
    if (
      bar.kind !== "quote" &&
      bar.time + 300000 <= now &&
      (!latest || bar.time >= latest.time)
    )
      latest = bar;
  return latest;
}

// Live rotation can enter an established breakout throughout the session.
// The historical ORB paper/backtest strategy retains its first-breakout rule.
export function rotationEntryReady(
  frame: Bar[] | undefined,
  pick: Row,
  now: number,
  hours: [number, number],
): string | null {
  const candle = completedCandle(frame, now);
  if (
    !candle ||
    candle.time < hours[0] + 900000 ||
    now - (candle.time + 300000) >= 300000
  )
    return "Waiting for a current completed five-minute candle.";
  if (
    !(Number(pick.range_high) > Number(pick.range_low)) ||
    candle.close <= Number(pick.range_high)
  )
    return "Waiting for a completed close above the opening range.";
  return intradayEntryCheck(frame, pick, now, hours);
}

export function rotationStrength(
  frame: Bar[] | undefined,
  pick: Row | undefined,
  now: number,
): number | null {
  const candle = completedCandle(frame, now),
    high = Number(pick?.range_high);
  if (
    !candle ||
    now - (candle.time + 300000) >= 300000 ||
    !Number.isFinite(high) ||
    high <= 0
  )
    return null;
  return (candle.close / high - 1) * 100;
}

export function rotationRange(
  frame: Bar[] | undefined,
  hours: [number, number],
): Row | null {
  const opening = [0, 300000, 600000].map((offset) =>
    (frame ?? []).find(
      (b) => b.kind !== "quote" && b.time === hours[0] + offset,
    ),
  );
  if (opening.some((b) => !b)) return null;
  return {
    range_high: Math.max(...opening.map((b) => b!.high)),
    range_low: Math.min(...opening.map((b) => b!.low)),
  };
}

export class TradeDecisionChanged extends Error {}

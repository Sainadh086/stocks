import type { Bar } from "../shared/prices.js";
import type { Row } from "../shared/storage.js";

export const INTRADAY_RULES = {
  entry_cutoff_minutes: 15,
  risk_per_position_pct: 0.25,
  daily_loss_pct: 1,
  min_relative_volume: 1.5,
  max_spread_pct: 0.5,
  atr_multiple: 1.5,
} as const;
const below = (price: number, level: number) =>
  price < level - Math.max(1, Math.abs(level)) * 1e-10;

// Only regular-session, completed bars contribute to decisions. Sorting and
// deduplication prevent feed ordering or repeated candles from changing signals.
export function intradayBars(
  frame: Bar[] | undefined,
  now: number,
  open: number,
): Bar[] {
  return [
    ...new Map(
      (frame ?? [])
        .filter(
          (b) =>
            b.kind !== "quote" &&
            b.time >= open &&
            b.time + 300000 <= now &&
            [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
            b.low > 0 &&
            b.high >= Math.max(b.open, b.close, b.low) &&
            b.low <= Math.min(b.open, b.close) &&
            b.volume >= 0,
        )
        .map((b) => [b.time, b]),
    ).values(),
  ].sort((a, b) => a.time - b.time);
}

export function intradayIndicators(
  frame: Bar[] | undefined,
  now: number,
  open: number,
) {
  const bars = intradayBars(frame, now, open);
  let volume = 0,
    value = 0,
    ema = bars[0]?.close ?? 0;
  const ranges: number[] = [];
  bars.forEach((bar, i) => {
    volume += bar.volume;
    value += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    ema += (bar.close - ema) * (2 / 10);
    const previous = bars[i - 1]?.close ?? bar.open;
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous),
        Math.abs(bar.low - previous),
      ),
    );
  });
  return {
    bars,
    vwap: volume > 0 ? value / volume : null,
    ema9: bars.length ? ema : null,
    atr: ranges.length
      ? ranges.slice(-14).reduce((a, b) => a + b, 0) /
        Math.min(14, ranges.length)
      : null,
  };
}

export function intradayEntryCheck(
  frame: Bar[] | undefined,
  pick: Row,
  now: number,
  hours: [number, number],
): string | null {
  if (now >= hours[1] - INTRADAY_RULES.entry_cutoff_minutes * 60000)
    return "No new entries in the last 15 minutes of the session.";
  const data = intradayIndicators(frame, now, hours[0]),
    candle = data.bars.at(-1);
  if (
    !candle ||
    candle.volume <= 0 ||
    now - (candle.time + 300000) >= 300000 ||
    data.vwap == null ||
    data.ema9 == null ||
    !(data.atr! > 0)
  )
    return "Waiting for current completed OHLCV candles.";
  if (!(Number(pick.relative_volume) >= INTRADAY_RULES.min_relative_volume))
    return "Relative volume is below 1.5x.";
  if (below(candle.close, data.vwap))
    return "Waiting for a completed close at or above session VWAP.";
  if (below(candle.close, data.ema9))
    return "Waiting for a completed close at or above the 9-period EMA.";
  return null;
}

export function intradayQuoteCheck(
  quote: Row,
  frame: Bar[] | undefined,
  now: number,
  open: number,
): string | null {
  const data = intradayIndicators(frame, now, open),
    candle = data.bars.at(-1),
    price = Number(quote.last_trade_price);
  if (!candle || data.vwap == null || data.ema9 == null)
    return "Waiting for intraday indicators.";
  if (below(price, Math.max(data.vwap, data.ema9)))
    return "Current broker price is below VWAP or EMA confirmation.";
  const extension = Math.min(
    price * 0.015,
    Math.max(price * 0.005, (data.atr ?? 0) * 0.5),
  );
  if (price > candle.close + extension)
    return "Price has moved too far beyond the confirmed candle; waiting to avoid chasing.";
  if (quote.bid_price != null || quote.ask_price != null) {
    const bid = Number(quote.bid_price),
      ask = Number(quote.ask_price);
    if (!(bid > 0 && ask >= bid)) return "Waiting for a valid bid/ask spread.";
    if (((ask - bid) / ((ask + bid) / 2)) * 100 > INTRADAY_RULES.max_spread_pct)
      return "Bid/ask spread exceeds 0.5%; waiting for liquidity.";
  }
  return null;
}

export function intradayStop(
  frame: Bar[] | undefined,
  now: number,
  open: number,
  price: number,
  rangeLow: number,
): number {
  const atr = intradayIndicators(frame, now, open).atr;
  return atr != null && atr > 0
    ? Math.max(rangeLow, price - INTRADAY_RULES.atr_multiple * atr)
    : rangeLow;
}

export function protectedStop(
  frame: Bar[] | undefined,
  now: number,
  open: number,
  entry: number,
  stop: number,
  startedAt: number,
): number {
  const bars = intradayBars(frame, now, open).filter(
    (b) => b.time >= startedAt,
  );
  const risk = entry - stop;
  if (!(risk > 0) || !bars.some((b) => b.close >= entry + risk)) return stop;
  // Once a completed close reaches +1R, move to break-even and trail the
  // two-candle low. Recompute the high-water stop over all post-entry bars so
  // it cannot loosen when a later candle or an API restart arrives.
  let result = entry,
    activated = false;
  for (let i = 0; i < bars.length; i++) {
    activated ||= bars[i].close >= entry + risk;
    if (i > 0 && activated)
      result = Math.max(result, Math.min(bars[i - 1].low, bars[i].low));
  }
  return Math.max(stop, result);
}

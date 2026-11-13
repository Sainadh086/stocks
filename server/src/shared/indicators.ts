import type { Bar } from "./prices.js";
import type { Row } from "./storage.js";
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
const sma = (a: number[], n: number) =>
  a.length >= n ? mean(a.slice(-n)) : NaN;
function ema(a: number[], span: number, adjust = true): number {
  const alpha = 2 / (span + 1);
  if (!adjust) return a.reduce((v, n) => alpha * n + (1 - alpha) * v, a[0]);
  let numerator = 0,
    denominator = 0;
  for (const value of a) {
    numerator = value + (1 - alpha) * numerator;
    denominator = 1 + (1 - alpha) * denominator;
  }
  return numerator / denominator;
}
export function analyze(
  symbol: string,
  exchange: string,
  bars: Bar[],
): Row | null {
  if (bars.length < 200) return null;
  const closes = bars.map((b) => b.close),
    last = bars.at(-1)!,
    price = last.close;
  const deltas = closes.slice(1).map((p, i) => p - closes[i]);
  const recentCloses = closes.slice(-127),
    returns = recentCloses
      .slice(1)
      .map((p, i) => Math.log(p / recentCloses[i])),
    averageReturn = mean(returns),
    volatility =
      Math.sqrt(
        returns.reduce((sum, r) => sum + (r - averageReturn) ** 2, 0) /
          (returns.length - 1),
      ) *
      Math.sqrt(252) *
      100;
  let gain = Math.max(deltas[0], 0),
    loss = Math.max(-deltas[0], 0);
  for (const d of deltas.slice(1)) {
    gain = (gain * 13) / 14 + Math.max(d, 0) / 14;
    loss = (loss * 13) / 14 + Math.max(-d, 0) / 14;
  }
  const rsi = loss ? 100 - 100 / (1 + gain / loss) : NaN;
  const tr = bars.map((b, i) =>
    Math.max(
      b.high - b.low,
      i ? Math.abs(b.high - bars[i - 1].close) : 0,
      i ? Math.abs(b.low - bars[i - 1].close) : 0,
    ),
  );
  const s50 = sma(closes, 50),
    s200 = sma(closes, 200),
    e5 = ema(closes, 5),
    e10 = ema(closes, 10),
    e20 = ema(closes, 20),
    r20 = price / closes.at(-21)! - 1,
    r63 = price / closes.at(-64)! - 1,
    r126 = price / closes.at(-127)! - 1,
    atr = sma(tr, 14),
    vol =
      last.volume /
      sma(
        bars.map((b) => b.volume),
        20,
      );
  let score = 0;
  const strengths: string[] = [],
    warnings: string[] = [];
  const award = (pass: boolean, points: number, label?: string) => {
    if (pass) {
      score += points;
      if (label) strengths.push(label);
    }
  };
  award(price > s200, 10, "Above 200 SMA");
  award(s50 > s200, 10, "50 SMA > 200 SMA");
  award(price > s50, 10, "Above 50 SMA");
  award(e20 > s50, 10, "20 EMA > 50 SMA");
  if (price > e5 && e5 > e10 && e10 > e20)
    award(true, 20, "Strong short-term trend");
  else award(price > e20, 10);
  award(r20 > 0.08, 10, "Strong 1M return");
  if (r20 > 0 && r20 <= 0.08) score += 5;
  award(r63 > 0.15, 10, "Strong 3M return");
  if (r63 > 0 && r63 <= 0.15) score += 5;
  award(rsi >= 55 && rsi <= 75, 10, "Healthy RSI");
  if (rsi >= 45 && rsi < 55) score += 5;
  award(vol >= 1.5, 10, "Strong volume");
  if (vol >= 1 && vol < 1.5) score += 5;
  for (const [average, label] of [
    [e5, "Below 5 EMA"],
    [e10, "Below 10 EMA"],
    [e20, "Below 20 EMA"],
    [s50, "BELOW 50 SMA"],
    [s200, "BELOW 200 SMA"],
  ] as const)
    if (price < average) warnings.push(label);
  if (rsi < 45) warnings.push("Weak RSI");
  if (r20 < 0) warnings.push("Negative 1M momentum");
  const action =
    score < 60 || price < s200
      ? "REPLACE"
      : price < s50
        ? "WATCH"
        : score >= 80
          ? "STRONG HOLD"
          : score >= 70
            ? "HOLD"
            : "WATCH";
  return {
    symbol,
    exchange,
    price,
    price_date: last.date,
    volatility_6m_pct: Number.isFinite(volatility) ? volatility : null,
    momentum_score: score,
    action,
    return_1m_pct: r20 * 100,
    return_3m_pct: r63 * 100,
    return_6m_pct: r126 * 100,
    rsi: Number.isFinite(rsi) ? rsi : null,
    ema20: e20,
    sma50: s50,
    sma200: s200,
    atr,
    risk_level: price - 3 * atr,
    warnings: warnings.join(" | "),
    strengths: strengths.join(" | "),
  };
}
export function potential(r: Row): Row {
  const values = [
    "price",
    "sma50",
    "sma200",
    "return_1m_pct",
    "return_3m_pct",
    "return_6m_pct",
    "rsi",
  ];
  if (values.some((k) => typeof r[k] !== "number" || !Number.isFinite(r[k])))
    return {
      potential: "UNKNOWN",
      potential_reasons: "Insufficient indicator data",
    };
  const trend = r.price > r.sma50 && r.sma50 > r.sma200,
    positive = [r.return_1m_pct, r.return_3m_pct, r.return_6m_pct].filter(
      (n) => n > 0,
    ).length,
    healthy = r.rsi >= 50 && r.rsi <= 70,
    signals = Number(trend) + positive + Number(healthy);
  return {
    potential:
      trend && r.return_6m_pct > 0 && signals >= 4
        ? "HIGH"
        : signals >= 3
          ? "MODERATE"
          : "LOW",
    potential_reasons: [
      trend ? "price > 50 SMA > 200 SMA" : "",
      positive ? "Positive returns" : "",
      healthy ? "RSI 50-70" : "",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

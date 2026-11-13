/** Deterministic tabular Q-learning allocation policy. No broker access. */
import { store } from "../shared/storage.js";
import type { Bars } from "./orb.js";

export const RL_VERSION = "portfolio_q_v1";
export const EXPOSURES = [0, 0.5, 1] as const;
export interface Policy {
  version: typeof RL_VERSION;
  trained_until: number;
  interval_ms: 300000;
  epochs: number;
  seed: number;
  cost_bps: number;
  q: Record<string, number[]>;
  visits: Record<string, number[]>;
}
export interface Allocation {
  state: string;
  action: number | null;
  exposure: number;
  weights: Record<string, number>;
  reason: string;
}
export function validatePolicy(value: unknown): Policy {
  const p = value as Policy;
  if (
    !p ||
    p.version !== RL_VERSION ||
    p.interval_ms !== 300000 ||
    !Number.isFinite(p.trained_until) ||
    !Number.isInteger(p.epochs) ||
    p.epochs < 1 ||
    !Number.isInteger(p.seed) ||
    !Number.isFinite(p.cost_bps) ||
    p.cost_bps < 0 ||
    p.cost_bps >= 1000 ||
    !p.q ||
    !p.visits ||
    typeof p.q !== "object" ||
    typeof p.visits !== "object"
  )
    throw new Error("Invalid RL policy metadata.");
  for (const [key, values] of Object.entries(p.q)) {
    const visits = p.visits[key];
    if (
      !Array.isArray(values) ||
      values.length !== 3 ||
      !values.every(Number.isFinite) ||
      !Array.isArray(visits) ||
      visits.length !== 3 ||
      !visits.every((n) => Number.isInteger(n) && n >= 0)
    )
      throw new Error("Invalid RL policy table.");
  }
  return p;
}
export function configuredPolicy(): Policy | undefined {
  const path = process.env.RL_MODEL_PATH;
  return path ? validatePolicy(store.json<unknown>(path, null)) : undefined;
}
function features(bars: Bars, now: number, symbols = Object.keys(bars)) {
  return symbols
    .flatMap((symbol) => {
      const source = bars[symbol] ?? [];
      // Frames are chronological. Find the last completed timestamp without
      // rescanning months of candles on every decision.
      let low = 0,
        high = source.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (source[mid].time + 300000 <= now) low = mid + 1;
        else high = mid;
      }
      const frame = [];
      for (let i = low - 1; i >= 0 && frame.length < 21; i--)
        if (source[i].kind !== "quote") frame.push(source[i]);
      frame.reverse();
      if (frame.length < 21 || now - frame.at(-1)!.time > 600000) return [];
      const prices = frame.map((b) => b.close);
      if (!prices.every((p) => Number.isFinite(p) && p > 0)) return [];
      const returns = prices.slice(1).map((p, i) => p / prices[i] - 1);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const volatility = Math.sqrt(
        returns.reduce((n, r) => n + (r - mean) ** 2, 0) / returns.length,
      );
      return [{ symbol, momentum: prices.at(-1)! / prices[0] - 1, volatility }];
    })
    .sort(
      (a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol),
    );
}
export function observation(
  bars: Bars,
  now: number,
  cashFraction: number,
  drawdown: number,
  symbols?: string[],
) {
  return encodeObservation(
    features(bars, now, symbols).slice(0, 4),
    cashFraction,
    drawdown,
  );
}
function encodeObservation(
  assets: ReturnType<typeof features>,
  cashFraction: number,
  drawdown: number,
) {
  const trend = assets.length
    ? assets.reduce((n, a) => n + a.momentum, 0) / assets.length
    : 0;
  const vol = assets.length
    ? assets.reduce((n, a) => n + a.volatility, 0) / assets.length
    : 0;
  const state = [
    trend < -0.005 ? 0 : trend > 0.005 ? 2 : 1,
    vol > 0.005 ? 1 : 0,
    drawdown >= 0.01 ? 1 : 0,
    cashFraction >= 0.75 ? 2 : cashFraction >= 0.25 ? 1 : 0,
  ].join(":");
  return { state, assets };
}
function weights(
  assets: ReturnType<typeof features>,
  exposure: number,
): Record<string, number> {
  // Four equal slots cap each symbol at 25%; unused slots stay in cash.
  return Object.fromEntries(assets.map((a) => [a.symbol, exposure / 4]));
}
export function allocate(
  policy: Policy,
  bars: Bars,
  now: number,
  cashFraction: number,
  drawdown: number,
  symbols?: string[],
): Allocation {
  const { state, assets } = observation(
    bars,
    now,
    cashFraction,
    drawdown,
    symbols,
  );
  if (now <= policy.trained_until)
    return {
      state,
      action: null,
      exposure: 0,
      weights: {},
      reason: "RL training overlaps decision time; entries blocked.",
    };
  const q = policy.q[state],
    visits = policy.visits[state];
  if (!assets.length || !q || !visits || visits.some((n) => n < 5))
    return {
      state,
      action: null,
      exposure: 0,
      weights: {},
      reason:
        "RL state lacks training coverage; entries blocked, existing risk exits retained.",
    };
  const action = q.indexOf(Math.max(...q));
  return {
    state,
    action,
    exposure: EXPOSURES[action],
    weights: weights(assets, EXPOSURES[action]),
    reason: `RL allocation: ${EXPOSURES[action] * 100}% of deployable capital (${state}).`,
  };
}
interface Wallet {
  cash: number;
  units: Record<string, number>;
  peak: number;
}
function value(wallet: Wallet, prices: Record<string, number>): number {
  return (
    wallet.cash +
    Object.entries(wallet.units).reduce((n, [s, q]) => n + q * prices[s], 0)
  );
}
function rebalance(
  wallet: Wallet,
  prices: Record<string, number>,
  target: Record<string, number>,
  costBps: number,
) {
  const equity = value(wallet, prices),
    fee = costBps / 10000;
  let turnover = 0;
  for (const s of Object.keys(wallet.units)) {
    const sell = Math.max(
      0,
      wallet.units[s] - (equity * (target[s] ?? 0)) / prices[s],
    );
    wallet.units[s] -= sell;
    wallet.cash += sell * prices[s] * (1 - fee);
    turnover += sell * prices[s];
  }
  for (const [s, weight] of Object.entries(target)) {
    const buy = Math.max(
      0,
      Math.min(
        (equity * weight) / prices[s] - (wallet.units[s] ?? 0),
        wallet.cash / (prices[s] * (1 + fee)),
      ),
    );
    wallet.units[s] = (wallet.units[s] ?? 0) + buy;
    wallet.cash -= buy * prices[s] * (1 + fee);
    turnover += buy * prices[s];
  }
  return turnover;
}
export function trainPortfolio(bars: Bars, epochs = 40, seed = 17) {
  if (
    !Number.isInteger(epochs) ||
    epochs < 1 ||
    epochs > 1000 ||
    !Number.isInteger(seed)
  )
    throw new Error("RL training needs 1–1000 epochs and an integer seed.");
  const symbols = Object.keys(bars).sort();
  if (!symbols.length) throw new Error("RL training requires stock bars.");
  for (const frame of Object.values(bars)) {
    const candles = frame.filter((b) => b.kind !== "quote");
    for (let i = 0; i < candles.length; i++) {
      const b = candles[i],
        previous = candles[i - 1];
      if (
        !Number.isFinite(b.time) ||
        ![b.open, b.high, b.low, b.close].every(
          (p) => Number.isFinite(p) && p > 0,
        ) ||
        (previous &&
          (b.time <= previous.time ||
            (b.date === previous.date &&
              (b.time - previous.time) % 300000 !== 0)))
      )
        throw new Error(
          "RL requires ordered, valid five-minute stock candles.",
        );
    }
    if (
      !candles.some((b, i) => i > 0 && b.time - candles[i - 1].time === 300000)
    )
      throw new Error("RL requires five-minute data, not daily candles.");
  }
  const maps = Object.fromEntries(
    symbols.map((s) => [
      s,
      new Map(
        bars[s].filter((b) => b.kind !== "quote").map((b) => [b.time, b]),
      ),
    ]),
  );
  const times = [...maps[symbols[0]].keys()]
    .sort((a, b) => a - b)
    .filter((t) => symbols.every((s) => maps[s].has(t)));
  const days = [
    ...new Set(times.map((t) => maps[symbols[0]].get(t)!.date)),
  ].sort();
  if (days.length < 10 || times.length < 100)
    throw new Error(
      "RL needs at least 10 sessions and 100 aligned five-minute bars.",
    );
  const boundary = days[Math.floor(days.length * 0.7)];
  const trainTimes = times.filter(
    (t) => maps[symbols[0]].get(t)!.date < boundary,
  );
  const testTimes = times.filter(
    (t) => maps[symbols[0]].get(t)!.date >= boundary,
  );
  const policy: Policy = {
    version: RL_VERSION,
    trained_until: trainTimes.at(-1)! + 300000,
    interval_ms: 300000,
    epochs,
    seed,
    cost_bps: 8,
    q: {},
    visits: {},
  };
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const pricesAt = (t: number, field: "open" | "close") =>
    Object.fromEntries(symbols.map((s) => [s, maps[s].get(t)![field]]));
  const featureCache = new Map<number, ReturnType<typeof features>>();
  const observed = (t: number, cashFraction: number, drawdown: number) => {
    let assets = featureCache.get(t);
    if (!assets) {
      assets = features(bars, t).slice(0, 4);
      featureCache.set(t, assets);
    }
    return encodeObservation(assets, cashFraction, drawdown);
  };
  const run = (
    ticks: number[],
    learning: boolean,
    costMultiplier = 1,
    baseline = false,
  ) => {
    const wallet: Wallet = { cash: 10000, units: {}, peak: 10000 };
    let maxDrawdown = 0,
      totalTurnover = 0,
      previousEquity = 10000;
    const curve: { time: number; equity: number; cash: number }[] = [];
    for (let i = learning ? 21 : 0; i < ticks.length; i++) {
      const t = ticks[i],
        open = pricesAt(t, "open"),
        close = pricesAt(t, "close");
      const before = value(wallet, open);
      const drawdown = Math.max(0, 1 - before / wallet.peak);
      const obs = observed(t, wallet.cash / before, drawdown);
      if (learning) {
        policy.q[obs.state] ??= [0, 0, 0];
        policy.visits[obs.state] ??= [0, 0, 0];
      }
      const q = policy.q[obs.state];
      const covered = policy.visits[obs.state]?.every((n) => n >= 5);
      let action = baseline
        ? 2
        : learning
          ? random() < 0.2
            ? Math.floor(random() * 3)
            : q.indexOf(Math.max(...q))
          : covered
            ? q.indexOf(Math.max(...q))
            : 0;
      const last =
        i === ticks.length - 1 ||
        maps[symbols[0]].get(ticks[i + 1])!.date !==
          maps[symbols[0]].get(t)!.date;
      if (last) action = 0;
      totalTurnover += rebalance(
        wallet,
        open,
        last ? {} : weights(obs.assets, EXPOSURES[action] * 0.9),
        policy.cost_bps * costMultiplier,
      );
      const after = value(wallet, close);
      wallet.peak = Math.max(wallet.peak, after);
      maxDrawdown = Math.max(maxDrawdown, 1 - after / wallet.peak);
      if (learning) {
        const reward =
          (after - previousEquity) / previousEquity -
          0.25 * Math.max(0, 1 - after / wallet.peak) -
          0.0001 * EXPOSURES[action];
        const next = observed(
          t + 300000,
          wallet.cash / after,
          1 - after / wallet.peak,
        ).state;
        const future = last ? 0 : Math.max(...(policy.q[next] ?? [0, 0, 0]));
        q[action] += 0.1 * (reward + 0.95 * future - q[action]);
        policy.visits[obs.state][action]++;
      }
      previousEquity = after;
      curve.push({ time: t + 300000, equity: after, cash: wallet.cash });
    }
    return {
      initial_equity: 10000,
      final_equity: curve.at(-1)?.equity ?? 10000,
      max_drawdown_pct: maxDrawdown * 100,
      turnover_usd: totalTurnover,
      curve,
    };
  };
  for (let epoch = 0; epoch < epochs; epoch++) run(trainTimes, true);
  const frozen = JSON.stringify(policy);
  const heldOut = run(testTimes, false),
    stressed = run(testTimes, false, 2),
    baseline = run(testTimes, false, 1, true);
  // Evaluation must never change the learned policy.
  const trained = validatePolicy(JSON.parse(frozen));
  return {
    policy: trained,
    report: {
      strategy: RL_VERSION,
      live_ready: false,
      train_sessions: days.filter((d) => d < boundary).length,
      held_out_start: boundary,
      held_out: heldOut,
      double_cost: stressed,
      equal_weight_baseline: baseline,
      limitations: [
        "Allocation research model; ORB entry gates and stop sizing are applied separately at execution.",
        "Aligned five-minute bars only; current-universe survivorship bias may remain.",
        "Held-out evaluation is never used for policy updates.",
      ],
    },
  };
}

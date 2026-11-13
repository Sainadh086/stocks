import { createHash } from "node:crypto";
import { join } from "node:path";
import { store, US, type Row } from "./shared/storage.js";

export const learningFile = join(US, "learning_journal.json");
export interface LearningContext {
  market: "US" | "India";
  horizon: "trading" | "long_term";
  broker: string;
  scope: string;
  paper?: boolean;
}
export const learningScope = (identity: string) =>
  createHash("sha256").update(identity).digest("hex").slice(0, 20);
export const learningBucket = (ctx: LearningContext) =>
  [
    ctx.paper ? "paper" : "live",
    ctx.market,
    ctx.horizon,
    ctx.broker,
    ctx.scope,
  ].join(":");
const numeric = (v: unknown): number | null => {
  if (
    (typeof v !== "string" && typeof v !== "number") ||
    String(v).trim() === ""
  )
    return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const load = (): Row =>
  store.json(learningFile, {
    version: 1,
    contexts: {},
    orders: {},
    observations: {},
    policies: {},
  });
let captureError: string | null = null;
export function learningState(row: Row): string {
  const trend = numeric(
      row.return_3m_pct ?? row.momentum_pct ?? row.revenue_cagr_pct,
    ),
    vol = numeric(row.volatility_6m_pct ?? row.volatility_pct),
    rsi = numeric(row.rsi);
  return [
    trend == null
      ? "trend_unknown"
      : trend > 0
        ? "up"
        : trend < 0
          ? "down"
          : "flat",
    vol == null
      ? "vol_unknown"
      : vol > (row.intraday ? 1 : 30)
        ? "volatile"
        : "calm",
    rsi == null
      ? "rsi_unknown"
      : rsi >= 65
        ? "extended"
        : rsi < 35
          ? "weak"
          : "balanced",
  ].join("/");
}
export function marketObservation(
  frame: Row[] | undefined,
  now: number,
): Row | null {
  const bars = (frame ?? [])
    .filter(
      (b) =>
        b.kind !== "quote" &&
        b.time + 300000 <= now &&
        Number.isFinite(b.close) &&
        b.close > 0,
    )
    .sort((a, b) => a.time - b.time)
    .slice(-21);
  if (bars.length < 4 || now - (bars.at(-1)!.time + 300000) >= 300000)
    return null;
  const changes = bars
      .slice(1)
      .map((b, i) => Math.log(b.close / bars[i].close)),
    mean = changes.reduce((s, n) => s + n, 0) / changes.length;
  return {
    momentum_pct: (bars.at(-1)!.close / bars[0].close - 1) * 100,
    volatility_pct:
      Math.sqrt(
        changes.reduce((s, n) => s + (n - mean) ** 2, 0) / changes.length,
      ) * 100,
    intraday: true,
  };
}
function register(state: Row, ctx: LearningContext) {
  const bucket = learningBucket(ctx);
  if (ctx.broker !== "research" && !ctx.paper) {
    state.active ??= {};
    state.active[`${ctx.market}:${ctx.horizon}`] = bucket;
  }
  state.contexts[bucket] = {
    ...ctx,
    bucket,
    label: `${ctx.paper ? "Paper · " : ""}${ctx.market} ${ctx.horizon === "trading" ? "trading" : "long term"} · ${ctx.broker} · ${ctx.scope.slice(0, 6)}`,
  };
  return bucket;
}
export function researchLearningContext(
  fallback: LearningContext,
): LearningContext {
  if (fallback.broker !== "research") return fallback;
  try {
    const state = load();
    return (
      state.contexts[
        state.active?.[`${fallback.market}:${fallback.horizon}`]
      ] ?? fallback
    );
  } catch {
    return fallback;
  }
}
// Capture failures are visible in the advisor and cannot interrupt broker reconciliation or protective exits.
function capture(action: (state: Row) => boolean): void {
  try {
    const state = load();
    if (action(state)) store.save(learningFile, state);
    captureError = null;
  } catch (error) {
    captureError =
      error instanceof Error
        ? error.message
        : "Learning journal capture failed";
  }
}
export function rememberLearning(
  ctx: LearningContext,
  strategy: string,
  rows: Row[],
  now = Date.now(),
): void {
  capture((state) => {
    const bucket = register(state, ctx);
    for (const row of rows) {
      if (!row.symbol) continue;
      const key = `${bucket}:${strategy}:${row.symbol}`,
        prior = state.observations[key] ?? [];
      if (prior.at(-1)?.observed_at === now) continue;
      prior.push({
        observed_at: now,
        state: learningState(row),
        strategy,
        symbol: row.symbol,
        reason:
          row.gems_reasons ??
          row.reason ??
          row.strengths ??
          "Strategy observation",
        features: {
          momentum_pct:
            row.momentum_pct ?? row.return_3m_pct ?? row.revenue_cagr_pct,
          volatility_pct: row.volatility_pct ?? row.volatility_6m_pct,
          rsi: row.rsi,
          gems_score: row.gems_score,
          net_reward_risk: row.net_reward_risk,
        },
      });
      // Filled orders retain their entry observation permanently; this only bounds unfilled research snapshots.
      state.observations[key] = prior
        .filter((p: Row) => now - p.observed_at < 90 * 86400000)
        .slice(-100);
    }
    return true;
  });
}
function observationAt(
  state: Row,
  bucket: string,
  strategy: string,
  symbol: string,
  time: number,
  horizon: string,
): Row | null {
  return (
    [
      bucket,
      ...Object.values<Row>(state.contexts)
        .filter(
          (ctx) =>
            ctx.broker === "research" &&
            ctx.market === state.contexts[bucket]?.market &&
            ctx.horizon === horizon,
        )
        .map((ctx) => ctx.bucket),
    ]
      .flatMap(
        (key) => state.observations[`${key}:${strategy}:${symbol}`] ?? [],
      )
      .filter(
        (o: Row) =>
          o.observed_at <= time &&
          time - o.observed_at <= (horizon === "trading" ? 120000 : 86400000),
      )
      .sort((a: Row, b: Row) => a.observed_at - b.observed_at)
      .at(-1) ?? null
  );
}
function timestamp(value: unknown, market: string): number {
  if (typeof value !== "string" || !value) return NaN;
  return Date.parse(
    /[Zz]|[+-]\d\d:\d\d$/.test(value)
      ? value
      : market === "India"
        ? value.replace(" ", "T") + "+05:30"
        : "",
  );
}
export function recordLearningOrders(
  ctx: LearningContext,
  orders: Row[],
  tickets: Row[] = [],
  now = Date.now(),
): void {
  capture((state) => {
    let changed = !state.contexts[learningBucket(ctx)];
    const affected = new Set<string>();
    register(state, ctx);
    for (const raw of orders) {
      const id = raw.id ?? raw.order_id,
        symbol = String(raw.symbol ?? raw.tradingsymbol ?? "")
          .replaceAll(".", "-")
          .toUpperCase(),
        side = String(raw.side ?? raw.transaction_type ?? "").toLowerCase();
      if (
        !id ||
        !/^[A-Z0-9&-]+$/.test(symbol) ||
        !["buy", "sell"].includes(side)
      )
        continue;
      const horizon =
          typeof raw.intraday === "boolean"
            ? raw.intraday
              ? "trading"
              : "long_term"
            : raw.product
              ? raw.product === "MIS"
                ? "trading"
                : "long_term"
              : ctx.horizon,
        actual = { ...ctx, horizon } as LearningContext,
        bucket = register(state, actual),
        key = [
          ctx.paper ? "paper" : "live",
          ctx.market,
          ctx.broker,
          ctx.scope,
          id,
        ].join(":"),
        old = state.orders[key],
        ticket = tickets.find(
          (t) =>
            (t.result?.order?.id ?? t.order_id) === id ||
            (raw.reference && t.reference === raw.reference),
        ),
        status = String(raw.state ?? raw.status ?? "unknown").toLowerCase(),
        filled = ["filled", "complete", "completed", "executed"].includes(
          status,
        ),
        executions: Row[] = Array.isArray(raw.executions) ? raw.executions : [],
        executionQty = executions.reduce(
          (sum, e) => sum + (numeric(e.quantity) ?? 0),
          0,
        ),
        quantity =
          numeric(raw.filled_quantity ?? raw.cumulative_quantity) ??
          (executionQty > 0
            ? executionQty
            : filled
              ? numeric(raw.quantity)
              : 0) ??
          0,
        price =
          numeric(
            raw.average_price ??
              raw.average_execution_price ??
              raw.executed_price,
          ) ??
          (executionQty > 0
            ? executions.reduce(
                (sum, e) =>
                  sum + (numeric(e.quantity) ?? 0) * (numeric(e.price) ?? 0),
                0,
              ) / executionQty
            : numeric(raw.fill_price)),
        times = executions
          .map((e) => timestamp(e.timestamp, ctx.market))
          .filter(Number.isFinite),
        time = times.length
          ? Math.min(...times)
          : timestamp(
              raw.filled_at ??
                raw.executed_at ??
                raw.exchange_update_timestamp ??
                raw.order_timestamp ??
                raw.created_at,
              ctx.market,
            ),
        strategy =
          old?.strategy && old.strategy !== "unattributed"
            ? old.strategy
            : (ticket?.strategy ?? "unattributed"),
        observation =
          old?.entry_observation ??
          (Number.isFinite(time)
            ? observationAt(state, bucket, strategy, symbol, time, horizon)
            : null),
        fees = numeric(raw.fees ?? raw.total_fees),
        row = {
          key,
          bucket: old?.bucket ?? bucket,
          order_id: String(id),
          symbol,
          side,
          status,
          quantity: Math.max(old?.quantity ?? 0, quantity),
          price: price != null && price > 0 ? price : (old?.price ?? null),
          filled_at:
            Number.isFinite(time) && time <= now
              ? new Date(time).toISOString()
              : (old?.filled_at ?? null),
          fees: fees != null && fees >= 0 ? fees : (old?.fees ?? null),
          strategy,
          reason:
            ticket?.reason ??
            ticket?.learning_reason ??
            old?.reason ??
            "Broker order; strategy attribution needed",
          entry_observation: observation,
          source: raw.source ?? "broker",
          first_seen: old?.first_seen ?? new Date(now).toISOString(),
          terminal:
            filled ||
            ["cancelled", "canceled", "rejected", "expired", "voided"].includes(
              status,
            ),
        };
      if (old && quantity < old.quantity) continue;
      if (old?.terminal && !row.terminal) {
        row.terminal = true;
        row.status = old.status;
      }
      if (
        old &&
        JSON.stringify(row) === JSON.stringify({ ...old, revisions: undefined })
      )
        continue;
      state.orders[key] = {
        ...row,
        revisions: [
          ...(old?.revisions ?? []),
          {
            observed_at: new Date(now).toISOString(),
            quantity: row.quantity,
            price: row.price,
            status,
            fees: row.fees,
          },
        ],
      };
      changed = true;
      affected.add(row.bucket);
    }
    for (const bucket of affected)
      state.policies[bucket] = trainSelection(
        learningEpisodes(
          Object.values<Row>(state.orders).filter(
            (o: any) => o.bucket === bucket,
          ),
          state.contexts[bucket],
        ).episodes,
        now,
      );
    return changed;
  });
}
export function learningEpisodes(
  orders: Row[],
  ctx: LearningContext,
): { episodes: Row[]; unmatched: number } {
  const positions = new Map<string, Row>(),
    episodes: Row[] = [];
  let unmatched = 0;
  const cost = (o: Row) =>
    o.fees ?? o.quantity * o.price * (ctx.market === "India" ? 0.001 : 0.0001);
  for (const order of [...orders].sort(
    (a, b) =>
      Date.parse(a.filled_at) - Date.parse(b.filled_at) ||
      (a.side === b.side
        ? a.key.localeCompare(b.key)
        : a.side === "buy"
          ? -1
          : 1),
  )) {
    if (!(
      order.quantity > 0 &&
      order.price > 0 &&
      Number.isFinite(Date.parse(order.filled_at))
    ))
      continue;
    let position = positions.get(order.symbol);
    if (order.side === "buy") {
      if (!position || position.quantity <= 1e-8) {
        position = {
          first: order,
          quantity: 0,
          invested: 0,
          proceeds: 0,
          costs: 0,
          reported: true,
          terminal: true,
          strategy: order.strategy,
          timing_complete: true,
        };
        positions.set(order.symbol, position);
      }
      position.quantity += order.quantity;
      position.invested += order.quantity * order.price;
      position.costs += cost(order);
      position.terminal &&= order.terminal;
      position.reported &&= order.fees != null;
      if (order.strategy !== position.strategy) position.strategy = "mixed";
      position.timing_complete &&= !(
        (order.revisions ?? []).filter(
          (r: Row, i: number, a: Row[]) =>
            r.quantity > 0 && (i === 0 || r.quantity > a[i - 1].quantity),
        ).length > 1
      );
      continue;
    }
    if (!position || position.quantity <= 1e-8) {
      unmatched++;
      continue;
    }
    const qty = Math.min(order.quantity, position.quantity);
    position.quantity -= qty;
    position.proceeds += qty * order.price;
    position.costs += (cost(order) * qty) / order.quantity;
    position.terminal &&= order.terminal;
    position.reported &&= order.fees != null;
    if (order.quantity - qty > 1e-8) {
      unmatched++;
      position.timing_complete = false;
    }
    if (position.quantity > 1e-8) continue;
    const entry = position.first,
      observation = entry.entry_observation,
      validContext =
        observation && observation.observed_at <= Date.parse(entry.filled_at),
      gross = position.proceeds - position.invested,
      net = gross - position.costs,
      eligible =
        !!validContext &&
        position.terminal &&
        position.timing_complete &&
        !["unattributed", "mixed"].includes(position.strategy) &&
        Date.parse(order.filled_at) > Date.parse(entry.filled_at);
    episodes.push({
      id: entry.key,
      symbol: entry.symbol,
      strategy: position.strategy,
      state: validContext ? observation.state : null,
      entry_time: entry.filled_at,
      exit_time: order.filled_at,
      gross_pnl: gross,
      net_pnl: net,
      costs: position.costs,
      net_return_pct: (net / position.invested) * 100,
      double_cost_return_pct:
        ((gross - 2 * position.costs) / position.invested) * 100,
      cost_status: position.reported
        ? "Reported fees"
        : "Estimated fee buffer included",
      source: entry.source,
      eligible,
      reason: eligible
        ? entry.reason
        : "Missing pre-entry context, mixed strategy, nonterminal order or incomplete partial-fill timing; excluded from training",
    });
  }
  return { episodes, unmatched };
}
function policyKey(episode: Row) {
  return `${episode.strategy}|${episode.state}`;
}
export function trainSelection(episodes: Row[], now = Date.now()): Row {
  const valid = episodes
      .filter(
        (e) =>
          e.eligible && e.source !== "manual" && Date.parse(e.exit_time) < now,
      )
      .sort((a, b) => Date.parse(a.exit_time) - Date.parse(b.exit_time)),
    split = Math.floor(valid.length * 0.7),
    testStart = Math.min(
      ...valid.slice(split).map((e) => Date.parse(e.entry_time)),
    ),
    train = valid
      .slice(0, split)
      .filter((e) => Date.parse(e.exit_time) < testStart),
    test = valid.slice(split),
    table: Record<string, Row> = {};
  for (const episode of train) {
    const cell = (table[policyKey(episode)] ??= {
      q_wait: 0,
      q_select: 0,
      count: 0,
    });
    const reward =
      episode.net_return_pct - Math.max(0, -episode.net_return_pct) * 0.5;
    cell.count++;
    cell.q_select += (reward - cell.q_select) / cell.count;
  }
  const ready = train.length >= 20 && test.length >= 10;
  let selected = 0,
    reward = 0,
    stressed = 0,
    supported = 0;
  for (const e of test) {
    const cell = table[policyKey(e)];
    if (!cell || cell.count < 5) continue;
    supported++;
    if (cell.q_select > cell.q_wait) {
      selected++;
      reward += e.net_return_pct;
      stressed += e.double_cost_return_pct;
    }
  }
  return {
    validated:
      ready &&
      supported >= 5 &&
      reward / test.length >
        test.reduce((sum, e) => sum + e.net_return_pct, 0) / test.length &&
      stressed > 0,
    version: 1,
    method: "One-step tabular Q-learning (contextual bandit), advisory only",
    ready,
    trained_at: new Date(now).toISOString(),
    trained_until: train.at(-1)?.exit_time ?? null,
    table,
    train_episodes: train.length,
    held_out_episodes: test.length,
    supported_held_out: supported,
    selected_held_out: selected,
    held_out_mean_return_pct: test.length ? reward / test.length : null,
    double_cost_mean_return_pct: test.length ? stressed / test.length : null,
    followed_strategy_mean_return_pct: test.length
      ? test.reduce((sum, e) => sum + e.net_return_pct, 0) / test.length
      : null,
    explanation:
      "Cash/wait reward is zero; select reward is realized return after reported fees or an explicit fee buffer, with a 50% extra penalty on losses. Split chronologically, purge overlapping training outcomes, freeze policy for evaluation. These are trade-normalized observed outcomes, not portfolio returns or proof of causality. Manual imports are journal-only.",
  };
}
function advice(
  policy: Row | undefined,
  strategy: string,
  observation: Row,
  now: number,
): Row {
  const state = learningState(observation),
    cell = policy?.table?.[`${strategy}|${state}`];
  if (
    !policy?.ready ||
    !cell ||
    cell.count < 5 ||
    !(Date.parse(policy.trained_until) < now)
  )
    return {
      learning_suggestion: "Evidence needed",
      learning_score: null,
      learning_adjustment: 0,
      learning_reason:
        "Needs at least 20 training episodes, 10 later evaluation episodes and 5 independent entries in this state. Existing strategy rules remain in control.",
    };
  return {
    learning_suggestion:
      cell.q_select > 0 ? "Consider for shortlist" : "Review / avoid adding",
    learning_score: cell.q_select,
    learning_adjustment: policy.validated
      ? Math.max(-5, Math.min(5, cell.q_select))
      : 0,
    learning_reason: `${cell.count} training entries in ${state}; learned downside-penalized return ${cell.q_select.toFixed(2)}%. Historical association, not a forecast; strategy and risk checks still apply.`,
  };
}
export function learningAdvisor(
  ctx: LearningContext,
  strategy: string,
  now = Date.now(),
): (observation: Row) => Row {
  try {
    const policy = load().policies[learningBucket(ctx)];
    return (observation) => advice(policy, strategy, observation, now);
  } catch {
    return () => ({
      learning_suggestion: "Unavailable",
      learning_score: null,
      learning_adjustment: 0,
      learning_reason:
        "Learning journal unavailable; existing strategy rules remain in control.",
    });
  }
}
export const learningAdvice = (
  ctx: LearningContext,
  strategy: string,
  observation: Row,
  now = Date.now(),
) => learningAdvisor(ctx, strategy, now)(observation);
export function recordPaperLearning(paper: Row): void {
  const context: LearningContext = {
    market: "US",
    horizon: "trading",
    broker: "paper",
    scope: "us-paper",
    paper: true,
  };
  const orders = (paper.fills ?? []).map((fill: Row, index: number) => ({
    id: `${paper.id}:${index}:${fill.trade_id}`,
    symbol: fill.symbol,
    side: String(fill.side).toLowerCase(),
    state: "filled",
    quantity: fill.quantity,
    average_price: fill.price,
    filled_at: fill.timestamp,
    fees: fill.fees,
    source: "paper",
  }));
  recordLearningOrders(
    context,
    orders,
    orders.map((order: Row, index: number) => ({
      order_id: order.id,
      strategy: paper.strategy ?? "orb_15m_v1",
      reason: paper.fills[index].reason,
    })),
  );
}
export function learningView(bucket?: string): Row {
  const state = load(),
    selected = bucket ?? Object.keys(state.contexts)[0],
    ctx = state.contexts[selected],
    orders: Row[] = Object.values<Row>(state.orders).filter(
      (o: any) => o.bucket === selected,
    ),
    { episodes, unmatched } = ctx
      ? learningEpisodes(orders, ctx)
      : { episodes: [], unmatched: 0 },
    insights: Row[] = [];
  if (unmatched)
    insights.push({
      finding: "Missing opening lots",
      evidence: `${unmatched} sell orders exceed recorded opening quantities; unmatched shares cannot produce training rewards.`,
    });
  const incomplete = episodes.filter((e) => !e.eligible).length;
  if (incomplete)
    insights.push({
      finding: "Incomplete strategy evidence",
      evidence: `${incomplete} closed entries have no valid pre-entry strategy context and are excluded from learning.`,
    });
  const costDrag = episodes.filter(
    (e) => e.gross_pnl > 0 && e.net_pnl <= 0,
  ).length;
  if (costDrag)
    insights.push({
      finding: "Costs consumed gains",
      evidence: `${costDrag} completed entries were positive before costs but non-positive after reported fees or the fee buffer.`,
    });
  for (const strategy of new Set(episodes.map((e) => e.strategy))) {
    const group = episodes.filter((e) => e.strategy === strategy),
      mean = group.reduce((sum, e) => sum + e.net_return_pct, 0) / group.length;
    if (group.length >= 5 && mean < 0)
      insights.push({
        finding: `${strategy}: negative observed average`,
        evidence: `${group.length} closed entries average ${mean.toFixed(2)}% after costs. Review market regime, exits and selection bias before changing the strategy.`,
      });
  }
  const policy = state.policies[selected] ?? null;
  if (
    policy?.ready &&
    policy.held_out_mean_return_pct <= policy.followed_strategy_mean_return_pct
  )
    insights.push({
      finding: "Learner has not beaten the observed strategy",
      evidence:
        "Held-out trade-normalized return does not exceed the followed-strategy baseline. Do not infer an improvement from training scores.",
    });
  return {
    contexts: Object.values(state.contexts),
    selected: selected ?? null,
    context: ctx ?? null,
    policy,
    orders: orders.sort(
      (a, b) => Date.parse(b.first_seen) - Date.parse(a.first_seen),
    ),
    episodes: episodes.reverse(),
    insights,
    error: captureError,
    coverage:
      "Captures orders and cumulative partial fills returned by connected broker refreshes, plus paper fills. Historical coverage depends on broker retention and sync access. External trades unavailable to the app cannot be reconstructed from holdings alone. Open, unresolved or unattributed trades are never treated as successful learning outcomes.",
  };
}
export function refreshLearning(bucket: string, now = Date.now()): Row {
  const state = load(),
    ctx = state.contexts[bucket];
  if (!ctx) throw new Error("Choose an available learning account.");
  const orders: Row[] = Object.values<Row>(state.orders).filter(
    (o: any) => o.bucket === bucket,
  );
  state.policies[bucket] = trainSelection(
    learningEpisodes(orders, ctx).episodes,
    now,
  );
  store.save(learningFile, state);
  return learningView(bucket);
}
export function attributeLearning(
  key: string,
  strategy: string,
  reason: string,
): Row {
  const state = load(),
    order = state.orders[key];
  if (!order) throw new Error("Trade record not found.");
  const ctx = state.contexts[order.bucket];
  order.strategy = strategy;
  order.reason = reason;
  order.entry_observation = observationAt(
    state,
    order.bucket,
    strategy,
    order.symbol,
    Date.parse(order.filled_at),
    ctx.horizon,
  );
  state.policies[order.bucket] = null;
  store.save(learningFile, state);
  return learningView(order.bucket);
}

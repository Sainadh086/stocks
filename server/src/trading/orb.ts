import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { localDay, session, type Exchange } from "../shared/calendar.js";
import { store, US, type Row } from "../shared/storage.js";
import type { Bar } from "../shared/prices.js";
import { validateBudget } from "../brokers/accounts.js";
import { allocate, type Policy } from "./rl.js";
export const STRATEGY = "orb_15m_v1";
export const DEFAULT_COSTS = { fee_bps: 1, spread_bps: 5, slippage_bps: 2 };
export type Bars = Record<string, Bar[]>;
export function execution(
  reference: number,
  quantity: number,
  side: "BUY" | "SELL",
  costs = DEFAULT_COSTS,
): Row {
  if (
    !Number.isFinite(reference) ||
    reference <= 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    Object.values(costs).some((n) => !Number.isFinite(n) || n < 0 || n >= 1000)
  )
    throw new Error("Paper fill prices, quantities and costs are invalid.");
  const direction = side === "BUY" ? 1 : -1,
    spread_cost = (reference * quantity * costs.spread_bps) / 20000,
    slippage_cost = (reference * quantity * costs.slippage_bps) / 10000,
    price =
      reference *
      (1 + (direction * (costs.spread_bps / 2 + costs.slippage_bps)) / 10000),
    value = price * quantity,
    fee = (value * costs.fee_bps) / 10000;
  return {
    price,
    value,
    fee,
    spread_cost,
    slippage_cost,
    total_cost: fee + spread_cost + slippage_cost,
    reference_price: reference,
  };
}
export const equity = (s: Row): number =>
  s.cash +
  Object.values(s.positions as Record<string, Row>).reduce(
    (n, p) => n + p.quantity * p.price,
    0,
  );
export function upgrade(account: Row): Row {
  const s = structuredClone(account);
  if (s.journal_version === 2) return s;
  Object.assign(s, {
    journal_version: 2,
    closed_trades: s.closed_trades ?? [],
    equity_history: s.equity_history ?? [],
    simulated_costs: s.simulated_costs ?? 0,
    cost_model: s.cost_model ?? DEFAULT_COSTS,
    journal_started_at: s.journal_started_at ?? new Date().toISOString(),
    equity_peak: s.equity_peak ?? s.budget,
    max_drawdown_usd: s.max_drawdown_usd ?? 0,
    max_drawdown_pct: s.max_drawdown_pct ?? 0,
  });
  for (const p of Object.values(s.positions as Record<string, Row>)) {
    Object.assign(p, {
      trade_id: p.trade_id ?? randomUUID(),
      entry_reason:
        p.entry_reason ?? "Imported holding; original entry unavailable",
      entry_time: p.entry_time ?? null,
      entry_reference_price: p.entry_reference_price ?? p.cost / p.quantity,
      entry_price: p.entry_price ?? p.cost / p.quantity,
      entry_costs: p.entry_costs ?? 0,
      entry_fees: p.entry_fees ?? 0,
      stop: p.stop ?? null,
      target: p.target ?? null,
      history_incomplete: true,
    });
  }
  return s;
}
export function mark(s: Row, time: number): void {
  const value = equity(s),
    peak = Math.max(s.equity_peak ?? s.budget, value),
    drawdown = Math.max(0, peak - value),
    pct = peak > 0 ? (drawdown / peak) * 100 : 0;
  Object.assign(s, {
    equity_peak: peak,
    drawdown_usd: drawdown,
    drawdown_pct: pct,
    max_drawdown_usd: Math.max(s.max_drawdown_usd ?? 0, drawdown),
    max_drawdown_pct: Math.max(s.max_drawdown_pct ?? 0, pct),
  });
  const point = {
    timestamp: new Date(time).toISOString(),
    equity: value,
    cash: s.cash,
    drawdown_usd: drawdown,
    drawdown_pct: pct,
    realized_pnl: s.realized_pnl ?? 0,
    simulated_costs: s.simulated_costs,
  };
  if (s.equity_history.at(-1)?.timestamp === point.timestamp)
    s.equity_history[s.equity_history.length - 1] = point;
  else s.equity_history.push(point);
}
export function buy(
  s: Row,
  symbol: string,
  reference: number,
  quantity: number,
  time: number,
  stop: number,
  target: number,
  metadata: Row = {},
): void {
  if (s.positions[symbol]) throw new Error("Paper position already exists.");
  const fill = execution(reference, quantity, "BUY", s.cost_model),
    cost = fill.value + fill.fee;
  if (
    cost > s.cash + 1e-8 ||
    !(0 < stop && stop < fill.price && fill.price < target)
  )
    throw new Error("Invalid paper budget or risk levels.");
  const trade_id = randomUUID(),
    timestamp = new Date(time).toISOString(),
    reason = "15-minute opening-range breakout";
  s.cash -= cost;
  s.simulated_costs += fill.total_cost;
  s.positions[symbol] = {
    quantity,
    cost,
    price: reference,
    entry_time: timestamp,
    entry_reason: reason,
    entry_price: fill.price,
    entry_reference_price: reference,
    entry_costs: fill.total_cost,
    entry_fees: fill.fee,
    stop,
    target,
    trade_id,
    quote_time: timestamp,
    planned_risk_usd: quantity * (fill.price - stop),
    ...metadata,
  };
  s.fills.push({
    timestamp,
    symbol,
    side: "BUY",
    quantity,
    price: fill.price,
    reference_price: reference,
    value: fill.value,
    fees: fill.fee,
    spread_cost: fill.spread_cost,
    slippage_cost: fill.slippage_cost,
    simulated_cost: fill.total_cost,
    reason,
    entry_reason: reason,
    stop,
    target,
    trade_id,
    realized_pnl: null,
  });
}
export function sell(
  s: Row,
  symbol: string,
  reference: number,
  time: number,
  reason: string,
  quantity = s.positions[symbol]?.quantity,
): void {
  const original = s.positions[symbol];
  if (
    !original ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > original.quantity
  )
    throw new Error("Invalid paper sale quantity.");
  const fraction = quantity / original.quantity;
  const p = {
      ...original,
      quantity,
      cost: original.cost * fraction,
      entry_costs: original.entry_costs * fraction,
      planned_risk_usd: original.planned_risk_usd * fraction,
    },
    fill = execution(reference, p.quantity, "SELL", s.cost_model),
    net = fill.value - fill.fee - p.cost,
    gross = p.quantity * (reference - p.entry_reference_price),
    timestamp = new Date(time).toISOString();
  s.cash += fill.value - fill.fee;
  s.realized_pnl = (s.realized_pnl ?? 0) + net;
  s.simulated_costs += fill.total_cost;
  s.closed_trades.push({
    trade_id: p.trade_id,
    symbol,
    quantity: p.quantity,
    entry_time: p.entry_time,
    exit_time: timestamp,
    entry_reason: p.entry_reason,
    exit_reason: reason,
    entry_price: p.entry_price,
    exit_price: fill.price,
    entry_reference_price: p.entry_reference_price,
    exit_reference_price: reference,
    stop: p.stop,
    target: p.target,
    gross_pnl: gross,
    realized_pnl: net,
    entry_costs: p.entry_costs,
    exit_costs: fill.total_cost,
    simulated_costs: p.entry_costs + fill.total_cost,
    risk_usd: p.planned_risk_usd,
    r_multiple: p.planned_risk_usd > 0 ? net / p.planned_risk_usd : null,
    history_incomplete: p.history_incomplete ?? false,
  });
  s.fills.push({
    timestamp,
    symbol,
    side: "SELL",
    quantity: p.quantity,
    price: fill.price,
    reference_price: reference,
    value: fill.value,
    realized_pnl: net,
    gross_pnl: gross,
    fees: fill.fee,
    spread_cost: fill.spread_cost,
    slippage_cost: fill.slippage_cost,
    simulated_cost: fill.total_cost,
    reason,
    entry_reason: p.entry_reason,
    stop: p.stop,
    target: p.target,
    trade_id: p.trade_id,
  });
  if (quantity === original.quantity) delete s.positions[symbol];
  else {
    original.quantity -= quantity;
    original.cost -= p.cost;
    original.entry_costs -= p.entry_costs;
    original.planned_risk_usd -= p.planned_risk_usd;
  }
}
function opening(bars: Bar[], day: string, exchange: Exchange): Bar[] {
  const hours = session(day, exchange);
  if (!hours) return [];
  const wanted = [hours[0], hours[0] + 300000, hours[0] + 600000];
  return wanted
    .map((t) => bars.find((b) => b.kind !== "quote" && b.time === t))
    .filter((b): b is Bar => !!b);
}
export function shortlist(
  bars: Bars,
  day: string,
  limit = 4,
  exchange: Exchange = "NYSE",
): Row[] {
  const result: Row[] = [];
  for (const [symbol, frame] of Object.entries(bars)) {
    const current = opening(frame, day, exchange);
    if (current.length !== 3) continue;
    const priorDays = [
        ...new Set(frame.map((b) => b.date).filter((d) => d < day)),
      ]
        .sort()
        .slice(-40),
      volumes = priorDays
        .map((d) => opening(frame, d, exchange))
        .filter((f) => f.length === 3)
        .slice(-20)
        .map((f) => f.reduce((n, b) => n + b.volume, 0));
    if (volumes.length < 10) continue;
    const baseline = volumes.reduce((n, v) => n + v, 0) / volumes.length,
      relative = current.reduce((n, b) => n + b.volume, 0) / baseline,
      high = Math.max(...current.map((b) => b.high)),
      low = Math.min(...current.map((b) => b.low));
    if (relative >= 1.5 && high > low)
      result.push({
        symbol,
        range_high: high,
        range_low: low,
        relative_volume: relative,
        baseline_sessions: volumes.length,
      });
  }
  return result
    .sort(
      (a, b) =>
        b.relative_volume - a.relative_volume ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, limit);
}
export function entryReady(
  frame: Bar[] | undefined,
  pick: Row,
  now: number,
  hours: [number, number],
): string | null {
  const current = (frame ?? []).filter(
      (b) => b.time >= hours[0] && b.time <= now,
    ),
    last = current.at(-1),
    entryTime = hours[0] + Math.floor((now - hours[0]) / 300000) * 300000;
  const priorTime = entryTime - 300000,
    prior = current.find((b) => b.kind !== "quote" && b.time === priorTime),
    first = current.find(
      (b) =>
        b.kind !== "quote" &&
        b.time >= hours[0] + 900000 &&
        b.time + 300000 <= now &&
        b.close > pick.range_high,
    );
  if (first && first.time < priorTime)
    return "First breakout passed; no chasing missed entries.";
  if (prior && prior.close <= pick.range_high)
    return "Waiting for a completed close above the opening range.";
  if (
    current.length < 2 ||
    !last ||
    now - last.time < 0 ||
    now - last.time >= 60000 ||
    now - entryTime >= 60000
  )
    return "Waiting for a fresh 5-minute entry candle.";
  if (!prior || prior.close <= pick.range_high)
    return "Waiting for a completed close above the opening range.";
  return null;
}
export function step(
  account: Row,
  bars: Bars,
  now: number,
  ranked?: Row[],
  policy?: Policy,
): Row {
  const s = upgrade(account);
  if (s.status !== "Running") return s;
  const day = localDay(now, "NYSE"),
    hours = session(day);
  if (!hours || now < hours[0] || now >= hours[1]) {
    s.message = "Market closed; waiting for current session prices.";
    s.last_check = new Date(now).toISOString();
    return s;
  }
  if (s.day !== day) {
    s.day = day;
    s.day_start_equity = equity(s);
    s.traded_today = [];
    s.shortlist = [];
    s.shortlist_day = null;
  }
  if (now >= hours[0] + 900000) {
    s.shortlist = ranked ?? shortlist(bars, day);
    s.shortlist_day = day;
  }
  const cutoff = hours[1] - 300000;
  for (const [symbol, p] of Object.entries(
    s.positions as Record<string, Row>,
  )) {
    const frame = (bars[symbol] ?? []).filter(
        (b) => b.time >= hours[0] && b.time <= now,
      ),
      current = frame.at(-1);
    if (!current) continue;
    if (p.session_day !== day || p.stop == null) {
      sell(
        s,
        symbol,
        current.open,
        current.time,
        "Flatten carried or legacy holding",
      );
      continue;
    }
    const completed = frame.filter(
      (b) =>
        b.kind !== "quote" &&
        b.time + 300000 <= now &&
        b.time > Date.parse(p.entry_time) &&
        (!p.processed_bar || b.time > Date.parse(p.processed_bar)),
    );
    for (const b of completed) {
      p.price = b.close;
      p.quote_time = new Date(b.time + 300000).toISOString();
      p.processed_bar = new Date(b.time).toISOString();
      if (b.low <= p.stop) {
        sell(
          s,
          symbol,
          Math.min(b.open, p.stop),
          b.time + 300000,
          "Opening-range stop hit",
        );
        break;
      }
      if (b.high >= p.target) {
        sell(s, symbol, p.target, b.time + 300000, "2R target hit");
        break;
      }
    }
    if (
      s.positions[symbol] &&
      now >= cutoff &&
      current.time >= cutoff &&
      now - current.time < 300000
    )
      sell(s, symbol, current.open, current.time, "Scheduled session exit");
  }
  const value = equity(s),
    rl = policy
      ? allocate(
          policy,
          bars,
          now,
          s.cash / value,
          (s.drawdown_pct ?? 0) / 100,
          [
            ...new Set([
              ...(s.shortlist ?? []).map((p: Row) => p.symbol),
              ...Object.keys(s.positions),
            ]),
          ],
        )
      : undefined,
    lossBlocked = value <= s.day_start_equity * 0.99;
  s.rl = rl ?? null;
  if (rl?.action != null && now < cutoff) {
    for (const [symbol, p] of Object.entries(
      s.positions as Record<string, Row>,
    )) {
      const b = bars[symbol]?.filter((b) => b.time <= now).at(-1);
      if (!b || now - b.time >= 60000) continue;
      p.price = b.open;
      const targetValue =
        value * (1 - s.reserve_pct / 100) * (rl.weights[symbol] ?? 0);
      const excess = p.quantity - targetValue / b.open;
      if (excess * b.open > Math.max(1, value * 0.01))
        sell(s, symbol, b.open, now, rl.reason, Math.min(p.quantity, excess));
    }
  }
  if (!lossBlocked && now >= hours[0] + 1200000 && now < cutoff) {
    for (const pick of s.shortlist ?? []) {
      const symbol = pick.symbol;
      if (
        Object.keys(s.positions).length >= 4 ||
        s.positions[symbol] ||
        s.traded_today.includes(symbol) ||
        entryReady(bars[symbol], pick, now, hours) ||
        (rl && (!rl.weights[symbol] || rl.action == null))
      )
        continue;
      const b = bars[symbol].filter((b) => b.time <= now).at(-1)!,
        entry = execution(b.open, 1, "BUY", s.cost_model),
        exit = execution(pick.range_low, 1, "SELL", s.cost_model);
      if (entry.price <= pick.range_low) continue;
      const risk = entry.value + entry.fee - exit.value + exit.fee,
        available = Math.max(0, s.cash - (value * s.reserve_pct) / 100),
        qty =
          Math.floor(
            Math.min(
              (value * 0.0025) / risk,
              available / (entry.value + entry.fee),
              (value *
                (1 - s.reserve_pct / 100) *
                (rl ? (rl.weights[symbol] ?? 0) : 0.25)) /
                (entry.value + entry.fee),
            ) * 1000,
          ) / 1000;
      if (qty <= 0) continue;
      buy(
        s,
        symbol,
        b.open,
        qty,
        b.time,
        pick.range_low,
        entry.price + 2 * (entry.price - pick.range_low),
        { session_day: day, relative_volume: pick.relative_volume },
      );
      s.traded_today.push(symbol);
    }
  }
  mark(s, now);
  s.last_check = new Date(now).toISOString();
  s.strategy = STRATEGY;
  s.message = lossBlocked
    ? "Daily loss limit reached; monitoring exits."
    : (rl?.reason ?? "Monitoring opening-range breakouts, stops and targets.");
  s.decisions = (s.shortlist ?? []).map((pick: Row) => {
    const reason = s.positions[pick.symbol]
      ? "Monitoring opening-range stop and 2R target."
      : s.traded_today.includes(pick.symbol)
        ? "Already traded this stock today."
        : lossBlocked
          ? "Daily loss limit reached."
          : now < hours[0] + 1200000 || now >= cutoff
            ? "Outside the intraday entry window."
            : (entryReady(bars[pick.symbol], pick, now, hours) ??
              (rl && !rl.weights[pick.symbol] ? rl.reason : null) ??
              "Entry signal eligible; checking available paper cash and position limits.");
    return {
      ...pick,
      action: s.positions[pick.symbol] ? "HOLD" : "WAIT",
      reason,
    };
  });
  s.revision = (s.revision ?? 0) + 1;
  return s;
}
export const paperPath = join(US, "paper_account.json");
export function paper(): Row | null {
  const state = store.json<Row | null>(paperPath, null);
  return state ? upgrade(state) : null;
}
export function control(action: string, budget: number, reserve: number): Row {
  validateBudget(budget, reserve);
  let s = paper();
  if (action === "start") {
    if (s && s.status !== "Ended")
      throw new Error(
        "End the existing paper session before starting another.",
      );
    s = upgrade({
      id: randomUUID(),
      status: "Running",
      budget,
      reserve_pct: reserve,
      cash: budget,
      realized_pnl: 0,
      positions: {},
      fills: [],
      message: "Paper session started; no real orders are placed.",
      last_check: null,
      started_at: new Date().toISOString(),
      strategy: STRATEGY,
      revision: 0,
    });
  } else {
    if (!s) throw new Error("Start a paper session first.");
    if (action === "resume" && s.status === "Ended")
      throw new Error("An ended paper session cannot resume.");
    s.status =
      action === "pause" ? "Paused" : action === "resume" ? "Running" : "Ended";
    s.message =
      action === "end"
        ? "Session ended; open simulated positions remain visible."
        : `Paper session ${s.status.toLowerCase()}.`;
  }
  store.save(paperPath, s);
  return s!;
}

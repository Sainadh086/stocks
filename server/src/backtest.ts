/** Offline replay. No broker modules or network calls are reachable from this CLI. */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { store, type Row } from "./shared/storage.js";
import { localDay, session } from "./shared/calendar.js";
import type { Bar } from "./shared/prices.js";
import { analyze } from "./shared/indicators.js";
import { trainPortfolio } from "./trading/rl.js";
import {
  step,
  upgrade,
  equity,
  DEFAULT_COSTS,
  STRATEGY,
  type Bars,
} from "./trading/orb.js";
export function newAccount(multiplier = 1): Row {
  return upgrade({
    status: "Running",
    budget: 10000,
    reserve_pct: 10,
    cash: 10000,
    positions: {},
    fills: [],
    realized_pnl: 0,
    cost_model: Object.fromEntries(
      Object.entries(DEFAULT_COSTS).map(([k, v]) => [k, v * multiplier]),
    ),
  });
}
export function summary(s: Row): Row {
  const trades: Row[] = s.closed_trades,
    wins = trades.filter((t) => t.realized_pnl > 0),
    losses = trades.filter((t) => t.realized_pnl < 0);
  return {
    initial_equity: s.budget,
    final_equity: equity(s),
    net_pnl: equity(s) - s.budget,
    realized_pnl: s.realized_pnl,
    simulated_costs: s.simulated_costs,
    max_drawdown_pct: s.max_drawdown_pct,
    max_drawdown_usd: s.max_drawdown_usd,
    closed_trades: trades.length,
    win_rate_pct: trades.length ? (wins.length / trades.length) * 100 : null,
    profit_factor: losses.length
      ? wins.reduce((n, t) => n + t.realized_pnl, 0) /
        Math.abs(losses.reduce((n, t) => n + t.realized_pnl, 0))
      : null,
  };
}
export function replay(
  bars: Bars,
  days: string[],
  multiplier = 1,
): { state: Row; incomplete: string[] } {
  let state = newAccount(multiplier);
  const incomplete: string[] = [];
  for (const day of days) {
    const hours = session(day);
    if (!hours) continue;
    for (let now = hours[0]; now < hours[1]; now += 300000) {
      const visible = Object.fromEntries(
        Object.entries(bars)
          .filter(([s]) => s !== "QQQ")
          .map(([s, b]) => [s, b.filter((bar) => bar.time <= now)]),
      );
      state = step(state, visible, now);
    }
    if (Object.keys(state.positions).length) incomplete.push(day);
  }
  return { state, incomplete };
}
export function evaluateOrb(bars: Bars): {
  report: Row;
  states: Record<string, Row>;
} {
  const coverage = bars.QQQ ?? Object.values(bars)[0];
  if (!coverage?.length) throw new Error("Input contains no bars.");
  const allDays = [
      ...new Set(Object.values(bars).flatMap((b) => b.map((r) => r.date))),
    ]
      .sort()
      .filter((d) => session(d)),
    incomplete = allDays.filter((d) => {
      const h = session(d)!;
      return !coverage.some((b) => b.time >= h[1] - 300000 && b.time < h[1]);
    }),
    dates = allDays.filter((d) => !incomplete.includes(d)).slice(20);
  if (dates.length < 10)
    throw new Error(
      "Need 20 warmup and at least 10 complete evaluation sessions.",
    );
  const split = Math.floor(dates.length * 0.7),
    results: Row = {},
    states: Record<string, Row> = {};
  for (const [label, days] of [
    ["development", dates.slice(0, split)],
    ["held_out", dates.slice(split)],
  ] as const) {
    for (const multiplier of [1, 2]) {
      const key = `${label}_cost_${multiplier}x`,
        out = replay(bars, days, multiplier);
      states[key] = out.state;
      results[key] = {
        start: days[0],
        end: days.at(-1),
        sessions: days.length,
        incomplete_exit_sessions: out.incomplete,
        ...summary(out.state),
      };
    }
  }
  return {
    report: {
      strategy: STRATEGY,
      costs: DEFAULT_COSTS,
      universe: Object.keys(bars)
        .filter((s) => s !== "QQQ")
        .sort(),
      excluded_incomplete_sessions: incomplete,
      live_ready: false,
      limitations: [
        "Current-universe survivorship bias unless data uses historical constituents.",
        "Five-minute ambiguous candles use stop first.",
        "Held-out results must not be used to tune the strategy.",
      ],
      results,
    },
    states,
  };
}
export function simulateMomentum(
  bars: Bars,
  benchmark: string,
  costBps = 0,
  budget = 100000,
): Row {
  const index = bars[benchmark];
  if (
    !index ||
    index.length < 202 ||
    !Number.isFinite(costBps) ||
    costBps < 0 ||
    costBps >= 1000
  )
    throw new Error(
      "Momentum replay requires benchmark warmup and valid costs.",
    );
  const curve: Row[] = [],
    trades: Row[] = [],
    units: Record<string, number> = {},
    lastPrices: Record<string, number> = {};
  let cash = budget,
    lastMonth = "",
    totalCost = 0;
  for (const b of index.slice(200)) {
    const month = b.date.slice(0, 7);
    if (month !== lastMonth) {
      const candidates = Object.entries(bars)
          .filter(([s]) => s !== benchmark)
          .map(([symbol, frame]) => {
            const previous = frame.filter((p) => p.time < b.time),
              execution = frame.find((p) => p.time === b.time),
              analysis = analyze(symbol, "NSE", previous);
            return { symbol, execution, analysis };
          })
          .filter(
            (r) =>
              r.execution &&
              r.analysis &&
              ["HOLD", "STRONG HOLD"].includes(r.analysis.action),
          )
          .sort(
            (a, b) =>
              b.analysis!.momentum_score - a.analysis!.momentum_score ||
              b.analysis!.return_6m_pct - a.analysis!.return_6m_pct ||
              a.symbol.localeCompare(b.symbol),
          )
          .slice(0, 8),
        locked = new Set(
          Object.keys(units).filter(
            (s) => !bars[s].some((p) => p.time === b.time),
          ),
        );
      for (const s of Object.keys(units)) {
        if (locked.has(s)) continue;
        const price = bars[s].find((p) => p.time === b.time)!.open,
          value = units[s] * price,
          fee = (value * costBps) / 10000;
        cash += value - fee;
        totalCost += fee;
        trades.push({
          date: b.date,
          symbol: s,
          side: "SELL",
          quantity: units[s],
          price,
          cost: fee,
        });
        delete units[s];
      }
      const allocation = candidates.length ? cash / candidates.length : 0;
      for (const c of candidates) {
        if (locked.has(c.symbol)) continue;
        const price = c.execution!.open,
          quantity = allocation / (price * (1 + costBps / 10000)),
          value = quantity * price,
          fee = (value * costBps) / 10000;
        units[c.symbol] = quantity;
        cash -= value + fee;
        totalCost += fee;
        trades.push({
          date: b.date,
          symbol: c.symbol,
          side: "BUY",
          quantity,
          price,
          cost: fee,
          signal_date: bars[c.symbol].filter((p) => p.time < b.time).at(-1)!
            .date,
        });
      }
      lastMonth = month;
    }
    for (const s of Object.keys(units)) {
      const current = bars[s].find((p) => p.time === b.time);
      if (current) lastPrices[s] = current.close;
      if (lastPrices[s] == null)
        throw new Error("Held position valuation unavailable.");
    }
    const value =
      cash +
      Object.entries(units).reduce((n, [s, q]) => n + q * lastPrices[s], 0);
    curve.push({
      date: b.date,
      equity: value,
      cash,
      benchmark: index[200].close
        ? (b.close / index[200].close) * budget
        : null,
    });
  }
  return {
    strategy: "monthly_momentum",
    live_ready: false,
    cost_bps: costBps,
    total_cost: totalCost,
    initial_equity: budget,
    final_equity: curve.at(-1)?.equity,
    curve,
    trades,
    limitations: [
      "Current constituents introduce survivorship bias.",
      "Signals use prior bars; executions require observed opens.",
    ],
  };
}
export function parseBars(rows: Row[], exchange: "NYSE" | "NSE"): Bars {
  const bars: Bars = {};
  for (const row of rows) {
    const time = Date.parse(row.timestamp ?? row.date),
      symbol = String(row.symbol ?? "");
    if (!symbol || !Number.isFinite(time))
      throw new Error("CSV needs symbol and timestamp columns.");
    const b: Bar = {
      time,
      date: localDay(time, exchange),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    };
    if (
      ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      Math.min(b.open, b.high, b.low, b.close) <= 0 ||
      b.volume < 0 ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close)
    )
      throw new Error("CSV contains invalid OHLCV bars.");
    (bars[symbol] ??= []).push(b);
  }
  for (const symbol of Object.keys(bars))
    bars[symbol] = [
      ...new Map(bars[symbol].map((b) => [b.time, b])).values(),
    ].sort((a, b) => a.time - b.time);
  return bars;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, input, output, benchmark] = process.argv.slice(2);
  if (!["orb", "momentum", "rl"].includes(mode) || !input || !output)
    throw new Error(
      "Usage: npm run backtest -- orb|momentum|rl input.csv output-directory [benchmark-symbol]",
    );
  const bars = parseBars(
    store.csv(resolve(input)),
    mode === "momentum" ? "NSE" : "NYSE",
  );
  if (mode === "rl") {
    const { policy, report } = trainPortfolio(bars);
    store.save(join(resolve(output), "policy.json"), policy);
    store.save(join(resolve(output), "report.json"), report);
  } else if (mode === "orb") {
    const { report, states } = evaluateOrb(bars);
    store.save(join(resolve(output), "report.json"), report);
    for (const [name, state] of Object.entries(states)) {
      store.save(join(resolve(output), name + ".json"), state);
      store.saveCsv(join(resolve(output), name + "_fills.csv"), state.fills);
    }
  } else {
    const result = simulateMomentum(bars, benchmark ?? "^NSEI");
    store.save(join(resolve(output), "report.json"), result);
    store.saveCsv(join(resolve(output), "equity_curve.csv"), result.curve);
    store.saveCsv(join(resolve(output), "trades.csv"), result.trades);
  }
  console.log(
    "Encrypted offline backtest results saved. No real orders were placed.",
  );
}

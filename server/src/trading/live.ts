import { join } from "node:path";
import { Decimal } from "decimal.js";
import { store, US, type Row } from "../shared/storage.js";
import { localDay, session, type Exchange } from "../shared/calendar.js";
import { history, concurrent } from "../shared/prices.js";
import { universe } from "../analysis.js";
import {
  ROTATION_STRATEGY,
  rotationEntryReady,
  rotationStrength,
  rotationRange,
  MIN_STRENGTH_IMPROVEMENT,
} from "./rotation.js";
import { Watchlist } from "./watchlist.js";
import { MIN_DOLLAR_BUY } from "./order-limits.js";
import { entryQuality, ENTRY_QUALITY_RULES } from "./quality.js";
import {
  learningAdvisor,
  learningExecutionEnabled,
  learningScope,
  marketObservation,
} from "../learning.js";
import {
  INTRADAY_RULES,
  intradayIndicators,
  intradayQuoteCheck,
  intradayStop,
  protectedStop,
} from "./intraday.js";
import {
  STRATEGY,
  shortlist,
  entryReady,
  execution,
  type Bars,
} from "./orb.js";
import { allocate, configuredPolicy, type Policy } from "./rl.js";
export const active = new Set([
  "running",
  "waiting_sales",
  "waiting_buys",
  "waiting_funds",
]);
export interface Signals {
  policy?: Policy;
  candidates?: Row[];
  scan?: { phase: string; completed: number; total: number };
  strategy: string;
  ranked: Row[];
  bars: Bars;
  asof: string | null;
  fresh: boolean;
  message: string;
}
export class Feed {
  private readonly watchlist: Watchlist;
  constructor(
    private readonly sources = { history, universe, now: Date.now },
    private readonly exchange: Exchange = "NYSE",
  ) {
    this.watchlist = new Watchlist(rotationEntryReady, exchange);
  }
  private day = "";
  private scanCursor = 0;
  private baseline: Bars = {};
  private current: Signals = {
    strategy: ROTATION_STRATEGY,
    ranked: [],
    bars: {},
    asof: null,
    fresh: false,
    message: "Preparing intraday opening-range signals…",
    scan: { phase: "idle", completed: 0, total: 0 },
  };
  private pending: Promise<Signals> | null = null;
  snapshot(now = Date.now()): Signals {
    return {
      ...this.current,
      policy: learningExecutionEnabled() ? this.current.policy : undefined,
      fresh:
        this.current.fresh &&
        !!this.current.asof &&
        now - Date.parse(this.current.asof) >= 0 &&
        now - Date.parse(this.current.asof) <= 90000,
    };
  }
  refresh(
    held: string[] = [],
    now = Date.now(),
    protectedSymbols: string[] = [],
  ): Promise<Signals> {
    if (this.pending) return this.pending;
    this.pending = this.load(held, now, protectedSymbols).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async load(
    held: string[],
    now: number,
    protectedSymbols: string[],
  ): Promise<Signals> {
    const protectedSet = [...new Set([...held, ...protectedSymbols])];
    const day = localDay(now, this.exchange),
      hours = session(day, this.exchange);
    if (!hours || now < hours[0] || now >= hours[1]) {
      this.current = {
        ...this.current,
        fresh: false,
        message: "Market closed.",
        scan: { phase: "market_closed", completed: 0, total: 0 },
      };
      return this.snapshot(now);
    }
    try {
      if (this.day !== day) {
        this.current.message = "Loading stock universe…";
        this.current.scan = {
          phase: "loading_universe",
          completed: 0,
          total: 0,
        };
      }
      let symbols = [
        ...new Set([
          ...(this.day === day
            ? Object.keys(this.baseline)
            : await this.sources.universe(
                this.exchange === "NSE" ? "India" : "US",
              )),
          ...protectedSet,
        ]),
      ];
      if (this.day !== day) {
        let completed = 0;
        this.current = {
          ...this.current,
          fresh: false,
          message: `Loading opening-range history (0/${symbols.length} stocks)…`,
          scan: {
            phase: "loading_history",
            completed: 0,
            total: symbols.length,
          },
        };
        const frames = await concurrent(symbols, 6, async (symbol) => {
          try {
            return [
              symbol,
              (await this.sources.history(symbol, "60d", "5m", true, now)).bars,
            ] as const;
          } catch {
            return [symbol, []] as const;
          } finally {
            completed++;
            this.current.scan = {
              phase: "loading_history",
              completed,
              total: symbols.length,
            };
            this.current.message = `Loading opening-range history (${completed}/${symbols.length} stocks)…`;
          }
        });
        this.baseline = Object.fromEntries(
          frames.filter(([, bars]) => bars.length),
        );
        if (!Object.keys(this.baseline).length)
          throw new Error(
            "No opening-range history available. The stock universe will be retried.",
          );
        this.day = day;
      }
      // Once the opening ranges are known, poll only the shortlisted and held
      // stocks so a full-universe scan cannot consume the entry window.
      const ranked = this.watchlist.select(
        shortlist(this.baseline, day, Infinity, this.exchange),
        this.baseline,
        day,
        Math.max(now, this.sources.now()),
        protectedSet,
        false,
      );
      if (ranked.length)
        symbols = [
          ...new Set([...ranked.map((p) => p.symbol), ...protectedSet]),
        ];
      if (!ranked.length) {
        const available = Object.keys(this.baseline);
        const sweep = Array.from(
          { length: Math.min(12, available.length) },
          (_, i) => available[(this.scanCursor + i) % available.length],
        );
        this.scanCursor = available.length
          ? (this.scanCursor + sweep.length) % available.length
          : 0;
        symbols = [...new Set([...sweep, ...protectedSet])];
      }
      const scanTime = Math.max(now, this.sources.now());
      this.current.message = `Refreshing intraday prices for ${symbols.length} shortlisted or held stocks…`;
      let completedPrices = 0;
      this.current.scan = {
        phase: "refreshing_prices",
        completed: 0,
        total: symbols.length,
      };
      const fetchPrices = (wanted: string[]) =>
        concurrent(wanted, 6, async (symbol) => {
          try {
            const frame = await this.sources.history(
              symbol,
              "1d",
              "5m",
              true,
              Math.max(scanTime, this.sources.now()),
            );
            return [
              symbol,
              [
                ...frame.bars,
                ...(frame.latest_quote ? [frame.latest_quote] : []),
              ],
            ] as const;
          } catch {
            return [symbol, []] as const;
          } finally {
            completedPrices++;
            this.current.scan = {
              phase: "refreshing_prices",
              completed: completedPrices,
              total: symbols.length,
            };
          }
        });
      const frames = await fetchPrices(symbols),
        today = Object.fromEntries(frames.filter(([, bars]) => bars.length));
      if (!Object.keys(today).length)
        throw new Error("No current intraday data.");
      const observedAt = Math.max(scanTime, this.sources.now());
      const bars: Bars = {};
      for (const symbol of new Set([
        ...Object.keys(this.baseline),
        ...Object.keys(today),
      ])) {
        bars[symbol] = [
          ...new Map(
            [...(this.baseline[symbol] ?? []), ...(today[symbol] ?? [])]
              .filter((b) => b.time <= observedAt)
              .map((b) => [b.time, b]),
          ).values(),
        ].sort((a, b) => a.time - b.time);
      }
      this.baseline = Object.fromEntries(
        Object.entries(bars).map(([symbol, frame]) => [
          symbol,
          frame.filter((b) => b.kind !== "quote"),
        ]),
      );
      for (const symbol of held) {
        const stamp = bars[symbol]?.at(-1)?.time;
        if (stamp == null || observedAt - stamp > 600000)
          throw new Error(
            `Intraday data missing or stale for held stock ${symbol}.`,
          );
      }
      const selected = this.watchlist.select(
        shortlist(bars, day, Infinity, this.exchange),
        bars,
        day,
        observedAt,
        protectedSet,
      );
      // Rotation used to publish the next four symbols with yesterday's/old
      // intraday observations. Refresh newly selected symbols in this cycle.
      const missing = selected
        .map((p) => p.symbol)
        .filter((symbol) => !today[symbol]);
      if (missing.length) {
        symbols = [...new Set([...symbols, ...missing])];
        this.current.scan!.total = symbols.length;
        for (const [symbol, frame] of await fetchPrices(missing)) {
          if (!frame.length) continue;
          bars[symbol] = [
            ...new Map(
              [...(bars[symbol] ?? []), ...frame].map((b) => [b.time, b]),
            ).values(),
          ].sort((a, b) => a.time - b.time);
          this.baseline[symbol] = bars[symbol].filter(
            (b) => b.kind !== "quote",
          );
        }
      }
      const completedAt = this.sources.now();
      const pool = shortlist(bars, day, Infinity, this.exchange);
      for (const symbol of held) {
        const range = rotationRange(bars[symbol], hours);
        if (range && !pool.some((p) => p.symbol === symbol))
          pool.push({ symbol, ...range, relative_volume: 0 });
      }
      const candidates = pool
        .map((p): Row => ({
          ...p,
          rotation_score: rotationStrength(bars[p.symbol], p, completedAt),
        }))
        .sort(
          (a, b) =>
            (b.rotation_score ?? -Infinity) - (a.rotation_score ?? -Infinity) ||
            b.relative_volume - a.relative_volume,
        );
      this.current = {
        strategy: ROTATION_STRATEGY,
        policy:
          this.exchange === "NYSE" && learningExecutionEnabled()
            ? configuredPolicy()
            : undefined,
        scan: {
          phase: "ready",
          completed: symbols.length,
          total: symbols.length,
        },
        candidates,
        ranked: this.watchlist.select(
          candidates,
          bars,
          day,
          completedAt,
          protectedSet,
          false,
        ),
        bars,
        asof: new Date(this.sources.now()).toISOString(),
        fresh: true,
        message:
          "Monitoring confirmed intraday breakouts, stronger-stock replacements, stops and targets.",
      };
    } catch (error) {
      this.current = {
        ...this.current,
        fresh: false,
        scan: { ...this.current.scan!, phase: "error" },
        message:
          error instanceof Error ? error.message : "Intraday data unavailable.",
      };
    }
    return this.snapshot(this.sources.now());
  }
}
export const amount = (value: unknown): number | null =>
  (typeof value !== "number" && typeof value !== "string") ||
  (typeof value === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;
export function power(p: Row): number | null {
  const values = [
    amount(p.buying_power?.buying_power),
    amount(p.buying_power?.unleveraged_buying_power),
    amount(p.cash),
  ];
  return p.currency === "USD" && values.every((v) => v != null)
    ? Math.max(0, Math.min(...(values as number[])))
    : null;
}
export function quoteCurrent(
  q: Row | undefined,
  now: number,
  maxAge = 900000,
): boolean {
  const age = now - Date.parse(q?.venue_last_trade_time);
  return (
    !!q &&
    q.state === "active" &&
    q.has_traded === true &&
    amount(q.last_trade_price) != null &&
    q.last_trade_price > 0 &&
    age >= -60000 &&
    age <= maxAge
  );
}
export const failedOrderStates = new Set([
  "rejected",
  "failed",
  "cancelled",
  "canceled",
  "expired",
  "voided",
]);
export function ticketPending(ticket: Row, orders: Row[]): boolean {
  if (["submitting", "unknown"].includes(ticket.status)) return true;
  if (ticket.status !== "submitted") return false;
  const brokerId = ticket.result?.order?.id;
  const order = orders.find(
    (o) =>
      (brokerId && o.id === brokerId) || (ticket.id && o.ref_id === ticket.id),
  );
  const state = order?.state ?? ticket.result?.order?.state;
  // A confirmed terminal receipt remains terminal even when the broker's
  // recent-order endpoint stops returning that historical order.
  return state !== "filled" && !failedOrderStates.has(state);
}

export function buildActions(
  snapshot: Row,
  signals: Signals,
  budget: number | null,
  reserve: number | null,
  tickets: Row[],
  now = Date.now(),
  baselineOverride?: number | null,
): Row {
  const rotating = signals.strategy === ROTATION_STRATEGY;
  const candidates = signals.candidates ?? signals.ranked;
  const day = localDay(now, "NYSE"),
    hours = session(day),
    positions: Record<string, Row> = Object.fromEntries(
      (snapshot.positions ?? [])
        .filter((p: Row) => amount(p.quantity) != null && p.quantity > 0)
        .map((p: Row) => [p.symbol, p]),
    ),
    quotes: Record<string, Row> = snapshot.quotes ?? {},
    orders: Row[] = snapshot.orders ?? [],
    pending = new Set(
      orders
        .filter((o) =>
          [
            "new",
            "queued",
            "confirmed",
            "unconfirmed",
            "partially_filled",
            "pending_cancelled",
            "locating",
          ].includes(o.state),
        )
        .map((o) => o.symbol),
    );
  let unresolved = false;
  for (const t of tickets) {
    if (["unknown", "submitting"].includes(t.status)) unresolved = true;
    if (ticketPending(t, orders)) pending.add(t.arguments.symbol);
  }
  const age = now - Date.parse(snapshot.updated_at),
    fresh = age >= 0 && age <= 90000,
    wait = unresolved
      ? "An order has unresolved status. Check it before another trade."
      : !fresh
        ? "Waiting for current account data."
        : !hours || now < hours[0] || now >= hours[1]
          ? "Market closed."
          : null,
    entryWait =
      wait ||
      (!signals.fresh ||
      ![STRATEGY, ROTATION_STRATEGY].includes(signals.strategy)
        ? `Waiting for current intraday signals. ${signals.message}`
        : null),
    portfolio = snapshot.portfolio ?? {},
    equity = amount(portfolio.total_value),
    buyingPower = power(portfolio),
    valid =
      equity != null &&
      equity > 0 &&
      budget != null &&
      budget > 0 &&
      reserve != null &&
      reserve >= 0 &&
      reserve <= 100 &&
      buyingPower != null,
    deployed = valid ? Math.min(equity!, budget!) * (1 - reserve! / 100) : 0,
    heldValue = amount(portfolio.equity_value);
  let remaining =
    valid && heldValue != null
      ? Math.min(buyingPower!, Math.max(0, deployed - heldValue))
      : 0;
  let baseline = baselineOverride ?? null;
  let dailyHalted = false;
  if (
    baselineOverride === undefined &&
    equity != null &&
    equity > 0 &&
    fresh &&
    hours &&
    now >= hours[0] &&
    now < hours[1]
  ) {
    const file = join(US, "live_intraday_risk.json"),
      records = store.json<Record<string, Row>>(file, {}),
      r = records[snapshot.account_number];
    if (!r || r.day !== day) {
      records[snapshot.account_number] = { day, equity: String(equity) };
      store.save(file, records);
    }
    baseline = amount(records[snapshot.account_number].equity);
    if (
      rotating &&
      !records[snapshot.account_number].halted &&
      baseline != null &&
      equity! <= baseline * (1 - INTRADAY_RULES.daily_loss_pct / 100)
    ) {
      records[snapshot.account_number].halted = true;
      store.save(file, records);
    }
    dailyHalted = records[snapshot.account_number].halted === true;
  }
  const lossBlocked =
    dailyHalted ||
    baseline == null ||
    equity == null ||
    equity <= baseline * 0.99;
  const dailyLossHit =
    dailyHalted ||
    (baseline != null && equity != null && equity <= baseline * 0.99);
  const entries: Record<string, Row> = {},
    traded = new Set<string>();
  for (const t of [...tickets].sort((a, b) =>
    String(a.reviewed_at).localeCompare(b.reviewed_at),
  )) {
    if (
      t.arguments.side === "buy" &&
      ["submitted", "unknown", "submitting"].includes(t.status)
    ) {
      if (localDay(Date.parse(t.reviewed_at), "NYSE") === day)
        traded.add(t.arguments.symbol);
      const receipt =
        orders.find(
          (o) =>
            (t.id && o.ref_id === t.id) ||
            (t.result?.order?.id && o.id === t.result.order.id),
        ) ?? t.result?.order;
      // A failed retry without fills does not own the existing shares.
      const hasFill =
        (amount(receipt?.filled_quantity ?? receipt?.cumulative_quantity) ??
          0) > 0 ||
        (Array.isArray(receipt?.executions) &&
          receipt.executions.some((e: Row) => (amount(e.quantity) ?? 0) > 0));
      if (
        [STRATEGY, ROTATION_STRATEGY].includes(t.strategy) &&
        (!failedOrderStates.has(receipt?.state) || hasFill)
      )
        entries[t.arguments.symbol] = t;
    }
  }
  for (const o of orders)
    if (
      o.side === "buy" &&
      o.created_at &&
      localDay(Date.parse(o.created_at), "NYSE") === day
    )
      traded.add(o.symbol);
  const rl =
    signals.policy && valid
      ? allocate(
          signals.policy,
          signals.bars,
          now,
          Number(portfolio.cash) / equity!,
          Math.max(0, 1 - equity! / (baseline ?? equity!)),
          [
            ...new Set([
              ...signals.ranked.map((p) => p.symbol),
              ...Object.keys(positions),
            ]),
          ],
        )
      : undefined;
  const actions: Row[] = [];
  for (const [symbol, p] of Object.entries(positions)) {
    const q = quotes[symbol],
      t = entries[symbol];
    let reason: string | null = null;
    let effectiveStop: number | null = null,
      effectiveTarget: number | null = null;
    let riskWait: string | null = null;
    if (rotating && dailyLossHit)
      reason =
        "Daily 1% loss circuit breaker: exit holdings and halt entries for this session.";
    else if (hours && now >= hours[1] - 300000)
      reason = "Scheduled exit five minutes before exchange close.";
    else {
      const price = amount(q?.last_trade_price),
        savedStop = amount(t?.stop ?? t?.initial_stop),
        analyzedStop = signals.fresh
          ? amount(candidates.find((c) => c.symbol === symbol)?.range_low)
          : null,
        initialStop =
          savedStop != null && savedStop > 0
            ? savedStop
            : analyzedStop != null && analyzedStop > 0
              ? analyzedStop
              : null,
        entry = amount(p.average_buy_price),
        stop =
          rotating && hours && initialStop != null && entry != null && t
            ? Math.max(
                initialStop,
                protectedStop(
                  signals.bars[symbol],
                  now,
                  hours[0],
                  Number(t.risk_entry ?? entry),
                  Number(t.initial_stop ?? initialStop),
                  Date.parse(t.risk_started_at ?? t.reviewed_at),
                ),
              )
            : initialStop,
        savedTarget = amount(t?.target),
        target =
          savedTarget != null && savedTarget > 0
            ? savedTarget
            : entry != null && initialStop != null && entry > initialStop
              ? entry + 2 * (entry - initialStop)
              : null;
      effectiveStop =
        stop != null && Number.isFinite(stop) && stop > 0 ? stop : null;
      effectiveTarget = target;
      if (effectiveStop == null || target == null)
        riskWait =
          "Waiting for current analysis and valid risk levels for the existing holding.";
      if (price != null && stop != null && price <= stop)
        reason =
          rotating && initialStop != null && stop > initialStop
            ? "Break-even or trailing stop hit."
            : "Opening-range stop hit.";
      else if (price != null && target != null && price >= target)
        reason = "2R target hit.";
    }
    const available = amount(p.shares_available_for_sells),
      blocked =
        wait ||
        (pending.has(symbol)
          ? "Order already pending for this stock."
          : !quoteCurrent(q, now, rotating ? 90000 : 900000)
            ? "Waiting for a recent broker quote."
            : available == null || available <= 0
              ? "No shares available to sell."
              : reason
                ? null
                : riskWait),
      basis = amount(p.average_buy_price),
      price = amount(q?.last_trade_price),
      quantity = Number(p.quantity);
    const targetValue = deployed * (rl?.weights[symbol] ?? 0);
    const excess =
      price != null && price > 0 ? quantity - targetValue / price : 0;
    const rlSale =
      !entryWait &&
      !reason &&
      rl?.action != null &&
      excess * (price ?? 0) > Math.max(1, equity! * 0.01);
    if (rlSale) reason = rl!.reason;
    actions.push({
      symbol,
      action: blocked ? "WAIT" : reason ? "EXIT" : "HOLD",
      side: reason ? "sell" : null,
      enabled: !!reason && !blocked,
      reason:
        blocked ?? reason ?? "Monitoring opening-range stop and 2R target.",
      quantity: new Decimal(
        Math.min(available ?? 0, rlSale ? excess : quantity),
      ).toFixed(),
      price: q?.last_trade_price ?? null,
      stop: effectiveStop != null ? String(effectiveStop) : null,
      target: effectiveTarget != null ? String(effectiveTarget) : null,
      performance:
        basis != null && basis > 0 && price != null && price > 0
          ? {
              invested: quantity * basis,
              value: quantity * price,
              pnl: quantity * (price - basis),
              return_pct: (price / basis - 1) * 100,
            }
          : null,
    });
  }
  let occupied = new Set([...Object.keys(positions), ...pending]).size;
  const buyCandidates = [...signals.ranked];
  const advisor = learningAdvisor(
    {
      market: "US",
      horizon: "trading",
      broker: "robinhood",
      scope: learningScope(String(snapshot.account_number)),
    },
    signals.strategy,
    now,
  );
  const adviceBySymbol = new Map(
    candidates.map((pick) => [
      pick.symbol,
      advisor(marketObservation(signals.bars[pick.symbol], now) ?? {}),
    ]),
  );
  if (rotating) {
    // Held stocks are deliberately excluded from the watchlist. Evaluate their
    // qualified signals separately so available funds can top up an existing slot.
    for (const pick of candidates)
      if (
        positions[pick.symbol] &&
        Number(pick.relative_volume) >= 1.5 &&
        !buyCandidates.some((p) => p.symbol === pick.symbol)
      )
        buyCandidates.push(pick);
    buyCandidates.sort(
      (a, b) =>
        (adviceBySymbol.get(b.symbol)?.learning_adjustment ?? 0) -
          (adviceBySymbol.get(a.symbol)?.learning_adjustment ?? 0) ||
        (rotationStrength(signals.bars[b.symbol], b, now) ?? -Infinity) -
          (rotationStrength(signals.bars[a.symbol], a, now) ?? -Infinity),
    );
  }
  const budgetSizing = rotating && !rl;
  const qualifyingNew =
    budgetSizing &&
    !entryWait &&
    valid &&
    !lossBlocked &&
    hours &&
    now >= hours[0] + 1200000 &&
    now <
      hours[1] -
        (rotating ? INTRADAY_RULES.entry_cutoff_minutes * 60000 : 300000)
      ? buyCandidates.filter((pick) => {
          const q = quotes[pick.symbol];
          const price = Number(q?.last_trade_price),
            stop = intradayStop(
              signals.bars[pick.symbol],
              now,
              hours[0],
              price,
              Number(pick.range_low),
            );
          return (
            !positions[pick.symbol] &&
            !pending.has(pick.symbol) &&
            !traded.has(pick.symbol) &&
            quoteCurrent(q, now, 90000) &&
            rotationEntryReady(signals.bars[pick.symbol], pick, now, hours) ===
              null &&
            Number(q?.last_trade_price) > Number(pick.range_high) &&
            Number(q?.last_trade_price) > Number(pick.range_low) &&
            intradayQuoteCheck(q, signals.bars[pick.symbol], now, hours[0]) ===
              null &&
            entryQuality("US", price, stop, price + 2 * (price - stop), q)
              .eligible
          );
        })
      : [];
  const allocationSlots = budgetSizing
    ? Math.min(
        4,
        Math.max(
          2,
          new Set([
            ...Object.keys(positions),
            ...pending,
            ...qualifyingNew.map((p) => p.symbol),
          ]).size,
        ),
      )
    : 4;
  const allocationCapital =
    budgetSizing && heldValue != null && buyingPower != null
      ? Math.min(deployed, Math.max(0, heldValue) + buyingPower)
      : deployed;
  for (const pick of buyCandidates) {
    const symbol = pick.symbol,
      position = positions[symbol],
      topUp = !!position;
    const holdingIndex = actions.findIndex((a) => a.symbol === symbol);
    // Stops, targets, planned exits and pending orders take precedence over adds.
    if (
      topUp &&
      (!rotating ||
        Number(pick.relative_volume) < 1.5 ||
        actions[holdingIndex]?.action !== "HOLD")
    )
      continue;
    const q = quotes[symbol];
    let blocked = entryWait;
    if (!blocked && pending.has(symbol))
      blocked = "Order already pending for this stock.";
    if (!blocked && !topUp && occupied >= 4)
      blocked = "Four-position trading limit reached.";
    if (!blocked && !topUp && traded.has(symbol))
      blocked = "One entry per symbol per session; already traded today.";
    if (!blocked && !quoteCurrent(q, now, rotating ? 90000 : 900000))
      blocked = "Waiting for a recent broker quote.";
    if (!blocked && !valid)
      blocked = "Trading budget or buying power unavailable.";
    if (!blocked && lossBlocked)
      blocked = "Daily loss limit reached or baseline unavailable.";
    if (
      !blocked &&
      (!hours ||
        now < hours[0] + 1200000 ||
        now >=
          hours[1] -
            (rotating ? INTRADAY_RULES.entry_cutoff_minutes * 60000 : 300000))
    )
      blocked = "Waiting for intraday entry window.";
    if (!blocked)
      blocked = (rotating ? rotationEntryReady : entryReady)(
        signals.bars[symbol],
        pick,
        now,
        hours!,
      );
    if (
      !blocked &&
      rotating &&
      Number(q?.last_trade_price) <= Number(pick.range_high)
    )
      blocked = "Current broker price is no longer above the opening range.";
    if (!blocked && rotating)
      blocked = intradayQuoteCheck(q, signals.bars[symbol], now, hours![0]);
    if (!blocked && rl && (rl.action == null || !rl.weights[symbol]))
      blocked = rl.reason;
    const price = amount(q?.last_trade_price),
      previousStop = topUp
        ? amount(actions[holdingIndex]?.stop ?? entries[symbol]?.stop)
        : null,
      rangeStop = amount(pick.range_low),
      candidateStop =
        rotating && price != null && rangeStop != null && hours
          ? intradayStop(signals.bars[symbol], now, hours[0], price, rangeStop)
          : rangeStop,
      stop =
        previousStop != null && candidateStop != null
          ? Math.max(previousStop, candidateStop)
          : candidateStop;
    if (
      !blocked &&
      topUp &&
      (amount(position.average_buy_price) == null ||
        Number(position.average_buy_price) <= 0)
    )
      blocked = "Position cost basis is unavailable for the top-up risk check.";
    let allocation = 0,
      plannedRisk: number | null = null,
      riskLimited = false,
      target: number | null = null;
    const proposedTarget =
      price != null && stop != null
        ? topUp
          ? (amount(actions[holdingIndex]?.target) ??
            price + 2 * (price - stop))
          : price + 2 * (price - stop)
        : NaN;
    const quality = entryQuality(
      "US",
      price ?? NaN,
      stop ?? NaN,
      proposedTarget,
      q,
    );
    if (!blocked && rotating && !quality.eligible) blocked = quality.reason;
    if (!blocked) {
      if (price == null || stop == null || price <= stop)
        blocked = "Entry price is below the opening-range stop.";
      else {
        const entry = execution(price, 1, "BUY"),
          exit = execution(stop, 1, "SELL"),
          risk = rotating
            ? quality.risk_per_share
            : entry.value + entry.fee - exit.value + exit.fee;
        let existingRisk = 0;
        const heldQuantity = topUp ? Number(position.quantity) : 0;
        if (topUp) {
          const existingEntry = execution(
              Number(position.average_buy_price),
              heldQuantity,
              "BUY",
            ),
            existingExit = execution(stop, heldQuantity, "SELL");
          existingRisk = Math.max(
            0,
            existingEntry.value +
              existingEntry.fee -
              existingExit.value +
              existingExit.fee,
            heldQuantity *
              (Number(position.average_buy_price) -
                stop +
                (price * quality.estimated_round_trip_cost_pct) / 100),
          );
        }
        const targetValue =
          allocationCapital *
          (rl ? (rl.weights[symbol] ?? 0) : 1 / allocationSlots);
        allocation = Decimal.min(
          new Decimal(
            Math.max(
              0,
              (equity! * INTRADAY_RULES.risk_per_position_pct) / 100 -
                existingRisk,
            ),
          )
            .div(risk)
            .times(price),
          remaining,
          Decimal.max(
            0,
            new Decimal(targetValue).minus(
              new Decimal(heldQuantity).times(price),
            ),
          ),
        )
          .toDecimalPlaces(2, Decimal.ROUND_DOWN)
          .toNumber();
        target = proposedTarget;
        plannedRisk = existingRisk + (allocation / price) * risk;
        riskLimited =
          allocation + 0.01 <
          Math.min(remaining, Math.max(0, targetValue - heldQuantity * price));
        if (allocation <= 0)
          blocked = topUp
            ? budgetSizing
              ? "Position is at its allocation or risk limit, or no funds remain after reserve."
              : "No top-up room within the position allocation, risk, budget and reserve limits."
            : "No cash available within budget and reserve.";
        else if (allocation < MIN_DOLLAR_BUY)
          blocked = topUp
            ? "Top-up room is below the $1 minimum add."
            : "Allocation is below the $1 minimum buy; keeping the remainder in cash.";
        else {
          remaining = Decimal.max(
            0,
            new Decimal(remaining).minus(allocation),
          ).toNumber();
          if (!topUp) occupied++;
        }
      }
    }
    const buyAction: Row = {
      ...adviceBySymbol.get(symbol),
      ...(topUp
        ? {
            performance: actions[holdingIndex]?.performance,
            held_quantity: position.quantity,
            ...(blocked ? { quantity: actions[holdingIndex]?.quantity } : {}),
          }
        : {}),
      symbol,
      action: blocked ? (topUp ? "HOLD" : "WAIT") : "BUY",
      side: blocked && topUp ? null : "buy",
      top_up: topUp,
      enabled: !blocked,
      reason:
        blocked ??
        (topUp
          ? budgetSizing
            ? `Top up toward the equal allocation across ${allocationSlots} stocks within the 0.25% total position-risk cap.`
            : "Add to an existing qualified holding using remaining cash within allocation and total position-risk limits."
          : (rl?.reason ??
            (rotating
              ? budgetSizing
                ? `VWAP/EMA-confirmed breakout; allocation across ${allocationSlots} stocks${riskLimited ? ", reduced to respect the 0.25% position-risk cap" : " within the 0.25% position-risk cap"}.`
                : "Confirmed intraday breakout; risk capped at 0.25% of equity."
              : "15-minute opening-range breakout; risk capped at 0.25% of equity."))),
      dollar_amount: new Decimal(allocation).toFixed(2),
      planned_risk_usd: plannedRisk,
      risk_cap_usd:
        equity != null
          ? (equity * INTRADAY_RULES.risk_per_position_pct) / 100
          : null,
      risk_limited: riskLimited,
      net_reward_risk: rotating ? quality.net_reward_risk : null,
      stressed_reward_risk: rotating ? quality.stressed_reward_risk : null,
      estimated_round_trip_cost_pct: rotating
        ? quality.estimated_round_trip_cost_pct
        : null,
      price: q?.last_trade_price ?? null,
      stop: stop != null ? String(stop) : null,
      target: target != null ? String(target) : null,
      initial_stop: topUp
        ? (entries[symbol]?.initial_stop ??
          entries[symbol]?.stop ??
          (stop != null ? String(stop) : null))
        : stop != null
          ? String(stop)
          : null,
      risk_entry: topUp
        ? (entries[symbol]?.risk_entry ?? position.average_buy_price)
        : q?.last_trade_price,
      risk_started_at: topUp
        ? (entries[symbol]?.risk_started_at ??
          entries[symbol]?.reviewed_at ??
          new Date(now).toISOString())
        : new Date(now).toISOString(),
      indicators:
        rotating && hours
          ? (() => {
              const { vwap, ema9, atr } = intradayIndicators(
                signals.bars[symbol],
                now,
                hours[0],
              );
              return { vwap, ema9, atr };
            })()
          : null,
      range_high: pick.range_high,
      rotation_score: rotationStrength(signals.bars[symbol], pick, now),
      relative_volume: pick.relative_volume,
      watch_since: pick.watch_since,
      replaced_symbol: pick.replaced_symbol,
    };
    if (topUp) actions[holdingIndex] = buyAction;
    else actions.push(buyAction);
  }
  return {
    actions,
    risk_rules: rotating ? { ...INTRADAY_RULES, ...ENTRY_QUALITY_RULES } : null,
    daily_halted: dailyLossHit,
    baseline_equity: baseline,
    rl: rl ?? null,
    shortlist: signals.ranked,
    target_usd: allocationCapital / allocationSlots,
    allocation_slots: allocationSlots,
    sizing_mode: budgetSizing ? "equal_budget" : "risk_capped",
    deployable_budget: allocationCapital,
    budget_after_reserve: deployed,
    buying_power: buyingPower,
    budget,
    reserve_pct: reserve,
    message: entryWait ?? rl?.reason ?? signals.message,
  };
}
function projectedSales(snapshot: Row, sells: Row[]): Row | null {
  const projected = structuredClone(snapshot),
    p = projected.portfolio;
  if (
    [
      p.cash,
      p.equity_value,
      p.buying_power?.buying_power,
      p.buying_power?.unleveraged_buying_power,
    ].some((n) => amount(n) == null)
  )
    return null;
  const proceeds = sells.reduce(
    (n, a) => n + Number(a.quantity) * Number(a.price),
    0,
  );
  projected.positions = projected.positions
    .map((h: Row) => ({
      ...h,
      quantity:
        Number(h.quantity) -
        Number(sells.find((a) => a.symbol === h.symbol)?.quantity ?? 0),
    }))
    .filter((h: Row) => h.quantity > 0);
  p.cash = String(Number(p.cash) + proceeds * 0.99);
  p.equity_value = String(Math.max(0, Number(p.equity_value) - proceeds));
  p.total_value = String(Math.max(0, Number(p.total_value) - proceeds * 0.01));
  for (const k of ["buying_power", "unleveraged_buying_power"])
    p.buying_power[k] = String(Number(p.buying_power[k]) + proceeds * 0.99);
  return projected;
}

export function rebalancePlan(
  snapshot: Row,
  signals: Signals,
  budget: number | null,
  reserve: number | null,
  tickets: Row[],
  now = Date.now(),
): Row {
  const current = buildActions(
    snapshot,
    signals,
    budget,
    reserve,
    tickets,
    now,
  );
  let sells: Row[] = current.actions.filter(
    (a: Row) => a.enabled && a.side === "sell",
  );
  // A daily circuit breaker cannot be bypassed by simulated sale proceeds.
  if (current.daily_halted) return current;
  let replacement: Row | undefined;
  if (
    signals.strategy === ROTATION_STRATEGY &&
    !signals.policy &&
    !sells.length &&
    !current.actions.some((a: Row) => a.enabled && a.side === "buy") &&
    signals.fresh
  ) {
    const candidates = signals.candidates ?? signals.ranked;
    const holdings = current.actions
      .filter((a: Row) => a.action === "HOLD")
      .map((a: Row) => ({
        action: a,
        strength: rotationStrength(
          signals.bars[a.symbol],
          candidates.find((p) => p.symbol === a.symbol),
          now,
        ),
      }))
      .filter((h: Row) => h.strength != null)
      .sort((a: Row, b: Row) => a.strength - b.strength);
    for (const held of holdings) {
      const symbol = held.action.symbol;
      const sale = {
        ...held.action,
        action: "EXIT",
        side: "sell",
        enabled: true,
      };
      const projected = projectedSales(snapshot, [sale]);
      if (!projected) continue;
      const plan = buildActions(
        projected,
        signals,
        budget,
        reserve,
        tickets,
        now,
        current.baseline_equity,
      );
      const better = plan.actions
        .filter(
          (a: Row) =>
            a.enabled &&
            a.side === "buy" &&
            a.rotation_score != null &&
            a.rotation_score >= held.strength + MIN_STRENGTH_IMPROVEMENT,
        )
        .sort((a: Row, b: Row) => b.rotation_score - a.rotation_score)[0];
      if (!better) continue;
      sale.reason = `Replace ${symbol} with stronger confirmed breakout ${better.symbol}.`;
      sale.replacement_symbol = better.symbol;
      Object.assign(held.action, sale);
      sells = [held.action];
      replacement = better;
      break;
    }
  }
  if (!sells.length) return current;
  const projected = projectedSales(snapshot, sells);
  if (!projected) return current;
  const conditional: Row[] = buildActions(
    projected,
    signals,
    budget,
    reserve,
    tickets,
    now,
    current.baseline_equity,
  )
    .actions.filter(
      (a: Row) =>
        a.enabled &&
        a.side === "buy" &&
        (!replacement || a.symbol === replacement.symbol),
    )
    .map((a: Row) => ({
      ...a,
      after_sell_fills: true,
      replaced_symbol: replacement ? sells[0].symbol : a.replaced_symbol,
      reason: replacement
        ? `Buy ${a.symbol} after replacing weaker holding ${sells[0].symbol}.`
        : "Planned buy after confirmed sells and refreshed buying power.",
    }));
  const replace = new Set(conditional.map((a) => a.symbol));
  current.actions = current.actions
    .filter((a: Row) => !replace.has(a.symbol))
    .concat(conditional);
  return current;
}
export const eligibleActions = (model: Row): Row[] =>
  model.actions
    .filter((a: Row) => a.enabled && ["BUY", "EXIT"].includes(a.action))
    .sort(
      (a: Row, b: Row) =>
        Number(a.side !== "sell") - Number(b.side !== "sell") ||
        a.symbol.localeCompare(b.symbol),
    );

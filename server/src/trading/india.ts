import { randomUUID } from "node:crypto";
import { store, Mutex, errorMessage, type Row } from "../shared/storage.js";
import { localDay, session, phase } from "../shared/calendar.js";
import { history } from "../shared/prices.js";
import { indiaTradingUniverse } from "../analysis.js";
import { scope, validateBudget } from "../brokers/accounts.js";
import * as brokers from "../brokers/india.js";
import { Feed, amount, type Signals } from "./live.js";
import { rotationEntryReady, TradeDecisionChanged } from "./rotation.js";
import { intradayQuoteCheck, intradayStop, protectedStop } from "./intraday.js";
import { entryQuality } from "./quality.js";
import {
  rememberLearning,
  marketObservation,
  recordLearningOrders,
  learningAdvisor,
} from "../learning.js";

import {
  indiaTradingFile,
  selectedBroker,
  requireBroker,
  investmentScope,
} from "../brokers/india-selection.js";
import { batches, unresolved, submitLock } from "../brokers/kite.js";
export { indiaTradingFile } from "../brokers/india-selection.js";
export const defaultSymbols = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "SBIN",
  "ITC",
  "LT",
];
import {
  indiaTradingIndexNames,
  type IndiaTradingIndex,
} from "./india-indices.js";
export interface IndiaSettings {
  budget: number;
  reserve_pct: number;
  symbols: string[];
  selection_mode?: "automatic" | "manual";
  index?: IndiaTradingIndex;
}
const pendingStatuses = new Set(["submitting", "unknown", "submitted"]);
function quoteReady(q: Row | undefined, now: number) {
  const age = now - Date.parse(q?.venue_last_trade_time);
  return (
    amount(q?.last_trade_price) != null &&
    Number(q?.last_trade_price) > 0 &&
    age >= -60000 &&
    age <= 90000
  );
}
export function managedShares(tickets: Row[], symbol: string): number {
  return Math.max(
    0,
    tickets
      .filter((t) => t.symbol === symbol)
      .reduce(
        (n, t) =>
          n +
          (t.side === "buy" ? 1 : -1) *
            Number(
              t.filled_quantity ?? (t.status === "filled" ? t.quantity : 0),
            ),
        0,
      ),
  );
}
export function indiaActions(
  snapshot: brokers.IndiaSnapshot,
  signals: Signals,
  settings: IndiaSettings,
  risk: Row,
  tickets: Row[],
  now = Date.now(),
): Row[] {
  const day = localDay(now, "NSE"),
    hours = session(day, "NSE");
  const snapshotAge = now - Date.parse(snapshot.updated_at);
  const wait = tickets.some((t) => ["submitting", "unknown"].includes(t.status))
    ? "An order is unresolved. Check broker status before trading."
    : !hours || now < hours[0] || now >= hours[1]
      ? "NSE market closed."
      : snapshotAge < 0 || snapshotAge > 90000
        ? "Waiting for current broker data."
        : null;
  const pending = new Set(
    snapshot.orders
      .filter((o) => !brokers.terminal.has(o.state))
      .map((o) => o.symbol),
  );
  for (const t of tickets)
    if (pendingStatuses.has(t.status)) pending.add(t.symbol);
  const actions: Row[] = [];
  for (const p of snapshot.positions.filter((p) => p.quantity !== 0)) {
    const symbol = p.symbol,
      q = snapshot.quotes[symbol],
      quantity = Math.min(
        Math.max(0, p.quantity),
        managedShares(tickets, symbol),
      );
    const entry = [...tickets]
      .reverse()
      .find(
        (t) =>
          t.symbol === symbol &&
          t.side === "buy" &&
          Number(
            t.filled_quantity ?? (t.status === "filled" ? t.quantity : 0),
          ) > 0,
      );
    const stop =
      entry && hours
        ? protectedStop(
            signals.bars[symbol],
            now,
            hours[0],
            Number(entry.price),
            Number(entry.initial_stop),
            Date.parse(entry.submitted_at),
          )
        : null;
    let reason: string | null = null;
    if (quantity > 0) {
      if (risk.halted)
        reason =
          "Daily 1% budget-loss limit: exit managed shares and halt entries.";
      else if (hours && now >= hours[1] - 20 * 60000)
        reason = "Scheduled exit 20 minutes before NSE close.";
      else if (
        !entry ||
        localDay(Date.parse(entry.submitted_at), "NSE") !== day
      )
        reason = "Exit carried managed intraday position.";
      else if (!(stop! > 0 && Number(entry.target) > 0))
        reason = "Exit managed position with missing risk protection.";
      else if (Number(q?.last_trade_price) <= stop!)
        reason = "Stop or trailing stop hit.";
      else if (Number(q?.last_trade_price) >= Number(entry.target))
        reason = "2R target hit.";
    }
    const blocked =
      wait ??
      (pending.has(symbol)
        ? "A broker order is pending for this stock."
        : !quoteReady(q, now)
          ? "Waiting for a recent broker quote."
          : null);
    actions.push({
      symbol,
      exchange: "NSE",
      side: reason ? "sell" : null,
      action: reason ? (blocked ? "WAIT" : "EXIT") : "HOLD",
      enabled: !!reason && !blocked,
      reason:
        quantity <= 0
          ? "External position; only app-managed long shares can be sold here."
          : (blocked ?? reason ?? "Monitoring stop, target and session exit."),
      quantity,
      price: q?.last_trade_price,
      stop,
      target: entry?.target,
      initial_stop: entry?.initial_stop,
    });
  }
  const heldValue = snapshot.positions.reduce(
    (n, p) =>
      n +
      Math.max(0, p.quantity) *
        Number(snapshot.quotes[p.symbol]?.last_trade_price ?? p.average_price),
    0,
  );
  const reserved = tickets
    .filter((t) => pendingStatuses.has(t.status) && t.side === "buy")
    .reduce((n, t) => n + Number(t.quantity) * Number(t.price), 0);
  let remaining = Math.max(
    0,
    Math.min(
      snapshot.cash,
      settings.budget * (1 - settings.reserve_pct / 100) - heldValue - reserved,
    ),
  );
  let occupied = new Set([
    ...snapshot.positions.filter((p) => p.quantity !== 0).map((p) => p.symbol),
    ...pending,
  ]).size;
  const advisor = learningAdvisor(
    {
      market: "India",
      horizon: "trading",
      broker: String(snapshot.learning_broker ?? "unknown"),
      scope: scope(
        String(snapshot.learning_broker ?? "unknown") + ":" + snapshot.user,
      ),
    },
    signals.strategy,
    now,
  );
  const picks = signals.ranked
    .map((pick) => ({
      ...pick,
      ...advisor(marketObservation(signals.bars[pick.symbol], now) ?? {}),
    }))
    .sort((a, b) => b.learning_adjustment - a.learning_adjustment);
  const target =
    (settings.budget * (1 - settings.reserve_pct / 100)) /
    Math.min(4, Math.max(2, occupied + picks.length));
  for (const pick of picks) {
    const symbol = pick.symbol;
    if (snapshot.positions.some((p) => p.symbol === symbol && p.quantity !== 0))
      continue;
    const q = snapshot.quotes[symbol],
      price = Number(q?.last_trade_price);
    let blocked =
      wait ??
      (!signals.fresh
        ? "Waiting for current completed intraday signals."
        : risk.halted
          ? "Daily loss limit reached; entries halted for this session."
          : now < hours![0] + 20 * 60000 || now >= hours![1] - 30 * 60000
            ? "Outside the intraday entry window (entries end 30 minutes before close)."
            : pending.has(symbol)
              ? "A broker order is pending for this stock."
              : occupied >= 4
                ? "Four-position trading limit reached."
                : tickets.some(
                      (t) =>
                        t.symbol === symbol &&
                        t.side === "buy" &&
                        (["submitted", "filled"].includes(t.status) ||
                          Number(t.filled_quantity) > 0) &&
                        localDay(Date.parse(t.submitted_at), "NSE") === day,
                    )
                  ? "One entry per stock per NSE session."
                  : snapshot.positions.some((p) => p.quantity < 0)
                    ? "Review external short positions before opening new longs."
                    : !quoteReady(q, now)
                      ? "Waiting for a recent broker quote."
                      : null);
    if (!blocked)
      blocked =
        rotationEntryReady(signals.bars[symbol], pick, now, hours!) ??
        intradayQuoteCheck(q, signals.bars[symbol], now, hours![0]);
    if (!blocked && price <= Number(pick.range_high))
      blocked = "Broker price is no longer above the opening range.";
    const stop =
      hours && Number.isFinite(price)
        ? intradayStop(
            signals.bars[symbol],
            now,
            hours[0],
            price,
            Number(pick.range_low),
          )
        : NaN;
    const targetPrice = price + 2 * (price - stop),
      quality = entryQuality("India", price, stop, targetPrice, q),
      perShareRisk = quality.risk_per_share ?? NaN;
    if (!blocked && !quality.eligible) blocked = quality.reason;
    const quantity =
      !blocked && perShareRisk > 0
        ? Math.floor(
            Math.min(
              remaining / (price * 1.01),
              target / (price * 1.01),
              (settings.budget * 0.0025) / perShareRisk,
            ),
          )
        : 0;
    if (!blocked && quantity < 1)
      blocked =
        "Not enough budget or risk allowance for one whole share plus estimated costs.";
    if (!blocked) {
      occupied++;
      remaining -= quantity * price * 1.01;
    }
    actions.push({
      symbol,
      exchange: "NSE",
      side: "buy",
      learning_suggestion: pick.learning_suggestion,
      learning_reason: pick.learning_reason,
      action: blocked ? "WAIT" : "BUY",
      enabled: !blocked,
      reason:
        blocked ??
        "Completed opening-range breakout with VWAP, EMA and 1.5× relative-volume confirmation.",
      quantity,
      price,
      stop: Number.isFinite(stop) ? stop : null,
      initial_stop: Number.isFinite(stop) ? stop : null,
      target: Number.isFinite(stop) ? targetPrice : null,
      planned_risk_inr: quantity * perShareRisk,
      net_reward_risk: quality.net_reward_risk,
      stressed_reward_risk: quality.stressed_reward_risk,
      estimated_round_trip_cost_pct: quality.estimated_round_trip_cost_pct,
    });
  }
  return actions;
}

export class IndiaTrading {
  private readonly lock = new Mutex();
  private state: Row;
  private account: string | null = null;
  private snapshot: brokers.IndiaSnapshot | null = null;
  private actions: Row[] = [];
  private error: string | null = null;
  private feed: Feed;
  private feedWork: Promise<unknown> | null = null;
  private lastFeed = 0;
  private stopped = false;
  constructor(
    private readonly changed = (_selectionChanged = false) => {},
    private readonly sources: {
      snapshot: typeof brokers.snapshot;
      place: typeof brokers.place;
      cancel: typeof brokers.cancel;
      history: typeof history;
      universe?: (index: IndiaTradingIndex) => Promise<string[]>;
    } = {
      snapshot: brokers.snapshot,
      place: brokers.place,
      cancel: brokers.cancel,
      history,
    },
  ) {
    this.state = store.json<Row>(indiaTradingFile, {
      broker: null,
      accounts: {},
      current: {},
    });
    this.state.accounts ??= {};
    this.state.current ??= {};
    if (!this.state.broker_selected)
      for (const record of Object.values(this.state.accounts) as Row[])
        if (record.auto) record.auto.enabled = false;
    this.account = this.state.current[this.state.broker] ?? null;
    this.feed = this.newFeed();
  }
  private newFeed() {
    return new Feed(
      {
        history: (symbol, ...args) =>
          this.sources.history(symbol + ".NS", ...args),
        universe: async () =>
          this.settings.selection_mode === "manual"
            ? this.settings.symbols
            : (this.sources.universe ?? indiaTradingUniverse)(
                this.settings.index ?? "Nifty 100",
              ),
        now: Date.now,
      },
      "NSE",
    );
  }
  private get broker(): brokers.IndiaBroker {
    if (!this.state.broker_selected) return requireBroker();
    return this.state.broker;
  }
  private get record(): Row | null {
    return this.account ? (this.state.accounts[this.account] ?? null) : null;
  }
  get enabled(): boolean {
    return this.record?.auto?.enabled === true;
  }
  get hasPending(): boolean {
    return (this.record?.tickets ?? []).some((t: Row) =>
      pendingStatuses.has(t.status),
    );
  }
  private get settings(): IndiaSettings {
    return this.settingsFor(this.record);
  }
  private settingsFor(record: Row | null): IndiaSettings {
    const saved = record?.settings;
    return {
      budget: saved?.budget ?? 100000,
      reserve_pct: saved?.reserve_pct ?? 10,
      symbols: saved?.symbols ?? defaultSymbols,
      selection_mode: saved?.selection_mode ?? "automatic",
      index: saved?.index ?? "Nifty 100",
    };
  }
  private save(selectionChanged = false) {
    store.save(indiaTradingFile, this.state);
    this.changed(selectionChanged);
  }
  private log(message: string) {
    if (!this.record) return;
    const events = (this.record.history ??= []);
    events.push({ created_at: new Date().toISOString(), message });
    this.record.history = events.slice(-2000);
  }
  stop(message?: string) {
    if (this.record?.auto) {
      this.record.auto.enabled = false;
      if (message) this.record.auto.error = message;
      this.log(message ?? "India automatic trading paused.");
      this.save();
    }
  }
  close() {
    this.stopped = true;
    this.stop(
      "Server stopped. Start a new India trading session after restart.",
    );
  }
  view(): Row {
    const broker = this.state.broker_selected
      ? (this.state.broker as brokers.IndiaBroker)
      : null;
    const account = broker ? (investmentScope(broker) ?? this.account) : null;
    const record = account ? (this.state.accounts[account] ?? null) : null;
    const connections = brokers.connections();
    const connected = connections.find((b) => b.id === broker)?.connected;
    const marketPhase = phase(Date.now(), "NSE");
    const configured = record?.configured === true;
    const currentSignals = this.feed.snapshot();
    const signals =
      account === this.account
        ? currentSignals
        : { ...currentSignals, fresh: false, ranked: [], asof: null };
    const currentSnapshot = account === this.account ? this.snapshot : null;
    const snapshot = currentSnapshot ?? record?.last_snapshot ?? null;
    const waiting = !broker
      ? {
          phase: "not_selected",
          message:
            "Choose your India broker account for trading and long-term investments.",
        }
      : this.error
        ? {
            phase: "error",
            message:
              "Broker refresh failed. Resolve the broker error, then refresh the account.",
          }
        : !connected
          ? {
              phase: "not_connected",
              message: `Connect ${broker ? brokers.names[broker] : "your broker"} in Account settings to load India trading data.`,
            }
          : !configured
            ? {
                phase: "not_configured",
                message:
                  "Save this account’s India budget and stock selection to start monitoring.",
              }
            : marketPhase !== "Market open"
              ? {
                  phase: "market_closed",
                  message:
                    "NSE market closed. Intraday scans wait for regular exchange hours.",
                }
              : signals.scan?.phase === "idle"
                ? {
                    phase: "idle",
                    message:
                      "Ready to monitor. Refresh the account or start automatic trading to load signals.",
                  }
                : null;
    return {
      broker,
      brokers: connections,
      indices: indiaTradingIndexNames,
      investment_scope: investmentScope(),
      scope: account,
      configured,
      settings: this.settingsFor(record),
      settings_revision: record?.settings_revision ?? 0,
      settings_saved_at: record?.settings_saved_at ?? null,
      auto: record?.auto ?? { enabled: false },
      phase: marketPhase,
      snapshot: snapshot
        ? {
            ...snapshot,
            cached: !currentSnapshot,
            user: "••••" + String(snapshot.user).slice(-4),
          }
        : null,
      actions: currentSnapshot ? this.actions : [],
      signals: {
        message: waiting?.message ?? signals.message,
        scan: waiting
          ? { phase: waiting.phase, completed: 0, total: 0 }
          : signals.scan,
        asof: signals.asof ?? record?.last_scan?.asof ?? null,
        shortlist: signals.asof
          ? signals.ranked
          : (record?.last_scan?.shortlist ?? []),
        fresh: signals.fresh,
      },
      tickets: (record?.tickets ?? []).slice(-100).reverse(),
      history: (record?.history ?? []).slice(-100).reverse(),
      error: this.error,
    };
  }
  private idle() {
    if (this.stopped) throw new Error("Server is stopping.");
    if (this.enabled)
      throw new Error(
        "Pause India automatic trading before changing brokers, settings or using manual orders.",
      );
    if (this.hasPending)
      throw new Error(
        "Reconcile pending India orders before changing this trading session.",
      );
  }
  select(broker: brokers.IndiaBroker): Promise<Row> {
    return submitLock.run(() =>
      this.lock.run(() => {
        if (selectedBroker() === broker) return this.view();
        if (!(
          selectedBroker() === null &&
          this.state.broker === broker &&
          !this.enabled
        ))
          this.idle();
        if (
          Object.values(batches()).some(
            (b) =>
              unresolved(b) &&
              !(selectedBroker() === null && (b.broker ?? "kite") === broker),
          )
        )
          throw new Error(
            "Reconcile pending investment orders before changing your India broker account.",
          );
        this.state.broker = broker;
        this.state.broker_selected = true;
        this.account = this.state.current[broker] ?? null;
        this.snapshot = null;
        this.actions = [];
        this.feed = this.newFeed();
        this.lastFeed = 0;
        this.error = null;
        const account = investmentScope(broker);
        if (account) this.bindAccount(account);
        this.save(true);
        return this.view();
      }),
    );
  }
  connect(
    broker: Exclude<brokers.IndiaBroker, "kite">,
    token: string,
  ): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      const result = await brokers.connect(broker, token);
      if (broker === this.broker) {
        const account = investmentScope(broker);
        if (account) this.bindAccount(account);
      }
      this.snapshot = null;
      this.actions = [];
      this.save(true);
      return result;
    });
  }
  configure(
    settings: IndiaSettings,
    expected: {
      revision?: number;
      scope?: string;
      broker?: brokers.IndiaBroker;
    } = {},
  ): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      validateBudget(settings.budget, settings.reserve_pct);
      if (expected.broker && expected.broker !== this.broker)
        throw new Error(
          "Broker selection changed. Reload the selected account before saving.",
        );
      if (!indiaTradingIndexNames.includes(settings.index ?? "Nifty 100"))
        throw new Error("Choose a supported India trading index.");
      if (
        !["automatic", "manual"].includes(
          settings.selection_mode ?? "automatic",
        ) ||
        ((settings.selection_mode ?? "automatic") === "manual" &&
          !settings.symbols.length) ||
        settings.symbols.length > 20 ||
        new Set(settings.symbols).size !== settings.symbols.length ||
        settings.symbols.some((s) => !/^[A-Z0-9][A-Z0-9&.\-]{0,29}$/.test(s))
      )
        throw new Error(
          "Choose automatic selection or a custom watchlist of 1–20 distinct NSE equity symbols.",
        );
      const verifiedAccount = investmentScope(this.broker);
      if (verifiedAccount) this.bindAccount(verifiedAccount);
      else await this.read();
      if (expected.scope && expected.scope !== this.account)
        throw new Error(
          "Broker account changed. Reload its saved settings before saving.",
        );
      if (
        expected.revision != null &&
        expected.revision !== (this.record!.settings_revision ?? 0)
      )
        throw new Error(
          "Trading settings changed in another window. Reload saved settings before saving again.",
        );
      const record = this.record!;
      const previous = {
        settings: record.settings,
        configured: record.configured,
        settings_revision: record.settings_revision,
        settings_saved_at: record.settings_saved_at,
      };
      record.settings = {
        ...settings,
        selection_mode: settings.selection_mode ?? "automatic",
        index: settings.index ?? "Nifty 100",
      };
      record.configured = true;
      record.settings_revision = (record.settings_revision ?? 0) + 1;
      record.settings_saved_at = new Date().toISOString();
      try {
        this.save();
      } catch (error) {
        Object.assign(record, previous);
        throw error;
      }
      this.feed = this.newFeed();
      this.lastFeed = 0;
      this.actions = [];
      if (this.settings.selection_mode === "automatic") this.refreshFeed();
      return this.view();
    });
  }
  private consent(automatic: boolean, account: string) {
    if (this.stopped || this.account !== account)
      throw new Error("India trading session stopped or account changed.");
    if (
      automatic &&
      (!this.enabled || Date.now() >= this.record!.auto.expires_at)
    )
      throw new Error("India automatic trading consent expired.");
  }
  private bindAccount(account: string): boolean {
    if (
      this.account &&
      this.account !== account &&
      (this.enabled || this.hasPending)
    ) {
      this.stop(
        "Broker account changed; reconcile the previous account first.",
      );
      throw new Error("India broker account changed.");
    }
    const accountChanged = this.account !== account;
    if (accountChanged) {
      this.account = account;
      this.snapshot = null;
      this.actions = [];
      this.feed = this.newFeed();
      this.lastFeed = 0;
    }
    this.state.current[this.broker] = account;
    this.state.accounts[account] ??= {
      settings: {
        budget: 100000,
        reserve_pct: 10,
        symbols: [...defaultSymbols],
        selection_mode: "automatic",
      },
      auto: { enabled: false },
      tickets: [],
      history: [],
    };
    return accountChanged;
  }
  private async read(): Promise<void> {
    const broker = this.broker;
    const data = await this.sources.snapshot(
      broker,
      this.feed.snapshot().ranked.map((p) => p.symbol),
    );
    const account = scope(this.broker + ":" + data.user);
    const accountChanged = this.bindAccount(account);
    this.snapshot = data;
    this.record!.last_snapshot = {
      user: data.user,
      cash: data.cash,
      positions: data.positions,
      quotes: data.quotes,
      updated_at: data.updated_at,
    };
    recordLearningOrders(
      {
        market: "India",
        horizon: "trading",
        broker: this.broker,
        scope: this.account!,
      },
      data.orders,
      this.record!.tickets,
    );
    for (const ticket of this.record!.tickets) {
      if (!pendingStatuses.has(ticket.status)) continue;
      const order = data.orders.find(
        (o) =>
          (o.id === ticket.order_id || o.reference === ticket.reference) &&
          o.exchange === "NSE" &&
          o.intraday &&
          o.symbol === ticket.symbol &&
          o.side === ticket.side &&
          Number(o.quantity) === ticket.quantity,
      );
      if (!order) continue;
      ticket.order_id = order.id;
      ticket.broker_state = order.state;
      ticket.filled_quantity =
        order.state === "filled" ? ticket.quantity : order.filled_quantity;
      ticket.status = order.state === "pending" ? "submitted" : order.state;
      if (
        order.state === "rejected" ||
        (order.state === "cancelled" && !ticket.cancel_automatic)
      )
        this.stop(
          `India order ${ticket.symbol} ${order.state}; review before restarting automation.`,
        );
    }
    const day = localDay(Date.now(), "NSE");
    const pnl = data.positions.reduce(
      (n, p) =>
        n +
        (p.pnl ??
          p.realised_pnl +
            (Number(
              data.quotes[p.symbol]?.last_trade_price ?? p.average_price,
            ) -
              p.average_price) *
              p.quantity),
      0,
    );
    if (this.record!.risk?.day !== day)
      this.record!.risk = { day, baseline_pnl: pnl, halted: false };
    const risk = this.record!.risk;
    if (pnl - risk.baseline_pnl <= -this.settings.budget * 0.01)
      risk.halted = true;
    this.actions = indiaActions(
      data,
      this.feed.snapshot(),
      this.settings,
      risk,
      this.record!.tickets,
    );
    this.error = null;
    this.save(accountChanged);
  }
  private refreshFeed() {
    if (
      !this.record?.configured ||
      this.feedWork ||
      Date.now() - this.lastFeed < 15000
    )
      return;
    this.lastFeed = Date.now();
    const feed = this.feed,
      account = this.account;
    this.feedWork = feed
      .refresh(
        this.snapshot?.positions
          .filter((p) => p.quantity > 0)
          .map((p) => p.symbol) ?? [],
        Date.now(),
        (this.record?.tickets ?? [])
          .filter((t: Row) => pendingStatuses.has(t.status))
          .map((t: Row) => t.symbol),
      )
      .then((signals) => {
        if (
          this.account === account &&
          this.feed === feed &&
          this.record &&
          signals.fresh
        ) {
          this.record.last_scan = {
            asof: signals.asof,
            shortlist: signals.ranked,
          };
          this.save();
        }
      })
      .catch((error) => {
        if (this.account === account && this.feed === feed)
          this.error = errorMessage(error);
      })
      .finally(() => {
        this.feedWork = null;
        this.changed();
      });
  }
  refresh(): Promise<Row> {
    return this.lock.run(async () => {
      try {
        await this.read();
        this.refreshFeed();
      } catch (error) {
        this.error = errorMessage(error);
        this.changed();
        throw error;
      }
      return this.view();
    });
  }
  private makeTicket(action: Row, automatic: boolean): Row {
    if (!this.record?.configured)
      throw new Error(
        "Save this account's India budget and stock selection before reviewing trades.",
      );
    const observation = marketObservation(
      this.feed.snapshot().bars[action.symbol],
      Date.now(),
    );
    if (action.side === "buy" && observation)
      rememberLearning(
        {
          market: "India",
          horizon: "trading",
          broker: this.broker,
          scope: this.account!,
        },
        this.feed.snapshot().strategy,
        [{ symbol: action.symbol, ...observation, reason: action.reason }],
      );
    const ticket = {
      ...action,
      strategy: this.feed.snapshot().strategy,
      id: randomUUID(),
      reference: "in" + randomUUID().replaceAll("-", "").slice(0, 16),
      account: this.account,
      broker: this.broker,
      status: "preview",
      automatic,
      reviewed_at: new Date().toISOString(),
    };
    this.record!.tickets.push(ticket);
    this.save();
    return ticket;
  }
  preview(
    symbol: string,
    side: string,
    expected: {
      scope?: string;
      revision?: number;
      broker?: brokers.IndiaBroker;
    } = {},
  ): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      if (expected.broker && expected.broker !== this.broker)
        throw new Error(
          "The selected India broker changed. Refresh before buying.",
        );
      await this.read();
      if (expected.scope && expected.scope !== this.account)
        throw new Error(
          "The selected India account changed. Refresh before buying.",
        );
      if (
        expected.revision != null &&
        expected.revision !== (this.record?.settings_revision ?? 0)
      )
        throw new Error(
          "Trading settings changed. Reload the saved limits before buying.",
        );
      this.refreshFeed();
      const action = this.actions.find(
        (a) => a.symbol === symbol && a.side === side && a.enabled,
      );
      if (!action)
        throw new Error(
          "This India strategy trade is not eligible. Refresh its waiting reason.",
        );
      return this.makeTicket(action, false);
    });
  }
  confirm(id: string, acknowledged: boolean): Promise<Row> {
    return this.lock.run(async () => {
      if (acknowledged !== true)
        throw new Error("Explicit confirmation is required.");
      if (this.enabled)
        throw new Error("Pause India automation before manual confirmation.");
      const ticket = this.record?.tickets.find((t: Row) => t.id === id);
      if (!ticket || ticket.automatic)
        throw new Error("Manual India order preview not found.");
      await this.execute(ticket);
      return this.view();
    });
  }
  private async execute(ticket: Row) {
    if (ticket.status !== "preview")
      throw new Error(
        "India order was already submitted or its preview is no longer usable.",
      );
    this.consent(ticket.automatic, ticket.account);
    try {
      const age = Date.now() - Date.parse(ticket.reviewed_at);
      if (age < 0 || age > 120000)
        throw new TradeDecisionChanged(
          "India preview expired; refresh and review a new trade.",
        );
      await this.read();
      this.consent(ticket.automatic, ticket.account);
      const action = this.actions.find(
        (a) =>
          a.symbol === ticket.symbol && a.side === ticket.side && a.enabled,
      );
      if (!action || action.quantity < ticket.quantity)
        throw new TradeDecisionChanged(
          "India trade eligibility or quantity changed. Evaluate a fresh preview.",
        );
      if (Date.now() - Date.parse(ticket.reviewed_at) > 120000)
        throw new TradeDecisionChanged(
          "India preview expired during broker checks.",
        );
      if (
        ticket.side === "buy" &&
        (Number(action.price) * ticket.quantity * 1.01 > this.snapshot!.cash ||
          Number(action.price) * ticket.quantity >
            Number(ticket.price) * ticket.quantity * 1.005)
      )
        throw new TradeDecisionChanged(
          "Price or available funds changed; evaluate a fresh preview.",
        );
      if (ticket.side === "buy") {
        const stop = Math.max(Number(ticket.stop), Number(action.stop));
        if (!(stop > 0 && stop < Number(action.price)))
          throw new TradeDecisionChanged(
            "Entry price is no longer above the reviewed stop.",
          );
        Object.assign(ticket, {
          price: action.price,
          stop,
          initial_stop: stop,
          target: Number(action.price) + 2 * (Number(action.price) - stop),
        });
      }
      ticket.status = "submitting";
      ticket.submitted_at = new Date().toISOString();
      this.save();
      try {
        ticket.order_id = await this.sources.place(
          this.broker,
          ticket,
          ticket.reference,
        );
        ticket.status = "submitted";
        this.log(
          `${ticket.side.toUpperCase()} ${ticket.symbol}: submitted; awaiting broker fill.`,
        );
        this.save();
      } catch (error) {
        const rejected =
          error instanceof brokers.IndiaBrokerError &&
          [400, 401, 403, 422].includes(error.status);
        ticket.status = rejected ? "rejected" : "unknown";
        ticket.error = errorMessage(error);
        this.stop(
          rejected
            ? ticket.error
            : "India placement status is uncertain. Reconcile broker orders before trading again.",
        );
        this.save();
      }
    } catch (error) {
      if (ticket.status === "preview")
        ticket.status =
          error instanceof TradeDecisionChanged
            ? "superseded"
            : "not_submitted";
      ticket.error = errorMessage(error);
      this.log(ticket.error);
      this.save();
      if (!(error instanceof TradeDecisionChanged)) throw error;
    }
  }
  async setAuto(enabled: boolean, acknowledged: boolean): Promise<Row> {
    if (!enabled) {
      this.stop();
      return this.view();
    }
    return this.lock.run(async () => {
      this.idle();
      if (acknowledged !== true)
        throw new Error(
          "Explicit consent is required for India automatic trading.",
        );
      await this.read();
      if (!this.record!.configured)
        throw new Error(
          "Save the India budget and stock selection before starting automation.",
        );
      const hours = session(localDay(Date.now(), "NSE"), "NSE");
      if (
        !hours ||
        Date.now() < hours[0] ||
        Date.now() >= hours[1] - 20 * 60000
      )
        throw new Error(
          "Start an India session during regular NSE hours before the scheduled exit window.",
        );
      this.record!.auto = { enabled: true, expires_at: hours[1], error: null };
      this.log("India automatic trading enabled for this NSE session.");
      this.save();
      this.refreshFeed();
      return this.view();
    });
  }
  cancel(id: string, acknowledged: boolean): Promise<Row> {
    return this.lock.run(async () => {
      if (acknowledged !== true)
        throw new Error("Confirm order cancellation first.");
      await this.read();
      const ticket = this.record?.tickets.find((t: Row) => t.id === id);
      if (!ticket || ticket.status !== "submitted" || !ticket.order_id)
        throw new Error("Reconcile this order before cancelling it.");
      await this.sources.cancel(this.broker, ticket.order_id);
      ticket.cancel_requested = true;
      this.log(
        `Cancellation requested for ${ticket.symbol}; awaiting broker confirmation.`,
      );
      this.save();
      return this.view();
    });
  }
  tick(): Promise<void> {
    return this.lock.run(async () => {
      if (this.stopped) return;
      if (this.enabled && Date.now() >= this.record!.auto.expires_at)
        this.stop("NSE session ended. Review any remaining broker positions.");
      if (!this.enabled && !this.hasPending) return;
      try {
        await this.read();
        this.refreshFeed();
        if (!this.enabled) return;
        const hours = session(localDay(Date.now(), "NSE"), "NSE");
        for (const ticket of this.record!.tickets.filter(
          (t: Row) =>
            t.status === "submitted" && t.side === "buy" && !t.cancel_requested,
        )) {
          if (
            this.record!.risk.halted ||
            this.actions.some(
              (a) => a.symbol === ticket.symbol && a.side === "sell",
            ) ||
            (hours && Date.now() >= hours[1] - 20 * 60000) ||
            Date.now() - Date.parse(ticket.submitted_at) >= 60000
          ) {
            await this.sources.cancel(this.broker, ticket.order_id);
            ticket.cancel_requested = true;
            ticket.cancel_automatic = true;
            this.save();
            return;
          }
        }
        if (this.hasPending) return;
        const action = this.actions
          .filter((a) => a.enabled)
          .sort(
            (a, b) =>
              Number(a.side !== "sell") - Number(b.side !== "sell") ||
              a.symbol.localeCompare(b.symbol),
          )[0];
        if (action) await this.execute(this.makeTicket(action, true));
      } catch (error) {
        this.error = errorMessage(error);
        if (
          error instanceof brokers.IndiaBrokerError &&
          [401, 403].includes(error.status)
        )
          this.stop(this.error);
        this.changed();
      }
    });
  }
}

import { themeIds } from "./themes.js";
import { randomUUID } from "node:crypto";
import childProcess, { type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import {
  store,
  US,
  Mutex,
  errorMessage,
  processLock,
  type Row,
} from "./shared/storage.js";
import * as accounts from "./brokers/accounts.js";
import * as robinhood from "./brokers/robinhood.js";
import * as kite from "./brokers/kite.js";
import * as investing from "./investing.js";
import { investingState } from "./brokers/india.js";
import {
  requireBroker,
  selectedBroker,
  investmentScope,
} from "./brokers/india-selection.js";
import * as analysis from "./analysis.js";
import {
  DailyMarkets,
  compare,
  comparisonHoldings,
  comparisonIdentity,
  indiaPlan,
  indexCatalog,
  type Role,
} from "./workspaces.js";
import {
  Feed,
  active,
  ticketPending,
  failedOrderStates,
  rebalancePlan,
  eligibleActions,
} from "./trading/live.js";
import { ROTATION_STRATEGY, TradeDecisionChanged } from "./trading/rotation.js";
import { automationPreferencePath } from "./trading/automation.js";
import * as orb from "./trading/orb.js";
import { tradingProgress } from "./trading/progress.js";
import { session, localDay } from "./shared/calendar.js";
import { weeklyEvents } from "./insights.js";
import { IndiaTrading } from "./trading/india.js";
import { gemsPlan } from "./brokers/gems-plan.js";
import {
  rememberLearning,
  marketObservation,
  recordPaperLearning,
  recordLearningOrders,
} from "./learning.js";
export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed";
  result: unknown;
  error: string | null;
}
export class Service {
  private readonly lock = new Mutex();
  private readonly liveListeners = new Set<(topic: string) => void>();
  subscribeLive(listener: (topic: string) => void): () => void {
    this.liveListeners.add(listener);
    return () => {
      this.liveListeners.delete(listener);
    };
  }
  private publishLive(topic = "live") {
    for (const listener of this.liveListeners) {
      try {
        listener(topic);
      } catch {
        /* A disconnected dashboard cannot interrupt trading. */
      }
    }
  }
  private readonly analysisLock = new Mutex();
  private readonly daily = new DailyMarkets();
  private readonly feed = new Feed();
  readonly india = new IndiaTrading((selectionChanged = false) => {
    this.preventSleep();
    this.publishLive("india-trading");
    if (selectionChanged) {
      this.publishLive("portfolios");
      this.publishLive("comparisons");
      this.publishLive("weekly");
      this.publishLive("kite-batches");
    }
  });
  private indiaWork: Promise<void> | null = null;
  private lastIndia = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly connections = new Map<
    string,
    { seen: number; live: boolean }
  >();
  private state: Row;
  private readonly path = join(US, "varshan_workspace.json");
  private snapshot: Row | null = null;
  private model: Row | null = null;
  private liveError: string | null = null;
  private auto: Row = { enabled: false, error: null, connection: null };
  private timer?: NodeJS.Timeout;
  private awake?: ChildProcess;
  private release?: () => void;
  private stopped = false;
  private notification:
    ((id: string, title: string, body: string) => void) | null = null;
  setNotifier(callback: (id: string, title: string, body: string) => void) {
    this.notification = callback;
  }
  private notify(id: string, title: string, body: string) {
    try {
      this.notification?.(id, title, body);
    } catch {
      /* Notification storage cannot interrupt trading. */
    }
  }
  private ticking = false;
  private lastLive = 0;
  private liveRetryAt = 0;
  private liveFailures = 0;
  private lastFeed = 0;
  private feedWork: Promise<unknown> | null = null;
  private liveRequested = false;
  private lastPaper = 0;
  private paperWork: Promise<void> | null = null;
  constructor(
    private readonly workers = true,
    initialState?: Row,
    private readonly broker: typeof robinhood.connected = robinhood.connected,
  ) {
    this.state =
      initialState ??
      store.json<Row>(this.path, {
        comparisons: {},
        batch: null,
        india_draft: null,
      });
    this.state.comparisons ??= {};
    const saved = store.json<Row | null>(automationPreferencePath, null);
    if (saved?.version === 1 && saved.enabled === true) {
      try {
        const number = accounts.roles().trading;
        if (
          number &&
          saved.scope === accounts.scope(number) &&
          Number.isFinite(saved.expires_at) &&
          Date.now() < saved.expires_at &&
          accounts.settings(number).budget
        ) {
          this.auto = {
            enabled: true,
            error: null,
            connection: null,
            background: true,
            account: number,
            session_id: saved.session_id || randomUUID(),
            expires_at: saved.expires_at,
            resumed: true,
          };
          this.liveRequested = true;
        }
      } catch (e) {
        this.auto.error = this.error(e);
      }
    }
    const b = this.state.batch;
    if (b?.automatic && (b.status === "preview" || active.has(b.status))) {
      b.status = this.auto.enabled ? "interrupted" : "stopped";
      b.error = this.auto.enabled
        ? "App restarted; broker orders will be checked before a fresh rebalance."
        : "Automatic trading is paused or its saved session has expired.";
      b.progress = b.error;
    }
  }
  private saveAutomation() {
    store.save(automationPreferencePath, {
      version: 1,
      enabled: this.auto.enabled === true && this.auto.background === true,
      scope: this.auto.account ? accounts.scope(this.auto.account) : null,
      session_id: this.auto.session_id ?? null,
      expires_at: this.auto.expires_at ?? null,
      updated_at: new Date().toISOString(),
    });
    this.preventSleep();
  }
  private preventSleep() {
    if (!this.workers || process.platform !== "darwin") return;
    if (this.stopped || (!this.auto.enabled && !this.india.enabled)) {
      this.awake?.kill();
      this.awake = undefined;
    } else if (!this.awake) {
      // Keep background execution running when the display sleeps.
      const child = childProcess.spawn(
        "/usr/bin/caffeinate",
        ["-i", "-w", String(process.pid)],
        { stdio: "ignore" },
      );
      this.awake = child;
      child.once("error", (error) => {
        if (this.awake !== child) return;
        this.awake = undefined;
        this.auto.enabled = false;
        this.india.stop(`Could not prevent idle sleep: ${this.error(error)}`);
        this.disableAuto(`Could not prevent idle sleep: ${this.error(error)}`);
      });
      child.once("exit", () => {
        if (this.awake !== child) return;
        this.awake = undefined;
        this.auto.enabled = false;
        this.india.stop(
          "Idle-sleep protection stopped. Restart India automatic trading to restore it.",
        );
        this.disableAuto(
          "Idle-sleep protection stopped. Restart automatic trading to restore it.",
        );
      });
    }
  }
  private save() {
    store.save(this.path, this.state);
    this.publishLive();
  }
  start() {
    if (!this.workers) return;
    this.release = processLock(join(US, ".varshan-node.lock"));
    this.preventSleep();
    if (
      this.state.batch?.automatic &&
      ["stopped", "interrupted"].includes(this.state.batch.status)
    )
      this.save();
    if (this.auto.resumed)
      this.recordLive("automation", {
        message:
          "Automatic trading resumed after app restart with the original session expiry.",
      });
    this.timer = setInterval(() => {
      void this.tick();
    }, 250);
  }
  async close() {
    this.stopped = true;
    this.india.close();
    this.preventSleep();
    if (this.auto.enabled && this.auto.background) {
      this.saveAutomation();
      this.recordLive("automation", {
        message:
          "Server stopping; automatic trading choice is saved for restart.",
      });
    } else if (this.auto.enabled) this.disableAuto("Varshan server stopped.");
    if (this.timer) clearInterval(this.timer);
    while (this.ticking) await new Promise((r) => setTimeout(r, 50));
    await this.indiaWork;
    const batch = this.state.batch;
    if (
      this.auto.enabled &&
      this.auto.background &&
      batch?.automatic &&
      (batch.status === "preview" || active.has(batch.status))
    ) {
      batch.status = "interrupted";
      batch.progress =
        "Server stopped; broker orders will be checked before a fresh rebalance.";
      this.save();
    }
    if (this.workers && this.broker === robinhood.connected)
      await robinhood.closeConnection();
    this.liveListeners.clear();
    this.release?.();
  }
  job(kind: string, action: () => Promise<unknown> | unknown): Job {
    const existing = [...this.jobs.values()].find(
      (j) => j.kind === kind && ["queued", "running"].includes(j.status),
    );
    if (existing) return { ...existing };
    if (this.jobs.size >= 100) {
      for (const [id, j] of this.jobs) {
        if (["completed", "failed"].includes(j.status)) {
          this.jobs.delete(id);
          break;
        }
      }
      if (this.jobs.size >= 100)
        throw new Error(
          "Too many pending jobs. Wait for existing work to complete.",
        );
    }
    const job: Job = {
      id: randomUUID(),
      kind,
      status: "queued",
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    queueMicrotask(() => {
      job.status = "running";
      void Promise.resolve()
        .then(action)
        .then((result) => {
          job.result = result;
          job.status = "completed";
        })
        .catch((e) => {
          job.error = this.error(e);
          job.status = "failed";
        });
    });
    return { ...job };
  }
  jobStatus(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job not found.");
    return { ...job };
  }
  error(e: unknown): string {
    let message = errorMessage(e);
    try {
      for (const n of Object.values(accounts.roles()))
        if (n) message = message.replaceAll(n, "••••" + n.slice(-4));
    } catch {}
    return message;
  }
  accountState(): Row {
    try {
      const r = accounts.roles();
      return {
        roles: Object.fromEntries(
          Object.entries(r).map(([role, n]) => [
            role,
            {
              selected: !!n,
              ending: n ? "••••" + n.slice(-4) : null,
              scope: accounts.scope(n),
            },
          ]),
        ),
        kite_connected: kite.tokenCurrent(),
        live_settings: accounts.settings(r.trading),
      };
    } catch (e) {
      return {
        roles: {
          long_term: { selected: false, ending: null },
          trading: { selected: false, ending: null },
        },
        kite_connected: kite.tokenCurrent(),
        live_settings: { budget: null, reserve_pct: null },
        error: this.error(e),
      };
    }
  }
  async availableAccounts(): Promise<Row[]> {
    const available = await robinhood.listAccounts();
    let r: ReturnType<typeof accounts.roles>;
    try {
      r = accounts.roles();
    } catch {
      r = { long_term: null, trading: null };
    }
    return available.map((a: Row) => ({
      id: a.account_number,
      label: `${a.type ?? a.account_type ?? "Robinhood"} ••••${a.account_number.slice(-4)}`,
      agentic_allowed: a.agentic_allowed === true,
      long_term: r.long_term === a.account_number,
      trading: r.trading === a.account_number,
    }));
  }
  private idle() {
    if (this.auto.enabled)
      throw new Error(
        "Pause automatic trading before changing account settings.",
      );
    if (this.state.batch && active.has(this.state.batch.status))
      throw new Error(
        "Wait for the active rebalance to finish before changing settings.",
      );
  }
  async changeRoles(long: string, trading: string): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      const available = await robinhood.listAccounts();
      accounts.saveRoles(long, trading, available);
      this.auto = { enabled: false, error: null, connection: null };
      this.saveAutomation();
      this.snapshot = null;
      this.model = null;
      this.state.batch = null;
      this.state.india_draft = null;
      this.save();
      return this.accountState();
    });
  }
  sync(): Promise<Row> {
    return this.lock.run(() => robinhood.syncHoldings());
  }
  setSettings(budget: number, reserve: number): Promise<Row> {
    return this.lock.run(() => {
      this.idle();
      const number = accounts.roles().trading;
      if (!number) throw new Error("Select a daily trading account first.");
      accounts.saveSettings(number, budget, reserve);
      this.model = null;
      return this.accountState();
    });
  }
  portfolios() {
    return analysis.portfolios();
  }
  preferences() {
    return {
      top_benchmarks: this.state.top_benchmarks ?? ["Nifty 50", "S&P 500"],
      catalog: indexCatalog,
      privacy_mode: this.state.privacy_mode ?? false,
      chart_provider: this.state.chart_provider ?? "yahoo",
      chart_view: this.state.chart_view ?? "embedded",
      theme: this.state.theme ?? "light",
      supported_themes: themeIds,
    };
  }
  setLearningExecution(enabled: boolean): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      if (this.pendingSymbols().length)
        throw new Error(
          "Reconcile pending US orders before changing learning settings.",
        );
      const settings = await this.india.setLearningExecution(enabled);
      this.model = null;
      return settings;
    });
  }
  savePreferences(input: string[] | Row) {
    const patch: Row = Array.isArray(input) ? { top_benchmarks: input } : input;
    const names: string[] =
      patch.top_benchmarks ?? this.preferences().top_benchmarks;
    if (
      !names.length ||
      names.length > 6 ||
      new Set(names).size !== names.length ||
      names.some((name) => !indexCatalog.some((entry) => entry.name === name))
    )
      throw new Error("Select one to six distinct supported indices.");
    for (const key of ["privacy_mode", "chart_provider", "chart_view", "theme"])
      if (patch[key] !== undefined) this.state[key] = patch[key];
    this.state.top_benchmarks = names;
    this.save();
    return this.preferences();
  }
  indices() {
    return this.daily.snapshot(Date.now(), this.preferences().top_benchmarks);
  }
  weekly(role: Role): Row | null {
    const saved = this.state.weeklies?.[comparisonIdentity(role)];
    if (!saved) return null;
    let changed = true;
    try {
      changed =
        JSON.stringify(saved.positions) !==
        JSON.stringify(comparisonHoldings(role, this.snapshot).rows);
    } catch {
      /* Keep dated report available. */
    }
    return { ...saved, holdings_changed: changed };
  }
  private async loadInsightPositions(role: Role): Promise<void> {
    if (role !== "trading") return;
    const number = accounts.roles().trading;
    if (!number)
      throw new Error(
        "Select the daily trading account in Account settings first.",
      );
    if (
      this.snapshot?.account_number === number &&
      Date.now() - Date.parse(this.snapshot.updated_at) < 300000
    )
      return;
    await this.lock.run(async () => {
      const snapshot = await robinhood.snapshot(number);
      if (accounts.roles().trading !== number)
        throw new Error("Trading account changed while loading positions.");
      this.snapshot = snapshot;
      this.model = null;
    });
  }
  async refreshWeekly(role: Role): Promise<Row> {
    await this.loadInsightPositions(role);
    const identity = comparisonIdentity(role),
      held = comparisonHoldings(role, this.snapshot);
    const result = await weeklyEvents(held.rows, role);
    if (comparisonIdentity(role) !== identity)
      throw new Error("Account selection changed while reviewing.");
    if (
      JSON.stringify(comparisonHoldings(role, this.snapshot).rows) !==
      JSON.stringify(held.rows)
    )
      throw new Error("Holdings changed during review. Refresh the report.");
    const scoped = {
      ...result,
      scope:
        role === "India"
          ? investmentScope()
          : accounts.scope(accounts.roles()[role]),
      positions: held.rows,
    };
    this.state.weeklies ??= {};
    this.state.weeklies[identity] = scoped;
    this.state.weeklies = Object.fromEntries(
      Object.entries(this.state.weeklies).slice(-30),
    );
    this.save();
    return scoped;
  }
  markets() {
    return this.daily.snapshot();
  }
  analyze(market: "India" | "US") {
    return this.analysisLock.run(() => analysis.refreshAnalysis(market));
  }
  analyzeGems(market: "India" | "US") {
    return this.analysisLock.run(() => analysis.refreshGems(market));
  }
  private gemsPlanFile() {
    return join(
      US,
      `gems_plan_${accounts.scope(accounts.roles().long_term)}.json`,
    );
  }
  usGemsPlan(): Row {
    const saved = store.json<Row>(this.gemsPlanFile(), {}),
      config = saved.config ?? { budget: 10000, reserve_pct: 10 };
    return {
      ...gemsPlan(
        analysis.gemsRows("US"),
        config.budget,
        config.reserve_pct,
        saved.reviews ?? {},
        Date.now(),
        Date.parse(config.started_at) || Date.now(),
      ),
      scope: accounts.scope(accounts.roles().long_term),
      reviews: saved.reviews ?? {},
      saved: !!saved.config,
    };
  }
  saveUsGemsPlan(budget: number, reserve_pct: number): Row {
    accounts.validateBudget(budget, reserve_pct);
    const file = this.gemsPlanFile(),
      saved = store.json<Row>(file, {});
    saved.config = {
      budget,
      reserve_pct,
      started_at: new Date().toISOString(),
    };
    store.save(file, saved);
    return this.usGemsPlan();
  }
  saveGemsReview(review: Row): Row {
    const now = Date.now();
    if (
      !analysis
        .gemsRows("US")
        .some(
          (row) =>
            row.symbol === review.symbol &&
            row.gems_candidate === true &&
            now - Date.parse(row.scanned_at) >= 0 &&
            now - Date.parse(row.scanned_at) < 86400000,
        )
    )
      throw new Error(
        "Refresh US Gems analysis and choose a current candidate before recording its review.",
      );
    const file = this.gemsPlanFile(),
      saved = store.json<Row>(file, {});
    saved.reviews ??= {};
    saved.reviews[review.symbol] = {
      ...review,
      reviewed_at: new Date(now).toISOString(),
    };
    store.save(file, saved);
    return this.usGemsPlan();
  }
  comparison(role: Role): Row | null {
    const identity = comparisonIdentity(role);
    const saved = this.state.comparisons[identity];
    if (!saved) return null;
    let changed = true;
    try {
      const current = comparisonHoldings(role, this.snapshot).rows.map((h) => [
        h.symbol,
        h.qty,
      ]);
      const original = saved.holdings.map((h: Row | string[]) =>
        Array.isArray(h) ? h : [h.symbol, h.qty],
      );
      changed = JSON.stringify(current) !== JSON.stringify(original);
    } catch {
      /* Saved graphs remain readable when fresh holdings are unavailable. */
    }
    return { ...saved, holdings_changed: changed };
  }
  async compare(
    role: Role,
    benchmark: string | string[],
    period: string,
  ): Promise<Row> {
    await this.loadInsightPositions(role);
    const identity = comparisonIdentity(role);
    const result = await compare(role, benchmark, period, this.snapshot);
    if (comparisonIdentity(role) !== identity)
      throw new Error("Account selection changed while comparing.");
    this.state.comparisons[identity] = result;
    this.state.comparisons = Object.fromEntries(
      Object.entries(this.state.comparisons).slice(-30),
    );
    this.save();
    return result;
  }
  private recordEquity() {
    const snapshot = this.snapshot;
    const raw = snapshot?.portfolio?.total_value;
    if (raw === undefined || raw === null || raw === "") return;
    const equity = Number(raw);
    if (!snapshot?.account_number || !Number.isFinite(equity) || equity < 0)
      return;
    const scope = accounts.scope(snapshot.account_number);
    const histories = (this.state.equity_histories ??= {});
    const rows: Row[] = (histories[scope] ??= []);
    const date = snapshot.updated_at;
    if (
      !date ||
      (rows.length && Date.parse(date) - Date.parse(rows.at(-1)!.date) < 5000)
    )
      return;
    rows.push({ date, equity });
    histories[scope] = rows.slice(-2000);
    this.save();
  }
  liveView(): Row {
    const number = accounts.roles().trading;
    const snapshot =
      this.snapshot?.account_number === number ? this.snapshot : null;
    const model = snapshot ? this.model : null;
    const batch =
      this.state.batch?.account === number ? this.state.batch : null;
    const tickets = robinhood.listTickets(number);
    return {
      monitor: accounts.mask(
        tradingProgress(
          this.feed.snapshot(),
          snapshot,
          model,
          this.auto,
          batch,
          tickets,
          this.liveError,
        ),
        number,
      ),
      scope: accounts.scope(number),
      decision_history: accounts.mask(
        (this.state.live_history?.[accounts.scope(number)] ?? []).slice(-100),
        number,
      ),
      equity_history:
        this.state.equity_histories?.[accounts.scope(number)] ?? [],
      snapshot:
        this.snapshot?.account_number === number
          ? accounts.mask(this.snapshot, number)
          : null,
      model: this.snapshot?.account_number === number ? this.model : null,
      error: this.liveError,
      auto: {
        enabled: this.auto.enabled,
        error: this.auto.error,
        background: this.auto.background ?? false,
        remembered: this.auto.background === true,
        expires_at: this.auto.expires_at
          ? new Date(this.auto.expires_at).toISOString()
          : null,
      },
      batch:
        this.state.batch?.account === number
          ? accounts.mask(this.state.batch, number)
          : null,
      tickets: accounts.mask(
        tickets.map((ticket) => ({
          ...ticket,
          recovery_orders: robinhood.recoveryOrders(
            ticket,
            snapshot?.orders ?? [],
            tickets,
          ),
        })),
        number,
      ),
    };
  }
  private recordLive(kind: string, detail: Row) {
    const number = accounts.roles().trading;
    if (!number) return;
    const scope = accounts.scope(number);
    const history: Row[] = this.state.live_history?.[scope] ?? [];
    const summary =
      kind === "decision"
        ? (detail.actions ?? [])
            .map((a: Row) => `${a.symbol} ${a.action}: ${a.reason}`)
            .join(" · ") ||
          detail.message ||
          "Waiting for strategy data."
        : detail.message;
    const last = history.at(-1);
    if (
      kind === "decision" &&
      last?.kind === kind &&
      last.summary === summary &&
      last.automatic === this.auto.enabled &&
      Date.now() - Date.parse(last.created_at) < 60000
    )
      return;
    history.push({
      created_at: new Date().toISOString(),
      kind,
      automatic: this.auto.enabled,
      summary,
      ...detail,
    });
    this.state.live_history ??= {};
    this.state.live_history[scope] = history.slice(-2000);
    this.save();
  }
  private consent(batch?: Row) {
    if (this.stopped)
      throw new Error("Server is stopping; remaining orders were not sent.");
    if (batch?.automatic) {
      if (this.auto.background) {
        if (
          !this.auto.enabled ||
          Date.now() >= this.auto.expires_at ||
          accounts.roles().trading !== this.auto.account
        )
          throw new Error(
            "Backend trading session expired or the trading account changed.",
          );
        return;
      }
      const c = this.connections.get(this.auto.connection);
      if (!this.auto.enabled || !c || Date.now() - c.seen >= 25000)
        throw new Error(
          "Automatic trading session expired; remaining orders were not sent.",
        );
    }
  }
  private async decisions(
    batch?: Row,
    broker = this.broker,
  ): Promise<{ model: Row; signals: ReturnType<Feed["snapshot"]> }> {
    this.consent(batch);
    const number = accounts.roles().trading;
    if (!number)
      throw new Error("Select a daily trading Robinhood account first.");
    const wanted = this.feed.snapshot();
    this.snapshot = await robinhood.snapshot(
      number,
      wanted.ranked.map((r) => r.symbol),
      broker,
    );
    this.recordEquity();
    recordLearningOrders(
      {
        market: "US",
        horizon: "trading",
        broker: "robinhood",
        scope: accounts.scope(number),
      },
      this.snapshot.orders ?? [],
      robinhood.listTickets(number),
    );
    this.consent(batch);
    for (const t of robinhood.listTickets(number))
      if (["submitted", "submitting", "unknown"].includes(t.status))
        robinhood.reconcileFromOrders(t, this.snapshot.orders ?? []);
    const signals = this.feed.snapshot();
    const settings = accounts.settings(number);
    this.model = rebalancePlan(
      this.snapshot,
      signals,
      settings.budget,
      settings.reserve_pct,
      robinhood.listTickets(number),
    );
    if (signals.fresh)
      rememberLearning(
        {
          market: "US",
          horizon: "trading",
          broker: "robinhood",
          scope: accounts.scope(number),
        },
        signals.strategy,
        (signals.candidates ?? signals.ranked).flatMap((pick) => {
          const observation = marketObservation(
            signals.bars[pick.symbol],
            Date.now(),
          );
          const decision = this.model!.actions.find(
            (a: Row) => a.symbol === pick.symbol,
          );
          return observation
            ? [
                {
                  ...pick,
                  ...observation,
                  reason:
                    decision?.reason ??
                    "Observed US trading scan; no order required",
                },
              ]
            : [];
        }),
      );
    this.liveError = null;
    this.recordLive("decision", {
      signal_time: signals.asof,
      signal_fresh: signals.fresh,
      message: this.model.message,
      actions: this.model.actions,
    });
    return { model: this.model, signals };
  }
  private pendingSymbols(): string[] {
    const pending = new Set([
      "new",
      "queued",
      "confirmed",
      "unconfirmed",
      "partially_filled",
      "pending_cancelled",
      "locating",
    ]);
    const orders: Row[] = this.snapshot?.orders ?? [];
    return [
      ...new Set([
        ...orders.filter((o) => pending.has(o.state)).map((o) => o.symbol),
        ...robinhood
          .listTickets(accounts.roles().trading)
          .filter((t) => ticketPending(t, orders))
          .map((t) => t.arguments.symbol),
      ]),
    ];
  }
  async refreshLive(): Promise<Row> {
    return this.lock.run(async () => {
      try {
        void this.feed
          .refresh(
            this.snapshot?.positions?.map((p: Row) => p.symbol) ?? [],
            Date.now(),
            this.pendingSymbols(),
          )
          .catch(() => {});
        await this.decisions();
      } catch (e) {
        this.liveError = this.error(e);
        throw e;
      }
      return this.liveView();
    });
  }
  private async prepare(
    automatic = false,
    broker = this.broker,
    current?: { signals: ReturnType<Feed["snapshot"]> },
    buySymbol?: string,
  ): Promise<Row> {
    const { signals } =
        current ??
        (await this.decisions(
          automatic ? { automatic: true } : undefined,
          broker,
        )),
      number = accounts.roles().trading!,
      settings = accounts.settings(number),
      plan = rebalancePlan(
        this.snapshot!,
        signals,
        settings.budget,
        settings.reserve_pct,
        robinhood.listTickets(number),
      ),
      actions = eligibleActions(plan).filter(
        (a) =>
          !buySymbol ||
          (a.symbol === buySymbol && a.side === "buy" && !a.after_sell_fills),
      );
    if (
      buySymbol &&
      (!signals.fresh || !signals.ranked.some((p) => p.symbol === buySymbol))
    )
      throw new Error(
        "This stock is not on the current US trading shortlist. Refresh the shortlist first.",
      );
    if (buySymbol && !actions.length) {
      const decision = plan.actions.find((a: Row) => a.symbol === buySymbol);
      throw new Error(
        decision?.after_sell_fills
          ? "This buy depends on confirmed sales. Review the full rebalance first."
          : (decision?.reason ??
              "This shortlisted stock is not currently eligible to buy."),
      );
    }
    if (!actions.length)
      throw new Error("No eligible buys or sells at this time.");
    if (new Set(actions.map((a) => a.symbol)).size !== actions.length)
      throw new Error("Duplicate stock decisions.");
    const batch: Row = {
      id: randomUUID(),
      account: number,
      ticket_ids: [],
      status: "preview",
      automatic,
      ...(buySymbol ? { buy_symbol: buySymbol } : {}),
    };
    for (const a of actions) {
      this.consent(batch);
      const observation = marketObservation(signals.bars[a.symbol], Date.now());
      if (a.side === "buy" && observation)
        rememberLearning(
          {
            market: "US",
            horizon: "trading",
            broker: "robinhood",
            scope: accounts.scope(number),
          },
          signals.strategy,
          [
            {
              symbol: a.symbol,
              ...observation,
              reason: a.reason,
              net_reward_risk: a.net_reward_risk,
            },
          ],
        );
      const ticket = await robinhood.preview(
        robinhood.argumentsFor(number, a),
        broker,
      );
      Object.assign(ticket, {
        origin: "strategy",
        strategy: signals.strategy,
        learning_reason: a.reason,
        signal_time: signals.asof,
        rebalance_id: batch.id,
        stop: a.stop ?? null,
        target: a.target ?? null,
        initial_stop: a.initial_stop ?? a.stop ?? null,
        risk_entry: a.risk_entry ?? a.price ?? null,
        risk_started_at: a.risk_started_at ?? ticket.reviewed_at,
        top_up: a.top_up === true,
      });
      robinhood.saveTicket(ticket);
      batch.ticket_ids.push(ticket.id);
    }
    this.state.batch = batch;
    this.save();
    return batch;
  }
  previewLive(symbol?: string, expectedScope?: string): Promise<Row> {
    return this.lock.run(async () => {
      this.idle();
      if (
        expectedScope &&
        expectedScope !== accounts.scope(accounts.roles().trading)
      )
        throw new Error(
          "The selected US trading account changed. Refresh before buying.",
        );
      await this.broker(async (s) =>
        this.prepare(false, async (action) => action(s), undefined, symbol),
      );
      return this.liveView();
    });
  }
  private async fitTicket(
    ticket: Row,
    action: Row | undefined,
    batch: Row,
    broker: typeof robinhood.connected,
  ) {
    const field =
      ticket.arguments.side === "buy" ? "dollar_amount" : "quantity";
    if (
      batch.buy_symbol &&
      !this.feed.snapshot().ranked.some((p) => p.symbol === batch.buy_symbol)
    )
      throw new TradeDecisionChanged(
        "The selected stock is no longer shortlisted. Review a new order.",
      );
    if (
      batch.buy_symbol &&
      (ticket.arguments.side !== "buy" ||
        ticket.arguments.symbol !== batch.buy_symbol ||
        action?.after_sell_fills)
    )
      throw new TradeDecisionChanged(
        "The selected buy no longer qualifies independently. Review a new order.",
      );
    if (!action?.enabled)
      throw new TradeDecisionChanged(
        `${ticket.arguments.symbol}: ${action?.reason ?? "Strategy trade no longer qualifies."}`,
      );
    const saveRiskLevels = () => {
      if (field !== "dollar_amount" || ticket.strategy !== ROTATION_STRATEGY)
        return;
      const stop = Decimal.max(
        ticket.stop ?? action.stop,
        action.stop,
      ).toString();
      Object.assign(ticket, {
        stop,
        initial_stop: action.top_up ? action.initial_stop : stop,
        risk_entry: action.risk_entry,
        risk_started_at: action.risk_started_at,
        target: action.top_up
          ? action.target
          : new Decimal(action.price)
              .plus(new Decimal(action.price).minus(stop).times(2))
              .toString(),
      });
      robinhood.saveTicket(ticket);
    };
    if (new Decimal(ticket.arguments[field]).lte(action[field])) {
      saveRiskLevels();
      return;
    }
    if (
      !batch.automatic ||
      field !== "dollar_amount" ||
      new Decimal(action[field]).lte(0)
    )
      throw new TradeDecisionChanged(
        `${ticket.arguments.symbol}: current trade limit decreased. Review a new rebalance.`,
      );
    const args = { ...ticket.arguments, dollar_amount: action.dollar_amount };
    // An automatic order may shrink within consent, but can never grow beyond
    // its original preview. Re-review the exact reduced amount with the broker.
    const preview = await robinhood.review(args, broker);
    this.consent(batch);
    ticket.arguments = args;
    ticket.preview = preview;
    ticket.reviewed_at = new Date().toISOString();
    saveRiskLevels();
    robinhood.saveTicket(ticket);
  }
  private async validateTicket(
    ticket: Row,
    s: robinhood.BrokerSession,
    batch: Row,
  ): Promise<void> {
    this.consent(batch);
    if (
      ![orb.STRATEGY, ROTATION_STRATEGY].includes(ticket.strategy) ||
      ticket.origin !== "strategy" ||
      ticket.rebalance_id !== batch.id
    )
      throw new Error("Strategy ticket changed.");
    const snapshot = await robinhood.readSnapshot(
        s,
        ticket.arguments.account_number,
        this.feed.snapshot().ranked.map((r) => r.symbol),
      ),
      settings = accounts.settings(ticket.arguments.account_number),
      other = robinhood
        .listTickets(ticket.arguments.account_number)
        .filter((t) => t.id !== ticket.id),
      model = rebalancePlan(
        snapshot,
        this.feed.snapshot(),
        settings.budget,
        settings.reserve_pct,
        other,
      ),
      a = model.actions.find(
        (a: Row) =>
          a.symbol === ticket.arguments.symbol &&
          a.side === ticket.arguments.side,
      ),
      broker: typeof robinhood.connected = async (action) => action(s);
    await this.fitTicket(ticket, a, batch, broker);
  }
  private async begin(
    batch: Row,
    acknowledged: boolean,
    broker = this.broker,
  ): Promise<void> {
    if (acknowledged !== true)
      throw new Error("Review and confirm the rebalance before submitting.");
    if (
      batch.status !== "preview" ||
      batch.account !== accounts.roles().trading
    )
      throw new Error("Rebalance already confirmed or account changed.");
    const { signals } = await this.decisions(batch, broker),
      settings = accounts.settings(batch.account),
      plan = rebalancePlan(
        this.snapshot!,
        signals,
        settings.budget,
        settings.reserve_pct,
        robinhood.listTickets(batch.account),
      ),
      actions = eligibleActions(plan),
      all = robinhood.tickets(),
      tickets: Row[] = batch.ticket_ids.map((id: string) => all[id]);
    for (const t of tickets) {
      if (!t)
        throw new TradeDecisionChanged("Rebalance ticket is unavailable.");
      const a = actions.find(
        (a) => a.symbol === t.arguments.symbol && a.side === t.arguments.side,
      );
      if (
        !t ||
        !robinhood.previewCurrent(t) ||
        t.rebalance_id !== batch.id ||
        t.arguments.account_number !== batch.account ||
        !a
      )
        throw new TradeDecisionChanged(
          "Rebalance preview expired or decisions changed.",
        );
      await this.fitTicket(t, a, batch, broker);
    }
    if (!tickets.length) throw new Error("Empty rebalance.");
    batch.status = "running";
    batch.results = [];
    batch.ordered_ids = tickets
      .sort(
        (a, b) =>
          Number(a.arguments.side !== "sell") -
            Number(b.arguments.side !== "sell") ||
          a.arguments.symbol.localeCompare(b.arguments.symbol),
      )
      .map((t) => t.id);
    batch.confirmed_at = new Date().toISOString();
    this.save();
    await this.advance(batch, broker);
  }
  private async advance(batch: Row, broker = this.broker): Promise<void> {
    try {
      this.consent(batch);
      if (batch.account !== accounts.roles().trading)
        throw new Error("Trading account changed.");
      const last = batch.results.at(-1);
      if (last?.status === "pending") {
        const t = await robinhood.reconcile(last.id, broker),
          state = t.result?.order?.state;
        last.broker_state = state ?? null;
        if (failedOrderStates.has(state))
          throw new Error("Order failed; remaining orders were not sent.");
        if (state !== "filled") {
          batch.status =
            last.side === "sell" ? "waiting_sales" : "waiting_buys";
          batch.progress = `Waiting for ${last.symbol} to fill…`;
          this.save();
          return;
        }
        last.status = "filled";
        this.save();
      }
      while (batch.results.length < batch.ordered_ids.length) {
        this.consent(batch);
        const id = batch.ordered_ids[batch.results.length],
          ticket = robinhood.tickets()[id];
        if (!ticket || !robinhood.previewCurrent(ticket))
          throw new TradeDecisionChanged(
            "Unsent preview expired; the strategy will evaluate a fresh rebalance.",
          );
        if (ticket.arguments.side === "buy") {
          const { model } = await this.decisions(batch, broker),
            action = model.actions.find(
              (a: Row) =>
                a.symbol === ticket.arguments.symbol && a.side === "buy",
            );
          if (
            !action?.enabled &&
            action?.reason?.startsWith("No cash available")
          ) {
            batch.status = "waiting_funds";
            batch.progress = `Waiting for settled buying power for ${ticket.arguments.symbol}.`;
            this.save();
            return;
          }
          await this.fitTicket(ticket, action, batch, broker);
        }
        batch.status = "running";
        batch.progress = `Submitting ${ticket.arguments.side.toUpperCase()} ${ticket.arguments.symbol}…`;
        this.save();
        const receipt = await robinhood.submit(
            id,
            true,
            (t, s) => this.validateTicket(t, s, batch),
            () => this.consent(batch),
            broker,
          ),
          state = receipt.result?.order?.state,
          row = {
            id,
            symbol: ticket.arguments.symbol,
            side: ticket.arguments.side,
            status: state === "filled" ? "filled" : "pending",
            broker_state: state ?? null,
          };
        batch.results.push(row);
        this.recordLive("order", {
          message: `${row.side.toUpperCase()} ${row.symbol}: ${receipt.status} (${state ?? "unconfirmed"})`,
          ticket_id: id,
          symbol: row.symbol,
          status: receipt.status,
          broker_state: state,
        });
        this.save();
        if (batch.automatic)
          this.notify(
            `order:${row.id}:${row.status}`,
            "Automatic trade update",
            "A broker order was submitted or needs review. Open Varshan for its status.",
          );
        if (receipt.status !== "submitted" || failedOrderStates.has(state)) {
          row.status = receipt.status;
          if (receipt.status === "not_submitted" && receipt.decision_changed)
            throw new TradeDecisionChanged(receipt.error);
          throw new Error(
            receipt.error ??
              "Order failed or unresolved; remaining orders were not sent.",
          );
        }
        if (state !== "filled") {
          batch.status = row.side === "sell" ? "waiting_sales" : "waiting_buys";
          batch.progress = `Waiting for ${row.symbol} to fill…`;
          this.save();
          return;
        }
      }
      batch.status = "completed";
      batch.progress = "Orders are successfully executed.";
      if (batch.automatic)
        this.notify(
          `complete:${batch.id}`,
          "Automatic rebalance completed",
          "Broker orders completed. Open Varshan to review the account.",
        );
    } catch (e) {
      const interrupted =
        this.stopped &&
        !batch.results?.some(
          (r: Row) =>
            ["unknown", "rejected", "failed"].includes(r.status) ||
            failedOrderStates.has(r.broker_state),
        );
      batch.status = interrupted
        ? "interrupted"
        : batch.automatic && e instanceof TradeDecisionChanged
          ? "superseded"
          : "stopped";
      batch.error = this.error(e);
      this.recordLive("error", {
        message: batch.error,
        batch_status: batch.status,
      });
      if (
        batch.automatic &&
        !interrupted &&
        !(e instanceof TradeDecisionChanged)
      ) {
        this.auto.enabled = false;
        this.auto.error = batch.error;
        this.saveAutomation();
        this.notify(
          `stopped:${batch.id}`,
          "Automatic trading paused",
          "Trading stopped because an order needs attention. Review Varshan before restarting.",
        );
      }
    }
    this.save();
  }
  confirmLive(id: string, acknowledged: boolean): Promise<Row> {
    return this.lock.run(async () => {
      if (this.auto.enabled)
        throw new Error("Pause automatic trading before manually confirming.");
      const batch = this.state.batch;
      if (!batch || batch.id !== id) throw new Error("Rebalance not found.");
      if (batch.automatic)
        throw new Error(
          "Automatic rebalances do not require manual confirmation.",
        );
      await this.broker(async (s) =>
        this.begin(batch, acknowledged, async (action) => action(s)),
      );
      return this.liveView();
    });
  }
  reconcileLive(): Promise<Row> {
    return this.refreshLive();
  }
  linkLiveOrder(
    id: string,
    orderId: string,
    acknowledged: boolean,
  ): Promise<Row> {
    return this.lock.run(async () => {
      await robinhood.linkOrder(id, orderId, acknowledged, this.broker);
      await this.decisions();
      return this.liveView();
    });
  }
  touch(id: string, live = false) {
    this.connections.set(id, { seen: Date.now(), live });
  }
  disconnect(id: string) {
    this.connections.delete(id);
    if (this.auto.connection === id && !this.auto.background)
      this.disableAuto("Live connection closed. Automatic trading paused.");
  }
  private disableAuto(message?: string) {
    const session = this.auto.session_id,
      wasEnabled = this.auto.enabled;
    this.auto.enabled = false;
    this.saveAutomation();
    if (wasEnabled)
      this.recordLive("automation", {
        message: message ?? "Automatic trading stopped from the app.",
      });
    if (wasEnabled)
      this.notify(
        `paused:${session ?? Date.now()}`,
        "Automatic trading paused",
        message
          ? "The backend session stopped. Open Varshan to review its status."
          : "Automatic trading was stopped from Varshan.",
      );
    this.auto.connection = null;
    if (message) this.auto.error = message;
    const b = this.state.batch;
    if (b?.automatic && active.has(b.status)) {
      b.status = "stopped";
      b.error =
        message ?? "Automatic trading paused; remaining orders were not sent.";
      this.save();
    }
  }
  async setAuto(
    enabled: boolean,
    connection: string,
    acknowledged: boolean,
    background = false,
  ): Promise<Row> {
    if (!enabled) {
      this.disableAuto();
      return this.auto;
    }
    return this.lock.run(() => {
      const lease = this.connections.get(connection);
      if (acknowledged !== true || !lease || Date.now() - lease.seen >= 25000)
        throw new Error(
          "Confirm automatic trading from an active live connection.",
        );
      this.idle();
      const number = accounts.roles().trading,
        s = accounts.settings(number);
      if (!number || !s.budget)
        throw new Error(
          "Save the daily trading account and live budget first.",
        );
      this.liveRequested = true;
      const session_id = randomUUID();
      this.auto = {
        enabled: true,
        connection,
        error: null,
        background,
        account: number,
        session_id,
        expires_at: Date.now() + 12 * 3600000,
      };
      this.saveAutomation();
      this.recordLive("automation", {
        message:
          "Automatic trading enabled for this account; the choice is remembered across app restarts.",
      });
      this.notify(
        `started:${session_id}`,
        "Automatic trading started",
        background
          ? "Your backend trading session is active. It continues when the browser closes."
          : "A browser-connected trading session is active.",
      );
      return this.auto;
    });
  }
  paper() {
    const state = orb.paper();
    if (state?.status === "Running" && this.paperWork) {
      const signals = this.feed.snapshot();
      if (!signals.fresh) state.message = signals.message;
    }
    return state;
  }
  paperControl(action: string, budget: number, reserve: number) {
    return this.lock.run(() => {
      const prior = orb.paper();
      if (prior) recordPaperLearning(prior);
      return orb.control(action, budget, reserve);
    });
  }
  indiaRecommendation(strategy: string, selected?: string[], exits?: string[]) {
    return indiaPlan(strategy, selected, exits);
  }
  previewInvestment(p: investing.PurchaseRequest): Promise<Row> {
    return this.lock.run(() => investing.previewPurchase(p, this.broker));
  }
  confirmInvestment(market: investing.InvestmentMarket, id: string, expected: string, acknowledged: boolean): Promise<Row> {
    return this.lock.run(() => investing.confirmPurchase(market, id, expected, acknowledged, this.broker));
  }
  investmentStatus(market: investing.InvestmentMarket, id: string, expected: string): Promise<Row> {
    return this.lock.run(() => investing.purchaseStatus(market, id, expected, this.broker));
  }
  kiteDraft(
    strategy: string,
    selected?: string[],
    exits?: string[],
  ): Promise<Row> {
    return this.lock.run(async () => {
      const plan = indiaPlan(strategy, selected, exits),
        account = await investingState(),
        draft = {
          id: randomUUID(),
          rows: kite.editorRows(plan.view, account),
          user: account.user,
          broker: account.broker,
        };
      const prices = await kite.quotes(
        draft.rows.map((r) => r.exchange + ":" + r.symbol),
      );
      for (const row of draft.rows) {
        const quote = prices[row.exchange + ":" + row.symbol];
        row.price_inr = quote.last_price;
        row.price_as_of = quote.quoted_at;
      }
      if (
        selectedBroker() !== draft.broker ||
        investmentScope() !== accounts.scope(draft.broker + ":" + draft.user)
      )
        throw new Error("Broker changed. Open a new draft.");
      this.state.india_draft = draft;
      this.save();
      return draft;
    });
  }
  kiteReview(id: string, rows: Row[]): Promise<Row> {
    return this.lock.run(async () => {
      const draft = this.state.india_draft;
      if (!draft || draft.id !== id)
        throw new Error("Rebalance draft changed. Open a new draft.");
      if (requireBroker() !== draft.broker)
        throw new Error("Broker changed. Open a new draft.");
      const current = await investingState();
      if (current.user !== draft.user || current.broker !== draft.broker)
        throw new Error("Connected broker account changed.");
      const original: Row[] = draft.rows,
        edited = rows.map((r) => {
          const saved = original.find(
            (o) => o.symbol === r.symbol && o.exchange === r.exchange,
          );
          if (!saved) throw new Error("Stock list changed.");
          return { ...r, current_shares: saved.current_shares };
        });
      return kite.review(edited, original, {
        broker: draft.broker,
        user: draft.user,
      });
    });
  }
  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let liveChanged = false;
    try {
      const now = Date.now();
      if (
        (this.india.enabled || this.india.hasPending || this.india.observing) &&
        !this.indiaWork &&
        now - this.lastIndia >=
          (this.india.enabled || this.india.hasPending ? 5000 : 60000)
      ) {
        this.lastIndia = now;
        this.indiaWork = this.india
          .tick()
          .catch((error) => {
            this.liveError = this.error(error);
          })
          .finally(() => {
            this.indiaWork = null;
          });
      }
      if (
        this.auto.enabled &&
        this.auto.background &&
        now >= this.auto.expires_at
      )
        this.disableAuto(
          "Backend trading session reached its twelve-hour limit.",
        );
      for (const [id, c] of this.connections)
        if (now - c.seen >= 25000) this.disconnect(id);
      const paper = orb.paper();
      if (
        paper?.status === "Running" &&
        !this.paperWork &&
        now - this.lastPaper >= 15000
      ) {
        this.lastPaper = now;
        this.paperWork = this.tickPaper(paper)
          .catch((e) => {
            this.liveError = this.error(e);
          })
          .finally(() => {
            this.paperWork = null;
          });
      }
      const batch = this.state.batch,
        interactive =
          this.auto.enabled ||
          (batch && active.has(batch.status)) ||
          [...this.connections.values()].some((c) => c.live),
        hours = session(localDay(now, "NYSE")),
        number =
          hours && now >= hours[0] && now < hours[1]
            ? accounts.roles().trading
            : null,
        observing = !!(number && accounts.settings(number).budget),
        wanted = interactive || observing;
      if (
        wanted &&
        !this.feedWork &&
        now - this.lastFeed >= (interactive ? 15000 : 60000)
      ) {
        this.lastFeed = now;
        this.feedWork = this.feed
          .refresh(
            [
              ...(this.snapshot?.positions?.map((p: Row) => p.symbol) ?? []),
              ...Object.keys(paper?.positions ?? {}),
            ],
            now,
            this.pendingSymbols(),
          )
          .catch((e) => {
            this.liveError = this.error(e);
          })
          .finally(() => {
            this.feedWork = null;
            // Evaluate completed signals promptly without starting another scan.
            this.liveRequested = true;
            this.publishLive();
          });
      }
      const liveInterval =
        observing && !interactive
          ? 60000
          : this.model?.message === "Market closed."
            ? 15000
            : this.auto.enabled || (batch && active.has(batch.status))
              ? 750
              : 5000;
      if (
        wanted &&
        now >= this.liveRetryAt &&
        (this.liveRequested || now - this.lastLive >= liveInterval)
      ) {
        liveChanged = true;
        this.lastLive = now;
        this.liveRequested = false;
        await this.lock.run(async () => {
          // The batch may have changed while this tick waited for the lock.
          const batch = this.state.batch;
          try {
            await this.broker(async (s) => {
              const broker: typeof robinhood.connected = async (action) =>
                action(s);
              if (batch && active.has(batch.status)) {
                await this.advance(batch, broker);
              } else if (this.auto.enabled) {
                this.consent({ automatic: true });
                const current = await this.decisions(
                  { automatic: true },
                  broker,
                );
                if (eligibleActions(this.model!).length) {
                  const created = await this.prepare(true, broker, current);
                  await this.begin(created, true, broker);
                }
              } else await this.decisions(undefined, broker);
            });
            this.liveFailures = 0;
            this.liveRetryAt = 0;
          } catch (e) {
            this.liveFailures++;
            this.liveRetryAt =
              Date.now() +
              Math.max(
                robinhood.readThrottleDelay(e),
                Math.min(30000, 1000 * 2 ** Math.min(5, this.liveFailures)),
              );
            this.liveError = this.error(e);
            this.recordLive("error", { message: this.liveError });
            // A failed data read can recover on the next worker cycle. Order
            // failures still stop inside advance(), preserving uncertain tickets.
            if (
              e instanceof TradeDecisionChanged &&
              this.state.batch?.automatic
            ) {
              this.state.batch.status = "superseded";
              this.state.batch.error = this.liveError;
              this.save();
            }
            if (
              this.auto.enabled &&
              !this.stopped &&
              !robinhood.recoverableReadError(e) &&
              !(e instanceof TradeDecisionChanged)
            )
              this.disableAuto(this.liveError);
          }
        });
      }
    } catch (e) {
      this.liveError = this.error(e);
    } finally {
      this.ticking = false;
      if (liveChanged) this.publishLive();
    }
  }
  private async tickPaper(paper: Row): Promise<void> {
    const signals = await this.feed.refresh(
      [
        ...Object.keys(paper.positions),
        ...(this.snapshot?.positions?.map((p: Row) => p.symbol) ?? []),
      ],
      Date.now(),
      this.pendingSymbols(),
    );
    await this.lock.run(() => {
      if (this.stopped) return;
      const current = orb.paper();
      if (
        current?.status !== "Running" ||
        current.revision !== paper.revision ||
        current.id !== paper.id
      )
        return;
      const now = Date.now();
      const missing = Object.keys(current.positions).some(
        (symbol) =>
          !signals.bars[symbol]?.length ||
          now - signals.bars[symbol].at(-1)!.time > 600000,
      );
      if (!signals.fresh || missing) {
        current.message = missing
          ? "Waiting for current intraday data for held stocks."
          : signals.message;
        current.last_check = new Date(now).toISOString();
        store.save(orb.paperPath, current);
        return;
      }
      rememberLearning(
        {
          market: "US",
          horizon: "trading",
          broker: "paper",
          scope: "us-paper",
          paper: true,
        },
        orb.STRATEGY,
        signals.ranked.flatMap((pick) => {
          const observation = marketObservation(signals.bars[pick.symbol], now);
          return observation ? [{ symbol: pick.symbol, ...observation }] : [];
        }),
        now,
      );
      const next = orb.step(
        current,
        signals.bars,
        now,
        signals.ranked,
        signals.policy,
      );
      store.save(orb.paperPath, next);
      recordPaperLearning(next);
    });
  }
}

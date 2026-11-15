import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TradingStrategyResearch } from "./strategy-research";
import {
  Activity,
  Landmark,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { runJob, useAction, useData } from "./api";
import {
  Badge,
  Card,
  ConfirmDialog,
  Failure,
  Metric,
  Notice,
  Table,
  money,
} from "./components";
import { PrivateInput, PrivateValue } from "./preferences";
import type { Row } from "./types";

type Broker = "kite" | "upstox" | "groww";
interface IndiaAction extends Row {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  enabled: boolean;
}
interface IndiaTicket extends IndiaAction {
  id: string;
  status: string;
  cancel_requested?: boolean;
}
export interface IndiaLive {
  broker: Broker | null;
  brokers: {
    id: Broker;
    name: string;
    connected: boolean;
    ending: string | null;
  }[];
  scope: string | null;
  investment_scope?: string | null;
  configured?: boolean;
  indices?: string[];
  settings_revision?: number;
  settings_saved_at?: string | null;
  settings: {
    budget: number;
    reserve_pct: number;
    symbols: string[];
    selection_mode?: "automatic" | "manual";
    index?: string;
  };
  auto: { enabled: boolean; error?: string; expires_at?: number };
  phase: string;
  snapshot: {
    user: string;
    cached?: boolean;
    cash: number;
    positions: Row[];
    updated_at: string;
  } | null;
  actions: IndiaAction[];
  signals: {
    message: string;
    asof: string | null;
    shortlist?: Row[];
    fresh?: boolean;
    scan?: { phase?: string; completed: number; total: number };
  };
  tickets: IndiaTicket[];
  history: Row[];
  error: string | null;
}
const keys = ["india-trading"];
export function IndiaBrokerPicker({
  label = "India broker account",
  disabled = false,
  data,
}: {
  label?: string;
  disabled?: boolean;
  data?: IndiaLive;
}) {
  const live = useData<IndiaLive>(keys, "/india/trading", undefined, !data);
  const current = data ?? live.data;
  const select = useAction((broker: Broker) =>
    runJob("/india/broker", { broker }),
  );
  const pending = current?.tickets?.some((t) =>
    ["submitting", "unknown", "submitted"].includes(t.status),
  );
  return (
    <div>
      <label>
        {label}
        <select
          value={current?.broker ?? ""}
          disabled={
            disabled ||
            !current ||
            select.isPending ||
            current?.auto?.enabled ||
            pending
          }
          onChange={(e) => select.mutate(e.target.value as Broker)}
        >
          <option value="" disabled>
            Choose a broker account
          </option>
          {current?.brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.ending ? ` · ${b.ending}` : ""} ·{" "}
              {b.connected ? "Connected" : "Connect in Account settings"}
            </option>
          ))}
        </select>
      </label>
      <small>
        Used for all India trades and long-term investments. Pause automation
        and resolve pending orders before switching.
      </small>
      <Failure error={live.error || select.error} />
    </div>
  );
}
export function IndiaBrokerConnections() {
  const live = useData<IndiaLive>(keys, "/india/trading");
  const [broker, setBroker] = useState<"upstox" | "groww">("upstox");
  const [token, setToken] = useState("");
  const connect = useAction(
    () =>
      runJob("/india/trading/connect", { broker, access_token: token.trim() }),
    keys,
  );
  return (
    <Card
      title="Upstox & Groww connections"
      className="broker-card"
      subtitle="India · secure daily access tokens"
    >
      <div className="actions">
        {live.data?.brokers
          ?.filter((b) => b.id !== "kite")
          .map((b) => (
            <Badge key={b.id} tone={b.connected ? "bullish" : ""}>
              {b.name} ·{" "}
              {b.connected ? `Connected ${b.ending ?? ""}` : "Connect or renew"}
            </Badge>
          ))}
      </div>
      <div className="form-row">
        <label>
          Broker
          <select
            value={broker}
            disabled={connect.isPending}
            onChange={(e) => {
              setBroker(e.target.value as "upstox" | "groww");
              setToken("");
              connect.reset();
            }}
          >
            <option value="upstox">Upstox</option>
            <option value="groww">Groww</option>
          </select>
        </label>
        <label>
          Daily access token
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={connect.isPending}
          />
        </label>
      </div>
      <button
        className="primary"
        disabled={
          !token.trim() ||
          connect.isPending ||
          live.data?.auto?.enabled ||
          live.data?.tickets?.some((t) =>
            ["submitting", "unknown", "submitted"].includes(t.status),
          )
        }
        onClick={() =>
          connect.mutate(undefined, { onSuccess: () => setToken("") })
        }
      >
        {connect.isPending
          ? "Verifying broker…"
          : `Connect ${broker === "upstox" ? "Upstox" : "Groww"}`}
      </button>
      <Failure
        error={
          live.error ||
          connect.error ||
          (live.data?.broker === broker ? live.data.error : null)
        }
      />
      {connect.isSuccess && (
        <Notice>
          Broker connected. Select it in India trading, refresh the account,
          then save its budget and watchlist.
        </Notice>
      )}
      <details className="broker-help">
        <summary>API setup and token renewal</summary>
        <p className="footnote">
          Generate or renew the token through{" "}
          <a
            href="https://account.upstox.com/developer/apps"
            target="_blank"
            rel="noreferrer"
          >
            Upstox developer apps
          </a>{" "}
          or{" "}
          <a
            href="https://groww.in/trade-api/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            Groww Trading APIs
          </a>
          . Complete broker API activation and register this computer’s public
          static IP for order access. Renew expired tokens here. Pause India
          automation before changing a connection. Kite uses the connection
          above.
        </p>
      </details>
    </Card>
  );
}

export function IndiaTrading({
  active = true,
  onOpenAccounts,
}: {
  active?: boolean;
  onOpenAccounts?: () => void;
}) {
  const live = useData<IndiaLive>(
    keys,
    "/india/trading",
    ({ state }) =>
      active &&
      (state.data?.auto?.enabled ||
        state.data?.tickets?.some((t) =>
          ["submitting", "unknown", "submitted"].includes(t.status),
        ) ||
        ["loading_universe", "loading_history", "refreshing_prices"].includes(
          state.data?.signals?.scan?.phase ?? "",
        ))
        ? 3000
        : false,
    active,
  );
  const data = live.data;
  const client = useQueryClient();
  const identity = data?.broker
    ? `${data.broker}:${data.scope ?? data.investment_scope ?? "unverified"}`
    : null;
  const formState = useRef({ identity: "", dirty: false, revision: 0 });
  const [budget, setBudget] = useState(100000),
    [reserve, setReserve] = useState(10),
    [symbols, setSymbols] = useState("");
  const [selectionMode, setSelectionMode] = useState<"automatic" | "manual">(
    "automatic",
  );
  const [index, setIndex] = useState("Nifty 100");
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [preview, setPreview] = useState<IndiaTicket | null>(null),
    [start, setStart] = useState(false),
    [cancelling, setCancelling] = useState<IndiaTicket | null>(null);
  const [manualRefresh, setManualRefresh] = useState(false);
  function populate(
    settings: IndiaLive["settings"],
    revision: number,
    accountIdentity: string,
  ) {
    setBudget(settings.budget);
    setReserve(settings.reserve_pct);
    setSymbols(settings.symbols.join(", "));
    setSelectionMode(settings.selection_mode ?? "automatic");
    setIndex(settings.index ?? "Nifty 100");
    formState.current = { identity: accountIdentity, dirty: false, revision };
  }
  function clearDraft(accountIdentity: string) {
    try {
      localStorage.removeItem(`india-trading-draft:${accountIdentity}`);
    } catch {
      setCacheError(
        "Browser draft caching is unavailable. Confirmed settings are still saved on this computer.",
      );
    }
  }
  useEffect(() => {
    if (!data?.settings || !identity) return;
    const revision = data.settings_revision ?? 0;
    if (formState.current.identity !== identity) {
      populate(data.settings, revision, identity);
      setPreview(null);
      setStart(false);
      setCancelling(null);
      save.reset();
      refresh.reset();
      try {
        const draft = JSON.parse(
          localStorage.getItem(`india-trading-draft:${identity}`) ?? "null",
        );
        const form = draft?.form;
        if (
          draft?.revision === revision &&
          form &&
          Number.isFinite(form.budget) &&
          form.budget >= 0 &&
          Number.isFinite(form.reserve) &&
          form.reserve >= 0 &&
          form.reserve <= 100 &&
          typeof form.symbols === "string" &&
          ["automatic", "manual"].includes(form.selectionMode) &&
          typeof form.index === "string" &&
          (!data.indices || data.indices.includes(form.index))
        ) {
          setBudget(form.budget);
          setReserve(form.reserve);
          setSymbols(form.symbols);
          setSelectionMode(form.selectionMode);
          setIndex(form.index);
          formState.current.dirty = true;
        } else if (draft) clearDraft(identity);
      } catch {
        clearDraft(identity);
      }
    } else if (!formState.current.dirty)
      populate(data.settings, revision, identity);
  }, [identity, data?.settings, data?.settings_revision]);
  function edit(
    change: Partial<{
      budget: number;
      reserve: number;
      symbols: string;
      selectionMode: "automatic" | "manual";
      index: string;
    }>,
  ) {
    const form = { budget, reserve, symbols, selectionMode, index, ...change };
    setBudget(form.budget);
    setReserve(form.reserve);
    setSymbols(form.symbols);
    setSelectionMode(form.selectionMode);
    setIndex(form.index);
    formState.current.dirty = true;
    if (identity) {
      try {
        localStorage.setItem(
          `india-trading-draft:${identity}`,
          JSON.stringify({ revision: formState.current.revision, form }),
        );
        setCacheError(null);
      } catch {
        setCacheError(
          "Browser draft caching is unavailable. Save settings before refreshing this page.",
        );
      }
    }
  }
  const save = useAction(async () => {
    const result = await runJob<IndiaLive>("/india/trading/settings", {
      budget,
      reserve_pct: reserve,
      selection_mode: selectionMode,
      index,
      expected_revision: formState.current.revision,
      expected_broker: data?.broker,
      ...((data?.scope ?? data?.investment_scope)
        ? { expected_scope: data?.scope ?? data?.investment_scope }
        : {}),
      symbols:
        selectionMode === "automatic"
          ? []
          : symbols
              .split(/[\s,]+/)
              .map((s) => s.trim().toUpperCase().replace(/\.NS$/, ""))
              .filter(Boolean),
    });
    await client.cancelQueries({ queryKey: keys });
    const current = client.getQueryData<IndiaLive>(keys);
    const savedScope = result.scope ?? result.investment_scope;
    const currentScope = current?.scope ?? current?.investment_scope;
    if (
      current &&
      (current.broker !== result.broker ||
        (currentScope && savedScope && currentScope !== savedScope))
    )
      throw new Error(
        "Settings were saved for the previous account. Reload the currently selected account before trading.",
      );
    if (identity) clearDraft(identity);
    const savedIdentity = `${result.broker}:${result.scope ?? result.investment_scope ?? "unverified"}`;
    populate(result.settings, result.settings_revision ?? 0, savedIdentity);
    client.setQueryData(keys, result);
    return result;
  }, []);
  const refresh = useAction(() => runJob("/india/trading/refresh"), keys);
  const review = useAction(
    (action: IndiaAction) =>
      runJob<IndiaTicket>("/india/trading/preview", {
        symbol: action.symbol,
        side: action.side,
        ...(action.from_shortlist
          ? {
              expected_scope: data?.scope ?? data?.investment_scope,
              expected_revision: data?.settings_revision ?? 0,
              expected_broker: data?.broker,
            }
          : {}),
      }),
    keys,
  );
  const confirm = useAction(
    () =>
      runJob(`/india/trading/orders/${preview!.id}/confirm`, {
        acknowledged: true,
      }),
    keys,
  );
  const automation = useAction(
    (enabled: boolean) =>
      runJob("/india/trading/automation", { enabled, acknowledged: enabled }),
    keys,
  );
  const cancel = useAction(
    () =>
      runJob(`/india/trading/orders/${cancelling!.id}/cancel`, {
        acknowledged: true,
      }),
    keys,
  );
  const pending =
    data?.tickets?.some((t) =>
      ["submitting", "unknown", "submitted"].includes(t.status),
    ) ?? false;
  const connected = data?.brokers?.find((b) => b.id === data.broker)?.connected;
  const hasSnapshot = !!data?.snapshot;
  const refreshAccount = refresh.mutate;
  useEffect(() => {
    if (
      !active ||
      !connected ||
      !data?.configured ||
      !hasSnapshot ||
      data.phase !== "Market open" ||
      data.error ||
      refresh.error ||
      refresh.isPending ||
      data.auto?.enabled ||
      pending
    )
      return;
    const timer = setInterval(() => refreshAccount(), 15000);
    return () => clearInterval(timer);
  }, [
    active,
    connected,
    data?.broker,
    data?.auto?.enabled,
    data?.configured,
    data?.phase,
    data?.error,
    hasSnapshot,
    refresh.error,
    refresh.isPending,
    pending,
    refreshAccount,
  ]);
  function refreshManually() {
    setManualRefresh(true);
    refresh.mutate(undefined, { onSettled: () => setManualRefresh(false) });
  }
  const busy =
    !data?.broker ||
    save.isPending ||
    (manualRefresh && refresh.isPending) ||
    review.isPending ||
    confirm.isPending ||
    automation.isPending ||
    cancel.isPending;
  const error =
    live.error ||
    data?.error ||
    data?.auto?.error ||
    save.error ||
    refresh.error ||
    review.error ||
    confirm.error ||
    automation.error ||
    cancel.error;
  if (!data?.settings)
    return (
      <>
        <Failure error={error} />
        {live.isPending ? (
          <Notice>Loading India trading…</Notice>
        ) : (
          <Notice>
            India trading is unavailable. Retry loading its status.
          </Notice>
        )}
        {!live.isPending && (
          <button onClick={() => void live.refetch()}>
            Retry India trading
          </button>
        )}
      </>
    );
  const selectedBroker = data.brokers.find((b) => b.id === data.broker);
  const positions =
    data.snapshot?.positions.filter((p) => p.quantity !== 0) ?? [];
  const settingsChanged =
    budget !== data.settings.budget ||
    reserve !== data.settings.reserve_pct ||
    selectionMode !== (data.settings.selection_mode ?? "automatic") ||
    index !== (data.settings.index ?? "Nifty 100") ||
    (selectionMode === "manual" &&
      JSON.stringify(
        symbols
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase().replace(/\.NS$/, ""))
          .filter(Boolean),
      ) !== JSON.stringify(data.settings.symbols));
  const settingsConflict =
    formState.current.dirty &&
    formState.current.revision !== (data.settings_revision ?? 0);
  return (
    <div className="india-trading-workspace">
      <div className="india-session-strip">
        <div>
          <span className="india-broker-mark">
            <Landmark size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>{selectedBroker?.name ?? "India broker"}</strong>
            <span>
              {connected
                ? "Broker session connected"
                : "Connect your trading account"}
            </span>
          </div>
          <Badge tone={connected ? "bullish" : ""}>
            {connected ? "Connected" : "Needs connection"}
          </Badge>
        </div>
        {onOpenAccounts && (
          <button onClick={onOpenAccounts}>
            <Settings2 size={16} aria-hidden="true" />
            Manage broker connections
          </button>
        )}
      </div>
      <Failure error={error} />
      <Card
        title="India intraday trading"
        className="india-trading-controls"
        subtitle="NSE cash equities · whole shares · Asia/Kolkata exchange hours"
        action={
          <Badge tone={data.auto.enabled ? "bullish" : ""}>
            {data.auto.enabled ? "Automatic session active" : "Manual / paused"}
          </Badge>
        }
      >
        {(!connected || !data.configured) && (
          <ol className="india-setup-steps" aria-label="India trading setup">
            <li data-complete={!!connected}>
              <span>1</span>
              <div>
                <strong>Connect a broker</strong>
                <small>Kite, Upstox or Groww</small>
              </div>
            </li>
            <li data-complete={!!data.configured}>
              <span>2</span>
              <div>
                <strong>Set your trading limits</strong>
                <small>Save the budget and stock selection</small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Review or automate</strong>
                <small>Confirm before real orders start</small>
              </div>
            </li>
          </ol>
        )}
        <div className="form-row">
          <IndiaBrokerPicker
            label="Trading broker"
            data={data}
            disabled={!!data.broker && busy}
          />
          <label>
            Budget (₹)
            <PrivateInput
              type="number"
              min={1}
              value={budget}
              disabled={busy || data.auto.enabled || pending}
              onChange={(e) => edit({ budget: Number(e.target.value) })}
            />
          </label>
          <label>
            Cash reserve (%)
            <PrivateInput
              type="number"
              min={0}
              max={100}
              value={reserve}
              disabled={busy || data.auto.enabled || pending}
              onChange={(e) => edit({ reserve: Number(e.target.value) })}
            />
          </label>
        </div>
        <label>
          Stock selection
          <select
            value={selectionMode}
            disabled={busy || data.auto.enabled || pending}
            onChange={(e) =>
              edit({ selectionMode: e.target.value as "automatic" | "manual" })
            }
          >
            <option value="automatic">Automatic · Index stocks</option>
            <option value="manual">Custom NSE watchlist</option>
          </select>
        </label>
        {selectionMode === "automatic" && (
          <label>
            Trading index
            <select
              value={index}
              disabled={busy || data.auto.enabled || pending}
              onChange={(e) => edit({ index: e.target.value })}
            >
              {(data.indices ?? ["Nifty 100"]).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {selectionMode === "manual" ? (
          <label>
            NSE watchlist (1–20 symbols)
            <input
              value={symbols}
              disabled={busy || data.auto.enabled || pending}
              placeholder="RELIANCE, INFY, HDFCBANK"
              onChange={(e) => edit({ symbols: e.target.value })}
            />
          </label>
        ) : (
          <Notice>
            Automatically scans {index} stocks and maintains up to four
            candidates using the same scanner as US trading. No stock names are
            required. Larger indices take longer to scan. Save settings, then
            refresh or start automatic trading.
          </Notice>
        )}
        <div className="india-controls-footer">
          <div className="actions">
            <button
              disabled={
                busy ||
                data.auto.enabled ||
                pending ||
                !(budget > 0) ||
                reserve < 0 ||
                reserve > 100 ||
                (selectionMode === "manual" && !symbols.trim())
              }
              onClick={() => save.mutate()}
            >
              <Settings2 size={15} aria-hidden="true" />
              Save India trading settings
            </button>
            <button
              disabled={busy || refresh.isPending}
              onClick={refreshManually}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {manualRefresh && refresh.isPending
                ? "Checking account…"
                : "Refresh account & broker status"}
            </button>
          </div>
          {data.auto.enabled ? (
            <button
              className="danger"
              disabled={automation.isPending}
              onClick={() => automation.mutate(false)}
            >
              Stop India automatic trading
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                busy ||
                pending ||
                !connected ||
                !data.configured ||
                settingsChanged ||
                settingsConflict ||
                data.phase !== "Market open" ||
                !!data.error ||
                !!refresh.error
              }
              onClick={() => setStart(true)}
            >
              Start India automatic trading
            </button>
          )}
        </div>
        {cacheError && <Notice>{cacheError}</Notice>}
        {settingsConflict && (
          <Notice error>
            Saved settings changed in another window. Reload saved settings
            before saving or trading.
          </Notice>
        )}
        {(settingsChanged || settingsConflict) && (
          <button
            disabled={busy}
            onClick={() => {
              if (identity) {
                clearDraft(identity);
                populate(data.settings, data.settings_revision ?? 0, identity);
                save.reset();
              }
            }}
          >
            Reload saved settings
          </button>
        )}
        {settingsChanged && (
          <Notice>
            Save your budget and stock selection changes before starting or
            reviewing trades.
          </Notice>
        )}
        {save.isSuccess && (
          <Notice>
            Saved locally:{" "}
            <PrivateValue>
              {money(save.data?.settings.budget, "INR")}
            </PrivateValue>{" "}
            budget, {save.data?.settings.reserve_pct}% reserve ·{" "}
            {save.data?.settings.index ?? "Nifty 100"}.
          </Notice>
        )}
        {data.configured && (
          <p className="footnote">
            Confirmed budget:{" "}
            <PrivateValue>{money(data.settings.budget, "INR")}</PrivateValue> ·{" "}
            {data.settings.reserve_pct}% reserve ·{" "}
            {data.settings.index ?? "Nifty 100"}
            {data.settings_saved_at
              ? ` · Saved ${new Date(data.settings_saved_at).toLocaleString()}`
              : ""}
            . Stored encrypted on this computer. Unsaved edits never change
            trading limits.
          </p>
        )}
        {data.snapshot?.cached && (
          <Notice>
            Showing a saved account snapshot from{" "}
            {new Date(data.snapshot.updated_at).toLocaleString()}. Refresh
            broker status for current values; cached values cannot authorize
            trades.
          </Notice>
        )}
        <p className="footnote">
          Connect or renew broker sessions in Account settings. Manual trades
          use the same eligible strategy signals as automation. This tab opens
          long intraday positions and sells only app-managed shares. Delivery
          holdings and externally opened positions are not managed here.
        </p>
      </Card>
      <div className="metrics">
        <Metric
          title="Available broker funds"
          value={money(data.snapshot?.cash, "INR")}
        />
        <Metric
          title="India budget"
          value={money(data.settings.budget, "INR")}
        />
        <Metric title="NSE session" value={data.phase} privateData={false} />
        <Metric
          title="Last broker check"
          value={
            data.snapshot?.updated_at
              ? new Date(data.snapshot.updated_at).toLocaleTimeString()
              : "Not checked"
          }
          privateData={false}
        />
      </div>
      <Card
        title="India stock shortlist"
        subtitle={
          data.settings.selection_mode === "manual"
            ? "Automatically ranked from your custom NSE watchlist"
            : `Automatically ranked from ${data.settings.index ?? "Nifty 100"}`
        }
      >
        {data.signals.shortlist?.length && data.signals.fresh === false ? (
          <Notice>
            Previous shortlist; waiting for a successful current scan. New buys
            are blocked.
          </Notice>
        ) : null}
        {data.signals.shortlist?.length ? (
          <Table
            name="India shortlisted stocks"
            rows={data.signals.shortlist}
            rowActions={(row) => {
              const symbol = String(row.symbol);
              const action = data.actions.find(
                (a) => a.symbol === symbol && a.side === "buy",
              );
              const reason = !connected
                ? "Connect the selected broker account first."
                : !data.configured
                  ? "Save this account's trading settings first."
                  : data.auto.enabled
                    ? "Pause automatic trading to buy manually."
                    : pending
                      ? "Reconcile pending orders before buying."
                      : settingsConflict || settingsChanged
                        ? "Save or reload your trading limits before buying."
                        : data.phase !== "Market open"
                          ? "NSE market closed."
                          : data.snapshot?.cached ||
                              data.signals.fresh === false
                            ? "Refresh broker status and the shortlist before buying."
                            : !action?.enabled
                              ? (data.actions.find((a) => a.symbol === symbol)
                                  ?.reason ??
                                "Waiting for an eligible buy setup.")
                              : null;
              return (
                <div>
                  <button
                    disabled={busy || !!reason}
                    onClick={() => {
                      if (action)
                        review.mutate(
                          { ...action, from_shortlist: true },
                          {
                            onSuccess: (ticket) => {
                              confirm.reset();
                              setPreview(ticket);
                            },
                          },
                        );
                    }}
                  >
                    Buy {symbol}
                  </button>
                  {reason && (
                    <small className="footnote">
                      <PrivateValue>{String(reason)}</PrivateValue>
                    </small>
                  )}
                </div>
              );
            }}
            columns={[
              "symbol",
              "relative_volume",
              "rotation_score",
              "baseline_sessions",
              "watch_since",
              "replaced_symbol",
            ]}
          />
        ) : (
          <Notice>
            No stocks currently qualify. The scanner waits for a completed
            15-minute opening range and at least 1.5× relative volume. It
            rotates waiting candidates and keeps held stocks and pending orders
            under separate monitoring.
          </Notice>
        )}
        <p className="footnote">
          Buy opens a review for that stock only, sized using your saved budget
          and risk limits. Confirm the displayed order to submit it. A shortlist
          is a set of candidates. Orders also require completed breakout, VWAP
          and EMA confirmation, current broker prices, spread, cost and budget
          checks. Manual mode requires order confirmation; automatic mode uses
          your session consent.
        </p>
      </Card>
      <Card title="India strategy monitor" subtitle={data.signals.message}>
        {!!data.signals.scan?.total && (
          <p>
            {data.signals.scan.completed} / {data.signals.scan.total} stock
            checks
          </p>
        )}
        {data.actions.length ? (
          <Table
            name="India strategy decisions"
            rows={data.actions}
            columns={[
              "symbol",
              "action",
              "quantity",
              "price",
              "stop",
              "target",
              "net_reward_risk",
              "learning_suggestion",
              "learning_reason",
              "stressed_reward_risk",
              "estimated_round_trip_cost_pct",
              "reason",
            ]}
          />
        ) : (
          <div className="india-empty-state">
            <Activity size={23} aria-hidden="true" />
            <div>
              <strong>Waiting for eligible setups</strong>
              <p>
                Qualified stocks and their buy or exit reasons will appear here.
              </p>
            </div>
          </div>
        )}
        <div className="actions">
          {data.actions
            .filter((a) => a.enabled)
            .map((a) => (
              <button
                key={`${a.symbol}-${a.side}`}
                disabled={
                  busy ||
                  data.auto.enabled ||
                  pending ||
                  settingsChanged ||
                  settingsConflict
                }
                onClick={() =>
                  review.mutate(a, {
                    onSuccess: (ticket) => {
                      confirm.reset();
                      setPreview(ticket);
                    },
                  })
                }
              >
                Review {String(a.side).toUpperCase()} {a.symbol}
              </button>
            ))}
        </div>
        <div className="india-risk-summary">
          <span>
            <ShieldCheck size={15} aria-hidden="true" />
            0.25% planned trade risk
          </span>
          <span>1% daily loss halt</span>
          <span>4 position limit</span>
          <span>Exit 20 min before close</span>
        </div>
        <p className="footnote">
          Software exits need the app running and connected. Keep the Mac’s lid
          open during automatic trading.
        </p>
        <details className="broker-help">
          <summary>Strategy and execution rules</summary>
          <p className="footnote">
            The strategy uses a completed 15-minute opening range, 1.5× relative
            volume, VWAP and EMA confirmation. Up to four positions share the
            budget after reserve, capped at 0.25% planned budget risk per trade
            with estimated costs. A 1% daily budget loss halts entries. New
            entries stop 30 minutes before close; managed positions exit 20
            minutes before close. Software stops require a running, connected
            app. Keep the Mac’s lid open; an automatic session prevents idle
            sleep. Broker square-off rules and charges still apply.
          </p>
        </details>
      </Card>
      <TradingStrategyResearch market="India" />
      <div className="india-trading-ledger">
        <Card
          title="NSE intraday positions"
          action={
            <Badge>
              {data.snapshot ? `${positions.length} open` : "Not checked"}
            </Badge>
          }
        >
          {positions.length ? (
            <Table
              name="India intraday positions"
              rows={positions}
              columns={["symbol", "quantity", "average_price", "realised_pnl"]}
            />
          ) : (
            <div className="india-empty-state">
              <Landmark size={23} aria-hidden="true" />
              <div>
                <strong>
                  {data.snapshot
                    ? "No open intraday positions"
                    : "Positions haven’t been checked"}
                </strong>
                <p>
                  {data.snapshot
                    ? "Your app-managed positions will appear after a confirmed fill."
                    : "Refresh the connected account to load its positions."}
                </p>
              </div>
            </div>
          )}
        </Card>
        <Card
          title="India order tickets"
          action={
            <button
              disabled={busy || refresh.isPending}
              onClick={refreshManually}
            >
              Check broker status
            </button>
          }
        >
          {data.tickets.length ? (
            <Table
              name="India order tickets"
              rows={data.tickets}
              columns={[
                "reviewed_at",
                "symbol",
                "side",
                "quantity",
                "status",
                "broker_state",
                "error",
              ]}
            />
          ) : (
            <div className="india-empty-state">
              <ShieldCheck size={23} aria-hidden="true" />
              <div>
                <strong>No app order tickets yet</strong>
                <p>Reviewed trades and broker receipts will appear here.</p>
              </div>
            </div>
          )}
          <div className="actions">
            {data.tickets
              .filter((t) => t.status === "submitted" && !t.cancel_requested)
              .map((t) => (
                <button
                  key={t.id}
                  disabled={busy}
                  onClick={() => setCancelling(t)}
                >
                  Cancel pending {t.symbol} {t.side}
                </button>
              ))}
          </div>
          {data.tickets.some((t) =>
            ["submitting", "unknown"].includes(t.status),
          ) && (
            <Notice error>
              Placement status is uncertain. Check the broker’s app and refresh
              status here. The app will not resend an unresolved order.
            </Notice>
          )}
        </Card>
      </div>
      <Card title="India trading history">
        <details className="india-history">
          <summary>
            View activity <Badge>{data.history.length} recent</Badge>
          </summary>
          {data.history.length ? (
            <Table
              name="India trading history"
              rows={data.history}
              columns={["created_at", "message"]}
            />
          ) : (
            <p className="footnote">
              Session changes, submitted orders and execution messages will
              appear here.
            </p>
          )}
        </details>
      </Card>
      {preview && (
        <ConfirmDialog
          title={`Confirm India ${String(preview.side).toUpperCase()} ${preview.symbol}`}
          pending={confirm.isPending}
          onClose={() => setPreview(null)}
          onConfirm={() =>
            confirm.mutate(undefined, { onSuccess: () => setPreview(null) })
          }
        >
          <p>
            Place a real NSE intraday market order through{" "}
            {data.brokers.find((b) => b.id === data.broker)?.name}:{" "}
            <PrivateValue>
              {preview.quantity} whole shares of {preview.symbol}, estimated{" "}
              {money(Number(preview.quantity) * Number(preview.price), "INR")}
            </PrivateValue>
            . The final fill price can differ. Eligibility, available funds and
            sellable app-managed shares are checked again before placement.
          </p>
          <Failure error={confirm.error} />
        </ConfirmDialog>
      )}
      {start && (
        <ConfirmDialog
          title="Start India automatic trading"
          pending={automation.isPending}
          onClose={() => setStart(false)}
          onConfirm={() =>
            automation.mutate(true, { onSuccess: () => setStart(false) })
          }
        >
          <p>
            Authorize real NSE intraday buys and exits through{" "}
            {data.brokers.find((b) => b.id === data.broker)?.name} using the
            saved{" "}
            <PrivateValue>{money(data.settings.budget, "INR")}</PrivateValue>{" "}
            budget and{" "}
            {data.settings.selection_mode === "manual"
              ? "custom NSE watchlist"
              : `automatically selected ${data.settings.index ?? "Nifty 100"} candidates`}{" "}
            until this exchange session closes. It continues when this browser
            closes. Stop it from this tab. A graceful server restart pauses this
            India session; unresolved orders always block new submissions.
          </p>
          <Failure error={automation.error} />
        </ConfirmDialog>
      )}
      {cancelling && (
        <ConfirmDialog
          title={`Cancel India order for ${cancelling.symbol}`}
          pending={cancel.isPending}
          onClose={() => setCancelling(null)}
          onConfirm={() =>
            cancel.mutate(undefined, { onSuccess: () => setCancelling(null) })
          }
        >
          <p>
            The broker can fill an order before cancellation completes. Refresh
            status to confirm the outcome. Cancelling a pending order does not
            sell filled shares.
          </p>
          <Failure error={cancel.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}

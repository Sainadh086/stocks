import { useEffect, useState } from "react";
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
  settings: { budget: number; reserve_pct: number; symbols: string[] };
  auto: { enabled: boolean; error?: string; expires_at?: number };
  phase: string;
  snapshot: {
    user: string;
    cash: number;
    positions: Row[];
    updated_at: string;
  } | null;
  actions: IndiaAction[];
  signals: {
    message: string;
    asof: string | null;
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
  const [budget, setBudget] = useState(100000),
    [reserve, setReserve] = useState(10),
    [symbols, setSymbols] = useState("");
  const [preview, setPreview] = useState<IndiaTicket | null>(null),
    [start, setStart] = useState(false),
    [cancelling, setCancelling] = useState<IndiaTicket | null>(null);
  const [manualRefresh, setManualRefresh] = useState(false);
  useEffect(() => {
    if (!data?.settings) return;
    setBudget(data.settings.budget);
    setReserve(data.settings.reserve_pct);
    setSymbols(data.settings.symbols.join(", "));
    setPreview(null);
    // Forms belong to this broker account and retain edits during status polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.scope, data?.broker]);
  const save = useAction(
    () =>
      runJob("/india/trading/settings", {
        budget,
        reserve_pct: reserve,
        symbols: symbols
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase().replace(/\.NS$/, ""))
          .filter(Boolean),
      }),
    keys,
  );
  const refresh = useAction(() => runJob("/india/trading/refresh"), keys);
  const review = useAction(
    (action: IndiaAction) =>
      runJob<IndiaTicket>("/india/trading/preview", {
        symbol: action.symbol,
        side: action.side,
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
                <small>Save the budget and watchlist</small>
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
              onChange={(e) => setBudget(Number(e.target.value))}
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
              onChange={(e) => setReserve(Number(e.target.value))}
            />
          </label>
        </div>
        <label>
          NSE watchlist (1–20 symbols)
          <input
            value={symbols}
            disabled={busy || data.auto.enabled || pending}
            placeholder="RELIANCE, INFY, HDFCBANK"
            onChange={(e) => setSymbols(e.target.value)}
          />
        </label>
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
                !symbols.trim()
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
        {save.isSuccess && (
          <Notice>
            India budget and watchlist saved for this broker account.
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
                disabled={busy || data.auto.enabled || pending}
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
            budget and watchlist until this exchange session closes. It
            continues when this browser closes. Stop it from this tab. A
            graceful server restart pauses this India session; unresolved orders
            always block new submissions.
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

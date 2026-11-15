import { PrivateInput, PrivateValue, usePreferences } from "./preferences";
import { TradingStrategyResearch } from "./strategy-research";
import { useEffect, useRef, useState } from "react";
import { Play, Square, RefreshCw } from "lucide-react";
import { useAction, useData, request, runJob } from "./api";
import {
  Badge,
  Card,
  Chart,
  ConfirmDialog,
  Empty,
  Failure,
  Metric,
  Modal,
  Notice,
  Table,
  money,
  num,
} from "./components";
import type {
  Accounts,
  Batch,
  KiteDraft,
  Live,
  Paper,
  Row,
  Strategy,
} from "./types";

export function Trading({ connection }: { connection: string }) {
  const [tab, setTab] = useState("live");
  return (
    <>
      <div className="workspace-toolbar">
        <div className="segments">
          <button
            aria-pressed={tab === "live"}
            className={tab === "live" ? "active" : ""}
            onClick={() => setTab("live")}
          >
            Live account
          </button>
          <button
            aria-pressed={tab === "paper"}
            className={tab === "paper" ? "active" : ""}
            onClick={() => setTab("paper")}
          >
            Paper trading
          </button>
        </div>
        <Badge tone={connection ? "bullish" : ""}>
          {connection ? "Live updates connected" : "Reconnecting updates"}
        </Badge>
      </div>
      <div hidden={tab !== "live"}>
        <TradingStrategyResearch market="US" />
        <LiveTrading connection={connection} active={tab === "live"} />
      </div>
      <div hidden={tab !== "paper"}>
        <PaperTrading />
      </div>
    </>
  );
}
function ticketsForProgress(live?: Live): Row[] {
  if (!live?.batch) return [];
  const results = live.batch.results ?? [];
  const ids = live.batch.ticket_ids ?? results.map((r) => String(r.id));
  return ids.map((id) => {
    const ticket = live.tickets.find((t) => t.id === id);
    const result = results.find((r) => r.id === id);
    const state =
      ((ticket?.result as Row | undefined)?.order as Row | undefined)?.state ??
      result?.broker_state;
    return {
      symbol: (ticket?.arguments as Row | undefined)?.symbol ?? result?.symbol,
      side: (ticket?.arguments as Row | undefined)?.side ?? result?.side,
      quantity: (ticket?.arguments as Row | undefined)?.quantity,
      dollar_amount: (ticket?.arguments as Row | undefined)?.dollar_amount,
      status:
        (state === "filled" ? "filled" : undefined) ??
        result?.status ??
        (ticket?.status === "preview"
          ? "queued"
          : (ticket?.status ?? "queued")),
      broker_state: state,
      reviewed_at: ticket?.reviewed_at,
      reason: ticket?.error,
    };
  });
}
function LiveTrading({
  connection,
  active,
}: {
  connection: string;
  active: boolean;
}) {
  const { privacy } = usePreferences();
  const accounts = useData<Accounts>("accounts", "/accounts");
  const scope =
    accounts.data?.roles.trading.scope ||
    accounts.data?.roles.trading.ending ||
    "local";
  const liveQuery = useData<Live>(
    ["live", scope],
    "/live",
    active ? (connection ? 15_000 : 1_000) : 30_000,
  );
  const live = {
    ...liveQuery,
    data:
      !liveQuery.data?.scope || liveQuery.data.scope === scope
        ? liveQuery.data
        : undefined,
  };
  const [budget, setBudget] = useState(1000);
  const [reserve, setReserve] = useState(10);
  const [confirm, setConfirm] = useState<"signal" | "batch" | "auto" | null>(
    null,
  );
  const [selectedBuy, setSelectedBuy] = useState<{
    view: Live;
    symbol: string;
    scope: string;
    ending: string;
  } | null>(null);
  const buy = useAction((symbol: string) =>
    runJob<Live>("/live/preview", {
      symbol,
      expected_scope: accounts.data?.roles.trading.scope,
    }),
  );
  useEffect(() => {
    setSelectedBuy(null);
  }, [scope, active]);
  const prompted = useRef("");
  const refresh = useAction(() => runJob("/live/refresh"));
  const settings = useAction(() =>
    request("/live/settings", { budget, reserve_pct: reserve }),
  );
  const preview = useAction(() => runJob<Live>("/live/preview"));
  const reconcile = useAction(() => runJob("/live/tickets/reconcile"));
  const [recovery, setRecovery] = useState<{ ticket: Row; order: Row } | null>(
    null,
  );
  const [receiptConfirmed, setReceiptConfirmed] = useState(false);
  const linkReceipt = useAction(
    ({ ticket, order }: { ticket: Row; order: Row }) =>
      runJob(`/live/tickets/${encodeURIComponent(String(ticket.id))}/link`, {
        order_id: order.id,
        acknowledged: true,
      }),
  );
  const send = useAction((identity: string) =>
    runJob(`/live/batches/${identity}/confirm`, { acknowledged: true }),
  );
  const auto = useAction((enabled: boolean) =>
    request("/live/automation", {
      enabled,
      connection,
      acknowledged: enabled,
      background: true,
    }),
  );
  const manual = useAction(async () => {
    if (enabled) await auto.mutateAsync(false);
    return runJob<Live>("/live/preview");
  });
  useEffect(() => {
    const saved = accounts.data?.live_settings;
    if (saved) {
      setBudget(saved.budget || 1000);
      setReserve(saved.reserve_pct ?? 10);
    }
  }, [
    accounts.data?.live_settings.budget,
    accounts.data?.live_settings.reserve_pct,
  ]);
  const batch = live.data?.batch;
  const enabled = live.data?.auto.enabled || false;
  const automaticPreview = batch?.automatic && batch.status === "preview";
  useEffect(() => {
    if (
      (enabled && (confirm === "signal" || confirm === "batch")) ||
      (batch?.automatic && confirm === "batch")
    )
      setConfirm(null);
  }, [enabled, batch?.automatic, confirm]);
  const account = accounts.data?.roles.trading;
  const busy =
    !!batch &&
    ["running", "waiting_sales", "waiting_buys", "waiting_funds"].includes(
      batch.status,
    );
  const monitor = live.data?.monitor;
  const monitorMessage =
    monitor?.message ||
    live.data?.model?.message ||
    (live.isLoading
      ? "Loading live trading status…"
      : "Waiting for live strategy data. Refresh values to check the selected brokerage account.");
  const lastCheck = monitor?.last_check ?? live.data?.snapshot?.updated_at;
  const decisionRows = live.data?.model?.actions ?? [];
  const rows: Row[] = decisionRows.length
    ? decisionRows
    : (monitor?.watchlist ?? live.data?.model?.shortlist ?? []).map((pick) => ({
        ...pick,
        action: "WAIT",
        enabled: false,
        reason: monitorMessage,
      }));
  const progressOrders = monitor?.orders ?? ticketsForProgress(live.data);
  const progressSummary = monitor ?? {
    total: progressOrders.length,
    filled: progressOrders.filter(
      (r) => r.status === "filled" || r.broker_state === "filled",
    ).length,
    pending: progressOrders.filter(
      (r) => r.status === "pending" && r.broker_state !== "filled",
    ).length,
    unsent: progressOrders.filter((r) =>
      ["queued", "preview", "not_submitted"].includes(String(r.status)),
    ).length,
  };
  const ready = rows.filter(
    (r) => r.enabled === true && ["BUY", "EXIT"].includes(String(r.action)),
  );
  const readyKey = `${scope}:${ready
    .map((r) => `${r.symbol}:${r.action}`)
    .sort()
    .join(",")}`;
  useEffect(() => {
    if (!ready.length) {
      prompted.current = "";
      return;
    }
    if (
      active &&
      !enabled &&
      !automaticPreview &&
      !busy &&
      !confirm &&
      !selectedBuy &&
      !buy.isPending &&
      account?.selected &&
      prompted.current !== readyKey
    ) {
      prompted.current = readyKey;
      setConfirm("signal");
    }
  }, [
    active,
    enabled,
    automaticPreview,
    busy,
    confirm,
    selectedBuy,
    buy.isPending,
    account?.selected,
    ready.length,
    readyKey,
  ]);
  const tickets = (live.data?.tickets || []).filter((ticket) =>
    batch?.ticket_ids?.includes(String(ticket.id)),
  );
  return (
    <>
      {enabled && live.data?.auto.background && (
        <Notice>
          Backend trading session is active until{" "}
          {live.data.auto.expires_at
            ? new Date(live.data.auto.expires_at).toLocaleString()
            : "stopped"}
          . Closing this browser keeps it running.
        </Notice>
      )}
      <Failure
        error={
          live.error ||
          accounts.error ||
          live.data?.error ||
          refresh.error ||
          settings.error ||
          preview.error ||
          send.error ||
          auto.error ||
          manual.error ||
          buy.error
        }
      />
      {!account?.selected ? (
        <Notice>
          Select and save a dedicated daily trading account in Account settings.
        </Notice>
      ) : (
        <>
          <div className="metrics">
            <Metric
              title="Daily trading account"
              value={`•••• ${account.ending}`}
              detail="Separate from long-term holdings"
            />
            <Metric
              title="Live budget"
              value={money(accounts.data?.live_settings.budget)}
              detail="Independent of the paper session"
            />
            <Metric
              title="Buying power"
              value={money(live.data?.model?.buying_power)}
              detail="Broker-reported funds"
            />
            <Metric
              title="Target per stock"
              value={money(live.data?.model?.target_usd)}
              detail={`${live.data?.model?.allocation_slots ?? 4} allocation slots · after cash reserve`}
            />
            <Metric
              privateData={false}
              title="Automation"
              value={enabled ? "Running" : "Paused"}
              detail="Remembers your choice across app restarts"
              tone={enabled ? "positive" : ""}
            />
          </div>
          <Card
            title="Live trading settings"
            subtitle="The live strategy splits the budget after reserve across the top 2–4 qualifying stocks. Buys use available funds only. Saving settings sends no orders."
          >
            <div className="form-row">
              <label>
                Budget ($)
                <PrivateInput
                  type="number"
                  min="1"
                  value={budget}
                  disabled={busy || enabled}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </label>
              <label>
                Cash reserve (%)
                <PrivateInput
                  type="number"
                  min="0"
                  max="100"
                  value={reserve}
                  disabled={busy || enabled}
                  onChange={(e) => setReserve(Number(e.target.value))}
                />
              </label>
              <button
                disabled={
                  settings.isPending ||
                  busy ||
                  enabled ||
                  budget <= 0 ||
                  reserve < 0 ||
                  reserve > 100
                }
                onClick={() => settings.mutate()}
              >
                {settings.isPending ? "Saving…" : "Save live settings"}
              </button>
            </div>
            {settings.isSuccess && (
              <small className="success">
                Settings saved for this account.
              </small>
            )}
          </Card>
          <Card
            title="Live strategy monitor"
            subtitle="VWAP/EMA-confirmed breakouts and stronger-stock replacements, with volatility stops, profit protection and a daily loss circuit breaker."
            action={
              <button
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                <RefreshCw size={15} />
                {refresh.isPending ? "Updating…" : "Refresh values"}
              </button>
            }
          >
            <p className="muted">
              Targets 2–4 stocks; new buys respect a planned position-risk cap
              of 0.25% of account equity at the stop, including estimated costs.
              Entries stop 15 minutes before close. A 1% daily equity loss halts
              entries and triggers exits; remaining holdings exit five minutes
              before close. Stops are monitored by this running app, and
              execution prices can differ from the planned stop.
            </p>
            <Notice>
              <PrivateValue>
                <strong>
                  {monitor?.stage ||
                    (enabled ? "Monitoring signals" : "Automation paused")}
                </strong>
                {" · "}
                {monitorMessage}
              </PrivateValue>
            </Notice>
            <div className="metrics">
              <Metric
                title="Candidates monitored"
                value={String(monitor?.candidates ?? rows.length)}
                detail={
                  monitor?.signal_fresh
                    ? "Current market signals"
                    : "Waiting for fresh signals"
                }
              />
              <Metric
                title="Latest rebalance fills"
                value={
                  progressSummary.total
                    ? `${progressSummary.filled} / ${progressSummary.total}`
                    : "No orders in progress"
                }
                detail={
                  progressSummary.total
                    ? `${progressSummary.pending} pending · ${progressSummary.unsent} not sent`
                    : "Orders appear when trades qualify"
                }
              />
              <Metric
                title="Last account check"
                value={
                  lastCheck
                    ? new Date(lastCheck).toLocaleTimeString()
                    : "Not checked yet"
                }
                detail={
                  connection
                    ? "Updates arrive when backend data changes"
                    : "Checking status every second while reconnecting"
                }
              />
            </div>
            {!!monitor?.scan?.total &&
              ["loading_history", "refreshing_prices"].includes(
                monitor.scan.phase,
              ) && (
                <div role="status">
                  <PrivateValue>
                    {monitor.scan.completed} / {monitor.scan.total} stocks
                    checked
                  </PrivateValue>
                  {!privacy && (
                    <progress
                      aria-label="Stock scan progress"
                      value={monitor.scan.completed}
                      max={monitor.scan.total}
                    />
                  )}
                </div>
              )}
            {monitor?.rl && (
              <p className="footnote">
                <PrivateValue>{monitor.rl}</PrivateValue>
              </p>
            )}
            {rows.length ? (
              <Table
                rows={rows}
                columns={[
                  "symbol",
                  "action",
                  "top_up",
                  "price",
                  "range_high",
                  "rotation_score",
                  "quantity",
                  "dollar_amount",
                  "stop",
                  "target",
                  "net_reward_risk",
                  "learning_suggestion",
                  "learning_reason",
                  "stressed_reward_risk",
                  "estimated_round_trip_cost_pct",
                  "watch_since",
                  "replaced_symbol",
                  "reason",
                ]}
                name="Live decisions"
                rowActions={(row) => {
                  const symbol = String(row.symbol);
                  const shortlist =
                    monitor?.watchlist ?? live.data?.model?.shortlist ?? [];
                  if (!shortlist.some((p) => p.symbol === symbol)) return null;
                  const saved = accounts.data?.live_settings;
                  const reason = enabled
                    ? "Pause automatic trading to buy manually."
                    : busy
                      ? "Wait for the current orders to finish."
                      : monitor?.market_open === false
                        ? "The US market is closed."
                        : monitor?.signal_fresh === false
                          ? "Refresh broker status and the shortlist before buying."
                          : saved?.budget !== budget ||
                              saved?.reserve_pct !== reserve
                            ? "Save your trading budget and reserve first."
                            : row.after_sell_fills
                              ? "This buy depends on confirmed sales. Review the full rebalance first."
                              : row.enabled !== true ||
                                  row.side !== "buy" ||
                                  row.action !== "BUY"
                                ? String(
                                    row.reason ??
                                      "Waiting for an eligible buy setup.",
                                  )
                                : null;
                  return (
                    <div>
                      <button
                        disabled={
                          !!reason ||
                          buy.isPending ||
                          preview.isPending ||
                          manual.isPending ||
                          auto.isPending
                        }
                        onClick={() => {
                          send.reset();
                          buy.mutate(symbol, {
                            onSuccess: (view) => {
                              setConfirm(null);
                              setSelectedBuy({
                                view,
                                symbol,
                                scope,
                                ending:
                                  account?.ending?.replace(/^•+\s*/, "") ?? "",
                              });
                            },
                          });
                        }}
                      >
                        Buy {symbol}
                      </button>
                      {reason && (
                        <small className="footnote">
                          <PrivateValue>{reason}</PrivateValue>
                        </small>
                      )}
                    </div>
                  );
                }}
              />
            ) : (
              <Empty title="No stock decisions yet">
                <PrivateValue>{monitorMessage}</PrivateValue>
              </Empty>
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={
                  manual.isPending ||
                  preview.isPending ||
                  auto.isPending ||
                  busy ||
                  !ready.length
                }
                onClick={() =>
                  manual.mutate(undefined, {
                    onSuccess: () => setConfirm("batch"),
                  })
                }
              >
                {manual.isPending
                  ? "Preparing manual review…"
                  : "Manual buy / sell"}
              </button>
              {enabled ? (
                <button
                  className="danger"
                  disabled={auto.isPending}
                  onClick={() => auto.mutate(false)}
                >
                  <Square size={15} />
                  Stop automatic trading
                </button>
              ) : (
                <button
                  disabled={
                    auto.isPending ||
                    busy ||
                    !connection ||
                    !accounts.data?.live_settings.budget
                  }
                  onClick={() => setConfirm("auto")}
                >
                  <Play size={15} />
                  Start automatic trading
                </button>
              )}
            </div>
            {!ready.length && !busy && (
              <Notice>
                Manual buy / sell is available when a strategy trade qualifies.
                No trades qualify now; each stock’s reason is shown above.
              </Notice>
            )}
            <p className="footnote">
              Buy beside a shortlisted stock opens a review for that stock only;
              pause automation first. Blocked rows explain what is missing.
              Manual buy / sell is available with automation running or paused.
              It pauses automation and opens a broker preview for eligible
              trades. Confirm the preview to place orders. Automatic trading
              places real orders in this account. Backend sessions continue when
              you close the browser. Use Stop automatic trading to end the
              session. Keep the computer connected with its lid open. On macOS,
              active automation prevents idle sleep; the display can sleep.
            </p>
            <Failure error={live.data?.auto.error} />
          </Card>
          {batch && (
            <Card
              title="Rebalance progress"
              subtitle={
                <PrivateValue>
                  {batch.status === "stopped"
                    ? "Rebalance stopped; remaining orders were not sent."
                    : batch.progress || batch.status}
                </PrivateValue>
              }
              action={<Badge>{batch.status}</Badge>}
            >
              {typeof batch.confirmed_at === "string" && (
                <p className="footnote">
                  Rebalance confirmed{" "}
                  {new Date(batch.confirmed_at).toLocaleString()}.
                </p>
              )}
              <Failure error={batch.error} />
              {!!progressSummary.total && (
                <div role="status">
                  <PrivateValue>
                    {progressSummary.filled} of {progressSummary.total} orders
                    filled · {progressSummary.pending} pending ·{" "}
                    {progressSummary.unsent} not sent
                  </PrivateValue>
                  {!privacy && (
                    <progress
                      aria-label="Rebalance fill progress"
                      value={progressSummary.filled}
                      max={progressSummary.total}
                    />
                  )}
                </div>
              )}
              {progressOrders.length ? (
                <Table
                  rows={progressOrders}
                  columns={[
                    "symbol",
                    "side",
                    "quantity",
                    "dollar_amount",
                    "status",
                    "broker_state",
                    "reviewed_at",
                    "reason",
                  ]}
                  name="Robinhood rebalance results"
                />
              ) : (
                <Notice>
                  {batch.status === "preview"
                    ? batch.automatic || enabled
                      ? "Automatic rebalance is being prepared. No order confirmation is required."
                      : "A preview is ready. Review its tickets before confirming."
                    : "Order progress will update here."}
                </Notice>
              )}
              {batch.status === "preview" && !enabled && !batch.automatic && (
                <button onClick={() => setConfirm("batch")}>
                  Open confirmation
                </button>
              )}
              <a
                className="external"
                href="https://robinhood.com"
                target="_blank"
                rel="noreferrer"
              >
                Open Robinhood ↗
              </a>
            </Card>
          )}
          <Card
            title="Live account value"
            subtitle="Broker account equity, including cash. Deposits and withdrawals also change this value."
          >
            {live.data?.equity_history?.length ? (
              <Chart
                rows={live.data.equity_history}
                lines={["equity"]}
                title="Live trading account value"
                timeAxis
              />
            ) : (
              <Notice>
                Refresh the live account to start recording its value. The graph
                updates with broker snapshots.
              </Notice>
            )}
          </Card>
          <Card
            title="Current live positions"
            subtitle={
              live.data?.snapshot?.updated_at
                ? `Updated ${new Date(live.data.snapshot.updated_at).toLocaleString()}`
                : "Waiting for broker snapshot"
            }
          >
            <Table
              rows={live.data?.snapshot?.positions}
              name="Live positions"
            />
          </Card>
          <Card
            title="Order tickets"
            action={
              <button
                disabled={reconcile.isPending}
                onClick={() => reconcile.mutate()}
              >
                {reconcile.isPending
                  ? "Checking…"
                  : "Check broker order status"}
              </button>
            }
          >
            <Failure error={reconcile.error} />
            {live.data?.tickets
              .filter((ticket) =>
                ["unknown", "submitting"].includes(String(ticket.status)),
              )
              .map((ticket) => (
                <Notice key={String(ticket.id)}>
                  <p>
                    {String((ticket.arguments as Row)?.symbol)}{" "}
                    {String((ticket.arguments as Row)?.side)} needs its broker
                    receipt checked.
                  </p>
                  {(ticket.recovery_orders as Row[] | undefined)?.length ? (
                    (ticket.recovery_orders as Row[]).map((order) => (
                      <button
                        key={String(order.id)}
                        onClick={() => {
                          setReceiptConfirmed(false);
                          linkReceipt.reset();
                          setRecovery({ ticket, order });
                        }}
                      >
                        Review matching fill ·{" "}
                        {new Date(String(order.created_at)).toLocaleString()}
                      </button>
                    ))
                  ) : (
                    <p>
                      Check broker order status to refresh receipts. If none
                      match, verify the order in Robinhood before trading.
                    </p>
                  )}
                </Notice>
              ))}
            <Table
              rows={live.data?.tickets.map((ticket) => ({
                symbol: (ticket.arguments as Row | undefined)?.symbol,
                side: (ticket.arguments as Row | undefined)?.side,
                status: ticket.status,
                broker_state: (
                  (ticket.result as Row | undefined)?.order as Row | undefined
                )?.state,
                reviewed_at: ticket.reviewed_at,
                error: ticket.error,
              }))}
              name="Order tickets"
            />
          </Card>
          <Card
            title="Trading decision history"
            subtitle="Saved strategy checks, automation changes and order results for this account. Records survive restarts."
          >
            {live.data?.decision_history?.length ? (
              <Table
                rows={live.data.decision_history.slice(-100).reverse()}
                columns={["created_at", "kind", "automatic", "summary"]}
                name="Trading decision history"
              />
            ) : (
              <Notice>
                Strategy checks will appear here after the next account refresh.
              </Notice>
            )}
          </Card>
        </>
      )}
      {active && selectedBuy?.scope === scope && selectedBuy.view.batch && (
        <ConfirmDialog
          key={selectedBuy.view.batch.id}
          title={`Confirm US BUY ${selectedBuy.symbol} · •••• ${selectedBuy.ending}`}
          pending={send.isPending}
          error={send.error}
          onClose={() => setSelectedBuy(null)}
          onConfirm={() =>
            send.mutate(selectedBuy.view.batch!.id, {
              onSuccess: () => setSelectedBuy(null),
            })
          }
        >
          <p>
            Buy only {selectedBuy.symbol} in the displayed US trading account
            using the saved budget and risk limits. The backend rechecks price,
            available funds, eligibility and preview expiry before submission.
          </p>
          <Table
            rows={selectedBuy.view.tickets
              .filter((ticket) =>
                selectedBuy.view.batch?.ticket_ids?.includes(String(ticket.id)),
              )
              .map((ticket) => ({
                ...(ticket.arguments as Row),
                stop: ticket.stop,
                target: ticket.target,
                status: ticket.status,
              }))}
            columns={[
              "symbol",
              "side",
              "dollar_amount",
              "stop",
              "target",
              "status",
            ]}
            name="Selected US buy"
          />
        </ConfirmDialog>
      )}
      {confirm === "batch" && batch && !enabled && !batch.automatic && (
        <ConfirmDialog
          title={`Confirm Robinhood rebalance · •••• ${account?.ending}`}
          pending={send.isPending}
          error={send.error}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            send.mutate(batch.id, { onSuccess: () => setConfirm(null) })
          }
        >
          <p>
            Sells execute first. Buys wait for confirmed fills and available
            funds. The backend rechecks account, quotes, budget, risk and ticket
            expiration before submission.
          </p>
          <Table
            rows={tickets.map((ticket) => ({
              ...(ticket.arguments as Row),
              status: ticket.status,
              stop: ticket.stop,
              target: ticket.target,
            }))}
            name="Orders to confirm"
          />
        </ConfirmDialog>
      )}
      {recovery && (
        <Modal
          title="Confirm matching broker receipt"
          onClose={() => setRecovery(null)}
        >
          <p>
            Compare this filled order with the unresolved ticket in Robinhood.
            Linking it clears that ticket’s trading block. Automatic trading can
            resume if it is enabled.
          </p>
          <Table
            rows={[
              {
                source: "Unresolved ticket",
                ...(recovery.ticket.arguments as Row),
                time:
                  recovery.ticket.submitted_at ?? recovery.ticket.reviewed_at,
              },
              {
                source: "Broker fill",
                symbol: recovery.order.symbol,
                side: recovery.order.side,
                quantity: recovery.order.quantity,
                dollar_amount: recovery.order.dollar_amount,
                time: recovery.order.created_at,
                order_id: recovery.order.id,
                state: recovery.order.state,
              },
            ]}
            columns={[
              "source",
              "symbol",
              "side",
              "quantity",
              "dollar_amount",
              "time",
              "order_id",
              "state",
            ]}
            name="Receipt comparison"
          />
          <label className="check confirmation">
            <input
              type="checkbox"
              checked={receiptConfirmed}
              onChange={(e) => setReceiptConfirmed(e.target.checked)}
            />
            I verified in Robinhood that this fill belongs to this ticket.
          </label>
          <Failure error={linkReceipt.error} />
          <div className="actions">
            <button
              disabled={linkReceipt.isPending}
              onClick={() => setRecovery(null)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={!receiptConfirmed || linkReceipt.isPending}
              onClick={() =>
                linkReceipt.mutate(recovery, {
                  onSuccess: () => setRecovery(null),
                })
              }
            >
              {linkReceipt.isPending ? "Linking…" : "Link confirmed receipt"}
            </button>
          </div>
        </Modal>
      )}
      {confirm === "signal" && !enabled && !automaticPreview && (
        <Modal
          title="Buy or sell signals are ready"
          onClose={() => setConfirm(null)}
        >
          <p>
            Review the broker preview, then confirm the orders to submit. This
            step sends no orders.
          </p>
          <Table
            rows={ready}
            columns={[
              "symbol",
              "action",
              "dollar_amount",
              "quantity",
              "reason",
            ]}
            name="Trades ready for review"
          />
          <Failure error={preview.error} />
          <div className="actions">
            <button onClick={() => setConfirm(null)}>Later</button>
            <button
              className="primary"
              disabled={preview.isPending || !ready.length}
              onClick={() =>
                preview.mutate(undefined, {
                  onSuccess: () => setConfirm("batch"),
                })
              }
            >
              {preview.isPending
                ? "Preparing preview…"
                : "Review broker preview"}
            </button>
          </div>
        </Modal>
      )}
      {confirm === "auto" && (
        <ConfirmDialog
          title={`Start automatic trading · •••• ${account?.ending}`}
          pending={auto.isPending}
          error={auto.error}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            auto.mutate(true, { onSuccess: () => setConfirm(null) })
          }
        >
          <p>
            The strategy may submit buys and exits automatically within your
            saved{" "}
            <PrivateValue>
              {money(accounts.data?.live_settings.budget)}
            </PrivateValue>{" "}
            budget and{" "}
            <PrivateValue>
              {accounts.data?.live_settings.reserve_pct}%
            </PrivateValue>{" "}
            reserve. This authorizes the backend to trade for up to twelve
            hours, including while your browser is closed. It can enter an
            established confirmed breakout and replace a weaker holding with a
            stronger one. The budget after reserve is split equally across 2–4
            qualifying stocks. If only one qualifies, at most half is allocated
            to it. The strategy can top up existing positions toward their
            allocations when funds are available. Stops, targets and the daily
            loss limit still apply. Replacements require a 0.25 percentage-point
            improvement in breakout strength. Stop the session from any paired
            device. Your on/off choice is remembered across API and UI restarts
            until this session expires; restarting does not extend its
            twelve-hour limit.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
function PaperTrading() {
  const paper = useData<Paper | null>("paper", "/paper", 15_000);
  const [budget, setBudget] = useState(1000);
  const [reserve, setReserve] = useState(10);
  const action = useAction((command: string) =>
    request<Paper>("/paper/control", {
      action: command,
      budget,
      reserve_pct: reserve,
    }),
  );
  const state = paper.data;
  const active = !!state && state.status !== "Ended";
  useEffect(() => {
    if (state) {
      setBudget(state.budget);
      setReserve(state.reserve_pct);
    }
  }, [state?.budget, state?.reserve_pct]);
  const positions: Row[] = state
    ? Object.entries(state.positions).map(([symbol, value]) => ({
        symbol,
        ...value,
      }))
    : [];
  const equity = state
    ? state.cash +
      positions.reduce(
        (sum, row) => sum + (num(row.quantity) || 0) * (num(row.price) || 0),
        0,
      )
    : undefined;
  return (
    <>
      <Notice>
        Paper trading is a simulation. Starting, pausing or ending it never
        submits brokerage orders or changes live settings.
      </Notice>
      <Failure error={paper.error || action.error} />
      <Card
        title="Paper session"
        action={
          <Badge tone={state?.status === "Running" ? "bullish" : ""}>
            {state?.status || "Not started"}
          </Badge>
        }
      >
        <div className="form-row">
          <label>
            Paper budget ($)
            <PrivateInput
              type="number"
              min="1"
              value={budget}
              disabled={active}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </label>
          <label>
            Paper cash reserve (%)
            <PrivateInput
              type="number"
              min="0"
              max="100"
              value={reserve}
              disabled={active}
              onChange={(e) => setReserve(Number(e.target.value))}
            />
          </label>
          <div className="actions">
            {!active ? (
              <button
                className="primary"
                disabled={
                  action.isPending ||
                  budget <= 0 ||
                  reserve < 0 ||
                  reserve > 100
                }
                onClick={() => action.mutate("start")}
              >
                Start paper session
              </button>
            ) : (
              <>
                <button
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(
                      state.status === "Running" ? "pause" : "resume",
                    )
                  }
                >
                  {state.status === "Running"
                    ? "Pause simulation"
                    : "Resume simulation"}
                </button>
                <button
                  disabled={action.isPending}
                  onClick={() => action.mutate("end")}
                >
                  End session
                </button>
              </>
            )}
          </div>
        </div>
        <p>
          <PrivateValue>
            {state?.message ||
              "Paper trading uses its own capital and the opening-range strategy. No live account is required."}
          </PrivateValue>
        </p>
      </Card>
      {state && (
        <>
          <div className="metrics">
            <Metric title="Simulated equity" value={money(equity)} />
            <Metric title="Paper cash" value={money(state.cash)} />
            <Metric title="Realized P&L" value={money(state.realized_pnl)} />
            <Metric
              title="Last strategy check"
              value={
                state.last_check
                  ? new Date(state.last_check).toLocaleTimeString()
                  : "Waiting"
              }
            />
          </div>
          <Card
            title="Paper shortlist"
            subtitle="Stocks being monitored and the reason each is waiting or held."
          >
            <Table
              rows={state.decisions ?? state.shortlist ?? []}
              columns={[
                "symbol",
                "action",
                "range_high",
                "range_low",
                "relative_volume",
                "watch_since",
                "replaced_symbol",
                "reason",
              ]}
              name="Paper shortlist"
            />
          </Card>
          <Card title="Paper positions">
            <Table rows={positions} name="Paper positions" />
          </Card>
          {!!state.equity_history?.length && (
            <Card title="Paper equity">
              <Chart
                rows={state.equity_history.map((row) => ({
                  ...row,
                  date: String(row.timestamp || row.date || ""),
                }))}
                lines={["equity"]}
                title="Simulated account equity over time"
              />
            </Card>
          )}
          <Card title="Simulated fills">
            <Table rows={[...state.fills].reverse()} name="Paper fills" />
          </Card>
          <Card title="Closed trades">
            <Table rows={state.closed_trades} name="Closed paper trades" />
          </Card>
        </>
      )}
    </>
  );
}

export function KiteRebalance({
  plan,
  onClose,
  brokerName,
}: {
  plan: { strategy: Strategy; selected: string[]; exits: string[] };
  onClose: () => void;
  brokerName: string;
}) {
  const [draft, setDraft] = useState<KiteDraft | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const prepare = useAction(
    () => runJob<KiteDraft>("/india/investing/draft", plan),
    [],
  );
  const review = useAction(
    () => runJob<Batch>("/india/investing/review", { id: draft?.id, rows }),
    [],
  );
  const submit = useAction(() =>
    runJob<Batch>(`/india/investing/batches/${batch?.id}/confirm`, {
      acknowledged: true,
    }),
  );
  const check = useAction(() =>
    runJob<Batch>(`/india/investing/batches/${batch?.id}/status`),
  );
  useEffect(() => {
    prepare.mutate();
  }, []); // Only opens a read-only editor; never submits orders.
  useEffect(() => {
    if (prepare.data) {
      setDraft(prepare.data);
      setRows(prepare.data.rows);
    }
  }, [prepare.data]);
  useEffect(() => {
    if (review.data) {
      setBatch(review.data);
      setAcknowledged(false);
    }
  }, [review.data]);
  useEffect(() => {
    if (submit.data) setBatch(submit.data);
  }, [submit.data]);
  useEffect(() => {
    if (check.data) setBatch(check.data);
  }, [check.data]);
  const pending =
    prepare.isPending ||
    review.isPending ||
    submit.isPending ||
    check.isPending;
  function edit(index: number, key: string, value: number) {
    setRows(
      rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    );
    setBatch(null);
    setAcknowledged(false);
  }
  return (
    <Modal title={`Review ${brokerName} rebalance`} onClose={onClose}>
      <Failure
        error={prepare.error || review.error || submit.error || check.error}
      />
      {prepare.isPending ? (
        <Notice>Loading current {brokerName} holdings and prices…</Notice>
      ) : !draft ? (
        <Empty title="Could not open the editor" />
      ) : (
        <>
          {(!batch || batch.status === "review") && (
            <>
              <p>
                Adjust whole-share buy and sell quantities. The broker rechecks
                holdings, funds and account identity at review and confirmation.
              </p>
              <div className="table-scroll">
                <table aria-label={`${brokerName} share editor`}>
                  <thead>
                    <tr>
                      <th>Stock</th>
                      <th>Held</th>
                      <th>Price</th>
                      <th>Sell shares</th>
                      <th>Buy shares</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${String(row.exchange)}:${String(row.symbol)}`}>
                        <td>{String(row.symbol)}</td>
                        <td>
                          <PrivateValue>
                            {String(row.current_shares)}
                          </PrivateValue>
                        </td>
                        <td>{money(row.price_inr, "INR")}</td>
                        {["sell_shares", "buy_shares"].map((key) => (
                          <td key={key}>
                            <PrivateInput
                              aria-label={`${key === "sell_shares" ? "Sell" : "Buy"} ${String(row.symbol)} shares`}
                              type="number"
                              min="0"
                              step="1"
                              value={Number(row[key])}
                              disabled={pending}
                              onChange={(e) =>
                                edit(index, key, Number(e.target.value))
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button disabled={pending} onClick={() => review.mutate()}>
                {review.isPending ? "Reviewing…" : "Review edited orders"}
              </button>
            </>
          )}
          {batch && (
            <>
              <Notice>
                Broker review · {batch.status}
                {batch.user ? ` · ${brokerName} ${String(batch.user)}` : ""}
              </Notice>
              <Failure error={batch.error} />
              <Table rows={batch.orders} name="Reviewed investment orders" />
              {batch.status === "review" ? (
                <>
                  <label className="check confirmation">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    I confirm these real {brokerName} orders in the displayed
                    account.
                  </label>
                  <button
                    className="primary"
                    disabled={!acknowledged || pending}
                    onClick={() => submit.mutate()}
                  >
                    {submit.isPending
                      ? "Submitting…"
                      : `Confirm real ${brokerName} orders`}
                  </button>
                </>
              ) : (
                <>
                  <Table rows={batch.results} name="Investment order results" />
                  <button disabled={pending} onClick={() => check.mutate()}>
                    Check broker order status
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function KiteHistory() {
  const india = useData<{ broker: string | null; scope: string | null }>(
    ["india-trading"],
    "/india/trading",
  );
  const history = useData<Batch[]>("kite-batches", "/india/investing/batches");
  const [opened, setOpened] = useState<Batch | null>(null);
  useEffect(() => setOpened(null), [india.data?.broker, india.data?.scope]);
  const check = useAction(
    (id: string) => runJob<Batch>(`/india/investing/batches/${id}/status`),
    ["kite-batches"],
  );
  return (
    <Card
      title="India investment rebalance history"
      subtitle="Reviewed and submitted baskets remain available after closing the editor."
    >
      <Failure error={history.error || check.error} />
      {history.data?.length ? (
        <div className="batch-list">
          {history.data.map((batch) => (
            <div className="batch-row" key={batch.id}>
              <div>
                <strong>
                  {String(batch.reviewed_at || batch.id).slice(0, 19)}
                </strong>
                <small>
                  Account {String(batch.user || "")} ·{" "}
                  {(batch.orders || []).length} orders
                </small>
              </div>
              <Badge>{batch.status}</Badge>
              <button onClick={() => setOpened(batch)}>View details</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="footnote">No saved investment rebalances.</p>
      )}
      {opened && (
        <Modal
          title={`Investment rebalance · ${String(opened.user || "")}`}
          onClose={() => setOpened(null)}
        >
          <Badge>{opened.status}</Badge>
          <Failure error={opened.error || check.error} />
          <Table rows={opened.orders} name="Saved investment orders" />
          <Table rows={opened.results} name="Saved investment results" />
          <button
            disabled={check.isPending}
            onClick={() => check.mutate(opened.id, { onSuccess: setOpened })}
          >
            Check broker order status
          </button>
          <p className="footnote">
            This checks submitted orders and never resubmits a basket.
          </p>
        </Modal>
      )}
    </Card>
  );
}

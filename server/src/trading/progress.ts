import type { Row } from "../shared/storage.js";
import { localDay, session } from "../shared/calendar.js";
import { failedOrderStates, type Signals } from "./live.js";

/** Read-only projection: displaying progress never invokes a broker. */
export function tradingProgress(
  signals: Signals,
  snapshot: Row | null,
  model: Row | null,
  auto: Row,
  batch: Row | null,
  tickets: Row[],
  error: string | null,
  now = Date.now(),
): Row {
  const hours = session(localDay(now, "NYSE"));
  const marketOpen = !!hours && now >= hours[0] && now < hours[1];
  const orders = (batch?.ordered_ids ?? batch?.ticket_ids ?? []).map(
    (id: string) => {
      const ticket = tickets.find((t) => t.id === id);
      const result = batch?.results?.find((r: Row) => r.id === id);
      const state = ticket?.result?.order?.state ?? result?.broker_state;
      return {
        symbol: ticket?.arguments?.symbol ?? result?.symbol ?? "Unavailable",
        side: ticket?.arguments?.side ?? result?.side,
        quantity: ticket?.arguments?.quantity ?? null,
        dollar_amount: ticket?.arguments?.dollar_amount ?? null,
        status:
          (state === "filled" || failedOrderStates.has(state)
            ? state
            : undefined) ??
          result?.status ??
          (ticket?.status === "preview"
            ? "queued"
            : (ticket?.status ?? "queued")),
        reviewed_at: ticket?.reviewed_at ?? null,
        broker_state: state ?? null,
        reason:
          ticket?.error ??
          (result?.status === "pending" &&
          state !== "filled" &&
          !failedOrderStates.has(state)
            ? "Waiting for broker fill"
            : batch?.status === "stopped" && !result
              ? "Not sent; rebalance stopped"
              : null),
      };
    },
  );
  const filled = orders.filter(
    (r: Row) => r.status === "filled" || r.broker_state === "filled",
  ).length;
  const pending = orders.filter(
    (r: Row) => r.status === "pending" && r.broker_state !== "filled",
  ).length;
  const batchTime =
    batch?.confirmed_at ??
    tickets.find((t) => batch?.ticket_ids?.includes(t.id))?.reviewed_at;
  const currentBatch =
    !batchTime ||
    localDay(Date.parse(batchTime), "NYSE") === localDay(now, "NYSE");
  const activeBatch =
    currentBatch &&
    ((batch &&
      [
        "preview",
        "running",
        "waiting_sales",
        "waiting_buys",
        "waiting_funds",
      ].includes(batch.status)) ||
      (batch && batch.status === "stopped" && !auto.enabled));
  let stage = "Monitoring signals",
    message = model?.message ?? signals.message;
  const unresolved = tickets.find((t) =>
    ["unknown", "submitting"].includes(t.status),
  );
  if (unresolved) {
    stage = "Needs attention";
    message = `${unresolved.arguments.symbol} ${unresolved.arguments.side} has unresolved order status. Use Check broker order status in Order tickets before trading.`;
  } else if (error || auto.error) {
    stage = "Needs attention";
    message = error ?? auto.error;
  } else if (activeBatch) {
    stage = batch.status.replaceAll("_", " ");
    message =
      batch.error ??
      batch.progress ??
      "Preparing broker previews for the rebalance.";
  } else if (!marketOpen) {
    stage = "Market closed";
    message = "The US market is closed. Waiting for the next trading session.";
  } else if (
    signals.scan &&
    ["loading_history", "refreshing_prices", "loading_universe"].includes(
      signals.scan.phase,
    )
  ) {
    stage =
      signals.scan.phase === "refreshing_prices"
        ? "Refreshing prices"
        : "Scanning stocks";
    message = signals.message;
  } else if (!signals.fresh) {
    stage = "Waiting for market data";
    message = signals.message;
  } else if (!snapshot) {
    stage = "Waiting for account data";
    message =
      "Waiting for a current snapshot of the selected brokerage account.";
  } else if (!signals.ranked.length && !model?.actions?.length) {
    stage = "No qualifying candidates";
    message =
      "No stocks currently meet the entry criteria. Automatic trading continues checking while enabled.";
  } else if (!(model?.actions ?? []).some((a: Row) => a.enabled)) {
    stage = "Waiting for eligible trades";
    message =
      (model?.actions ?? [])
        .map((a: Row) => `${a.symbol}: ${a.reason}`)
        .join(" · ") || "No trades currently qualify under the strategy.";
  } else {
    stage = "Trades eligible";
  }
  return {
    stage,
    message,
    market_open: marketOpen,
    last_check: snapshot?.updated_at ?? null,
    signal_time: signals.asof,
    signal_fresh: signals.fresh,
    candidates: signals.ranked.length,
    watchlist: signals.ranked,
    scan: signals.scan ?? null,
    rl: signals.policy
      ? (model?.rl?.reason ??
        "Trained RL policy loaded; waiting for an allocation decision.")
      : "RL model is not configured; opening-range allocation is active.",
    orders,
    total: orders.length,
    filled,
    pending,
    unsent: orders.filter((r: Row) =>
      ["queued", "preview", "not_submitted"].includes(r.status),
    ).length,
    batch_status: batch?.status ?? null,
  };
}

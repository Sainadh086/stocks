import { Decimal } from "decimal.js";
import * as accounts from "./brokers/accounts.js";
import * as robinhood from "./brokers/robinhood.js";
import * as india from "./brokers/india.js";
import * as kite from "./brokers/kite.js";
import { investmentScope, requireBroker } from "./brokers/india-selection.js";
import { localDay, session } from "./shared/calendar.js";
import { type Row } from "./shared/storage.js";
import { power, quoteCurrent, ticketPending, failedOrderStates } from "./trading/live.js";

export type InvestmentMarket = "India" | "US";
export interface PurchaseRequest {
  market: InvestmentMarket;
  symbol: string;
  expected_scope: string;
  amount?: number;
  quantity?: number;
  exchange?: "NSE" | "BSE";
}
const purpose = "individual_long_term";
function requireScope(market: InvestmentMarket, expected: string): string {
  const current = market === "US" ? accounts.scope(accounts.roles().long_term) : investmentScope();
  if (!expected || !current || expected !== current)
    throw new Error("Long-term account changed. Review a new purchase.");
  return current;
}
function requireOpen(market: InvestmentMarket): void {
  const now = Date.now(), exchange = market === "US" ? "NYSE" : "NSE";
  const hours = session(localDay(now, exchange), exchange);
  if (!hours || now < hours[0] || now >= hours[1])
    throw new Error("The market is closed. Review this long-term purchase during regular market hours.");
}
async function checkUS(s: robinhood.BrokerSession, number: string, symbol: string, amount: string, ownId?: string): Promise<void> {
  const snapshot = await robinhood.readSnapshot(s, number, [symbol]);
  const available = power(snapshot.portfolio);
  if (available == null || new Decimal(amount).gt(available))
    throw new Error("Available cash cannot cover this long-term purchase.");
  if (!quoteCurrent(snapshot.quotes[symbol], Date.now(), 90000))
    throw new Error("A recent broker quote is required. Review the purchase again.");
  if (snapshot.orders.some((order: Row) => order.symbol === symbol && order.state !== "filled" && !failedOrderStates.has(order.state)) ||
      robinhood.listTickets(number, "long_term").some(ticket => ticket.id !== ownId && ticketPending(ticket, snapshot.orders)))
    throw new Error("A long-term order is pending or unresolved. Check its broker status first.");
}

export function purchaseView(market: InvestmentMarket, order: Row): Row {
  const us = market === "US", args = us ? order.arguments : order.orders[0];
  const number = us ? args.account_number : order.user;
  return {
    id: order.id, market, symbol: us ? args.symbol : args.tradingsymbol,
    scope: us ? accounts.scope(number) : accounts.scope(order.broker + ":" + number),
    account: `${us ? "Robinhood long-term" : india.names[order.broker as india.IndiaBroker]} · ••••${String(number).slice(-4)}`,
    amount: us ? Number(args.dollar_amount) : order.estimated_buys,
    quantity: us ? null : args.quantity,
    exchange: us ? "US" : args.exchange,
    currency: us ? "USD" : "INR", product: us ? "Long-term investing" : "Delivery (CNC)",
    status: us ? order.status : order.status === "review" ? "preview" : order.status,
    reviewed_at: order.reviewed_at,
    expires_at: new Date(Date.parse(order.reviewed_at) + 120000).toISOString(),
    error: order.error ?? null,
    broker_order_id: us ? order.result?.order?.id ?? null : order.results?.[0]?.order_id ?? null,
    broker_status: us ? order.result?.order?.state ?? null : order.results?.[0]?.broker_status ?? null,
    estimated_fees: us ? order.preview?.estimated_fees ?? null : null,
  };
}

export async function previewPurchase(p: PurchaseRequest, broker: typeof robinhood.connected = robinhood.connected): Promise<Row> {
  requireScope(p.market, p.expected_scope);
  requireOpen(p.market);
  const symbol = p.symbol.trim().toUpperCase();
  if (p.market === "US") {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || p.quantity !== undefined || p.exchange !== undefined)
      throw new Error("Enter a US equity symbol and dollar amount only.");
    const amount = robinhood.positiveDecimal(p.amount, 2);
    if (new Decimal(amount).lt(1)) throw new Error("The minimum purchase is $1.");
    const number = accounts.roles().long_term;
    if (!number) throw new Error("Select a long-term Robinhood account first.");
    const ticket = await broker(async s => {
      await robinhood.verifyLongTerm(s, number);
      await checkUS(s, number, symbol, amount);
      requireScope("US", p.expected_scope);
      return robinhood.preview({ account_number: number, symbol, side: "buy", dollar_amount: amount,
        type: "market", time_in_force: "gfd", market_hours: "regular_hours" }, action => action(s), "long_term");
    });
    return purchaseView("US", ticket);
  }
  if (!/^[A-Z0-9&.\-]{1,30}$/.test(symbol) || !["NSE", "BSE"].includes(p.exchange ?? "NSE") ||
      !Number.isSafeInteger(p.quantity) || !(p.quantity! > 0) || p.amount !== undefined)
    throw new Error("Enter an India equity symbol and a positive whole-share quantity.");
  const selected = requireBroker(), account = await india.investingState(selected);
  requireScope("India", p.expected_scope);
  const rows = [{ symbol, exchange: p.exchange ?? "NSE", current_shares: 0, target_shares: p.quantity, sell_shares: 0, buy_shares: p.quantity }];
  const batch = await kite.review(rows, rows, { broker: selected, user: account.user, purpose });
  return purchaseView("India", batch);
}

function selectedOrder(market: InvestmentMarket, id: string, expected: string): Row {
  requireScope(market, expected);
  const order = market === "US" ? robinhood.tickets()[id] : kite.batches()[id];
  if (!order || (market === "US" ? order.role !== "long_term" : order.purpose !== purpose ||
      order.orders.length !== 1 || order.orders[0].transaction_type !== "BUY" || order.orders[0].product !== "CNC") ||
      purchaseView(market, order).scope !== expected)
    throw new Error("Long-term purchase was not found for the selected account.");
  return order;
}
export async function confirmPurchase(market: InvestmentMarket, id: string, expected: string, acknowledged: boolean,
  broker: typeof robinhood.connected = robinhood.connected): Promise<Row> {
  if (acknowledged !== true) throw new Error("Explicit purchase confirmation is required.");
  const order = selectedOrder(market, id, expected);
  requireOpen(market);
  if (market === "India") return purchaseView(market, await kite.submit(order.id, true));
  const consent = () => { requireScope("US", expected); accounts.requireLongTerm(order.arguments.account_number); requireOpen("US"); };
  const result = await robinhood.submit(order.id, true, async (ticket, s) => {
    if (ticket.arguments.side !== "buy" || ticket.arguments.type !== "market" || ticket.arguments.market_hours !== "regular_hours")
      throw new Error("Purchase order changed. Review again.");
    await checkUS(s, ticket.arguments.account_number, ticket.arguments.symbol, ticket.arguments.dollar_amount, ticket.id);
  }, consent, broker, "long_term");
  return purchaseView("US", result);
}
export function purchaseHistory(market: InvestmentMarket): Row[] {
  const scope = market === "US" ? accounts.scope(accounts.roles().long_term) : investmentScope();
  const orders = market === "US" ? robinhood.listTickets(accounts.roles().long_term, "long_term") :
    Object.values(kite.batches()).filter(order => order.purpose === purpose);
  return orders.map(order => purchaseView(market, order)).filter(order => order.scope === scope)
    .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at)).slice(0, 20);
}
export async function purchaseStatus(market: InvestmentMarket, id: string, expected: string,
  broker: typeof robinhood.connected = robinhood.connected): Promise<Row> {
  const order = selectedOrder(market, id, expected);
  return purchaseView(market, market === "US" ? await robinhood.reconcile(order.id, broker) : await kite.refreshStatus(order.id));
}

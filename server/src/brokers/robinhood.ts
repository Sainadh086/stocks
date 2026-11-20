import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import { createRequire } from "node:module";
import { recordLearningOrders, learningScope } from "../learning.js";
import {
  mkdtempSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  store,
  projectRoot,
  US,
  Mutex,
  errorMessage,
  type Row,
} from "../shared/storage.js";
import { TradeDecisionChanged } from "../trading/rotation.js";
import { MIN_DOLLAR_BUY } from "../trading/order-limits.js";
import { PersistentSession, type SessionLease } from "./persistent-session.js";
import { eligible, roles, requireTrading, requireLongTerm, holdingsPath, type AccountRole } from "./accounts.js";
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly operation?: string,
  ) {
    super(message);
  }
}
const readOperations = new Set([
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_orders",
  "get_equity_quotes",
  "list_tools",
]);
export function transientMcpError(error: unknown): boolean {
  if (error instanceof BrokerError) return false;
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === -32001 ||
    e?.code === -32000 ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(
      String(e?.code),
    ) ||
    /request timed out|connection closed|fetch failed|socket hang up/i.test(
      String(e?.message),
    )
  );
}
export class McpConnectionError extends Error {}
/** Broker throttles include the cooldown in the error body rather than headers. */
export function readThrottleDelay(error: unknown): number {
  if (
    !(error instanceof BrokerError) ||
    !error.operation ||
    !readOperations.has(error.operation) ||
    !/(?:API error|HTTP|status)[ :]*429|throttl|rate limit|too many requests/i.test(
      error.message,
    )
  )
    return 0;
  const seconds = error.message.match(
    /(?:expected available in|retry (?:after|in))\s+(\d+(?:\.\d+)?)\s*seconds?/i,
  );
  const delay = seconds ? Number(seconds[1]) * 1000 + 1000 : 30000;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 30000;
}
export function recoverableReadError(error: unknown): boolean {
  return (
    readThrottleDelay(error) > 0 ||
    error instanceof McpConnectionError ||
    (error instanceof BrokerError &&
      !!error.operation &&
      readOperations.has(error.operation) &&
      /(?:API error|HTTP|status)[ :]*(?:429|5\d\d)|rate limit|too many requests|temporarily unavailable/i.test(
        error.message,
      ))
  );
}
/** Retry only idempotent reads, never a review or order placement. */
export async function mcpRequest<T>(
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const attempts = readOperations.has(name) ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      const cooldown = readThrottleDelay(error);
      if (cooldown && readOperations.has(name) && attempt + 1 < attempts) {
        // Bound time spent inside a workflow; longer cooldowns go to the worker.
        if (cooldown > 60000) throw error;
        await new Promise((resolve) => setTimeout(resolve, cooldown));
        continue;
      }
      if (!transientMcpError(error)) throw error;
      if (attempt + 1 < attempts) continue;
      throw new McpConnectionError(
        `Robinhood MCP ${name} timed out or disconnected${attempts > 1 ? " after one retry" : ""}. ` +
          (name === "place_equity_order"
            ? "Order status is uncertain. Check broker order status before placing another order."
            : "Could not refresh broker data. Try refreshing again shortly."),
        { cause: error },
      );
    }
  }
  throw new Error("MCP request did not complete.");
}
export function decodeResult(response: Row, name: string): Row {
  const texts = (
    Array.isArray(response.content) ? response.content : []
  ).filter((b: Row) => b.type === "text" && typeof b.text === "string");
  let payload = response.structuredContent;
  if (!payload && texts.length === 1) {
    try {
      payload = JSON.parse(texts[0].text);
    } catch {}
  }
  if (response.isError || payload?.error) {
    const detail =
      payload?.error?.message ??
      payload?.message ??
      (typeof payload?.error === "string" ? payload.error : undefined) ??
      texts[0]?.text;
    const safe =
      typeof detail === "string"
        ? detail
            .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
            .replace(
              /((?:access_token|refresh_token|client_secret|authorization)["'\s:=]+)[^\s,}"']+/gi,
              "$1[redacted]",
            )
            .slice(0, 500)
        : "Check broker permissions and order status.";
    throw new BrokerError(`Robinhood ${name}: ${safe}`, name);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.data ||
    typeof payload.data !== "object"
  )
    throw new Error(
      `Robinhood ${name} returned no readable result data. Verify order status before retrying.`,
    );
  return payload.data;
}
export interface BrokerSession {
  call(name: string, args: Row): Promise<Row>;
  rows(name: string, number: string, key: string): Promise<Row[]>;
}
const allowed = new Set([
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_orders",
  "get_equity_quotes",
  "review_equity_order",
  "place_equity_order",
]);
const submitLock = new Mutex(),
  require = createRequire(import.meta.url),
  ajv = new Ajv({ strict: false });
const oauthFile = join(projectRoot, ".robinhood_oauth.enc");
function files(root: string): string[] {
  return readdirSync(root).flatMap((n) => {
    const p = join(root, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
/** Persist only reusable credentials, never another process's auth locks or PKCE verifier. */
export const durableOAuthPath = (path: string) =>
  /(?:^|[\\/])[^\\/]+_(?:tokens|client_info)\.json$/.test(path);

async function openBrokerConnection(): Promise<SessionLease<BrokerSession>> {
  const temp = mkdtempSync(join(tmpdir(), "stocks-oauth-"));
  chmodSync(temp, 0o700);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      require.resolve("mcp-remote/dist/proxy.js"),
      "https://agent.robinhood.com/mcp/trading",
      "--transport",
      "http-only",
      "--silent",
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            entry[0].toUpperCase() !== "VARSHAN_ENCRYPTION_KEY",
        ),
      ),
      MCP_REMOTE_CONFIG_DIR: temp,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "varshan", version: "2.0.0" });
  let alive = true,
    restored = false,
    disposed = false;
  let persistedOAuth: string | null = null;
  client.onclose = () => {
    alive = false;
  };
  const persist = () => {
    if (!restored) return;
    const saved = Object.fromEntries(
      files(temp)
        .filter((path) => durableOAuthPath(relative(temp, path)))
        .sort()
        .map((path) => {
          const raw = readFileSync(path);
          // Never persist a partially written cache file, or expose its contents.
          try {
            JSON.parse(raw.toString());
          } catch {
            throw new Error(
              "Robinhood OAuth cache is incomplete; credentials were not overwritten.",
            );
          }
          return [relative(temp, path), raw.toString("base64")];
        }),
    );
    // An empty cache is meaningful: do not resurrect tokens invalidated by OAuth.
    const serialized = JSON.stringify(saved);
    if (serialized === persistedOAuth) return;
    store.save(oauthFile, saved);
    persistedOAuth = serialized;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    alive = false;
    clearTimeout(timeout);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    try {
      persist();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
  // Drain the pipe without logging OAuth output or letting it block the helper.
  transport.stderr?.on("data", () => {});
  const timeout = setTimeout(() => {
    void client.close().catch(() => {});
    void transport.close().catch(() => {});
  }, 90000);
  try {
    const cached = store.json<Record<string, string>>(oauthFile, {});
    for (const [name, encoded] of Object.entries(cached)) {
      if (!durableOAuthPath(name)) continue;
      const path = resolve(temp, name);
      if (!path.startsWith(temp + sep))
        throw new Error("Invalid OAuth cache path.");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(encoded, "base64"), { mode: 0o600 });
    }
    restored = true;
    await mcpRequest("connect", () =>
      client.connect(transport, { timeout: 90000 }),
    );
    clearTimeout(timeout);
    const tools = new Map<string, Row>();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await mcpRequest("list_tools", () =>
        client.listTools(cursor ? { cursor } : undefined, { timeout: 90000 }),
      );
      for (const tool of page.tools)
        if (allowed.has(tool.name)) tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Robinhood repeated a tool cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    const session: BrokerSession = {
      async call(name, args) {
        const tool = tools.get(name);
        if (!tool || !allowed.has(name))
          throw new Error(`Robinhood tool ${name} is unavailable.`);
        if (name.startsWith("get_") && tool.annotations?.readOnlyHint !== true)
          throw new Error(`Robinhood ${name} is not marked read-only.`);
        const validate = ajv.compile(tool.inputSchema);
        if (!validate(args))
          throw new Error(`Invalid arguments for Robinhood ${name}.`);
        return mcpRequest(name, async () =>
          decodeResult(
            await client.callTool({ name, arguments: args }, undefined, {
              timeout: 90000,
            }),
            name,
          ),
        );
      },
      async rows(name, number, key) {
        const result: Row[] = [],
          seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const payload = await session.call(name, {
            account_number: number,
            ...(cursor ? { cursor } : {}),
          });
          const page = payload[key];
          if (!Array.isArray(page))
            throw new Error("Robinhood returned an invalid list.");
          result.push(...page.filter(Boolean));
          cursor = payload.next;
          if (cursor && seen.has(cursor))
            throw new Error("Robinhood repeated a pagination cursor.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        return result;
      },
    };
    return { value: session, isOpen: () => alive, persist, close: dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
const brokerConnection = new PersistentSession(
  openBrokerConnection,
  (error) => error instanceof McpConnectionError || transientMcpError(error),
);
export function connected<T>(
  action: (session: BrokerSession) => Promise<T>,
): Promise<T> {
  return brokerConnection.run(action);
}
export const closeConnection = () => brokerConnection.close();
export const listAccounts = () =>
  connected(async (s) =>
    (await s.call("get_accounts", {})).accounts.filter(eligible),
  );
export async function verifyTrading(
  s: BrokerSession,
  number: string,
): Promise<void> {
  requireTrading(number);
  const account = (await s.call("get_accounts", {})).accounts.find(
    (a: Row) =>
      a.account_number === number && eligible(a) && a.agentic_allowed === true,
  );
  if (!account)
    throw new Error(
      "Saved daily trading account is unavailable or not Agentic eligible.",
    );
}
export async function verifyLongTerm(s: BrokerSession, number: string): Promise<void> {
  requireLongTerm(number);
  const available = (await s.call("get_accounts", {})).accounts;
  if (!available.some((account: Row) => account.account_number === number && eligible(account)))
    throw new Error("Saved long-term account is unavailable.");
}
const verifyRole = (s: BrokerSession, number: string, role: AccountRole) =>
  role === "long_term" ? verifyLongTerm(s, number) : verifyTrading(s, number);
export async function readSnapshot(
  s: BrokerSession,
  number: string,
  symbols: string[] = [],
): Promise<Row> {
  const started = performance.now();
  const [portfolio, market, orders] = await Promise.all([
    s.call("get_portfolio", { account_number: number }),
    (async () => {
      const positions = await s.rows(
          "get_equity_positions",
          number,
          "positions",
        ),
        wanted = [...new Set([...symbols, ...positions.map((p) => p.symbol)])],
        quotes: Row = {};
      // Quotes need holdings, but need not wait for portfolio/order history.
      // Two small batches at a time bound broker load for larger accounts.
      for (let i = 0; i < wanted.length; i += 40) {
        const batches = [
          wanted.slice(i, i + 20),
          wanted.slice(i + 20, i + 40),
        ].filter((batch) => batch.length);
        const responses = await Promise.all(
          batches.map((symbols) => s.call("get_equity_quotes", { symbols })),
        );
        for (const response of responses) {
          if (!Array.isArray(response.results))
            throw new Error(
              "Robinhood get_equity_quotes returned an invalid quote list.",
            );
          for (const result of response.results) {
            if (!result?.quote) continue;
            const symbol = result.quote.symbol ?? result.symbol;
            if (!symbol) throw new Error("Broker quote has no symbol.");
            quotes[symbol] = result.quote;
          }
        }
      }
      return { positions, quotes };
    })(),
    s.rows("get_equity_orders", number, "orders"),
  ]);
  return {
    portfolio,
    positions: market.positions,
    orders,
    quotes: market.quotes,
    fetch_duration_ms: Math.round(performance.now() - started),
    account_number: number,
    updated_at: new Date().toISOString(),
  };
}
export const snapshot = (
  number: string,
  symbols: string[] = [],
  broker: typeof connected = connected,
) =>
  broker(async (s) => {
    await verifyTrading(s, number);
    return readSnapshot(s, number, symbols);
  });
export async function syncHoldings(): Promise<Row> {
  const number = roles().long_term;
  if (!number) throw new Error("Select the long-term Robinhood account first.");
  let historyAvailable = true;
  const { positions, orders } = await connected(async (s) => {
    const available = (await s.call("get_accounts", {})).accounts;
    if (!available.some((a: Row) => a.account_number === number && eligible(a)))
      throw new Error("Saved long-term account is unavailable.");
    const [positions, orders] = await Promise.all([
      s.rows("get_equity_positions", number, "positions"),
      s.rows("get_equity_orders", number, "orders").catch(() => {
        historyAvailable = false;
        return [];
      }),
    ]);
    return { positions, orders };
  });
  let omitted = 0;
  const quantities = new Map<string, number>();
  for (const p of positions) {
    const symbol = String(p.symbol ?? "")
        .toUpperCase()
        .replaceAll(".", "-"),
      quantity = Number(p.quantity);
    if (
      !/^[A-Z][A-Z0-9-]{0,14}$/.test(symbol) ||
      !Number.isFinite(quantity) ||
      quantity < 0
    ) {
      omitted++;
      continue;
    }
    if (quantity > 0)
      quantities.set(symbol, (quantities.get(symbol) ?? 0) + quantity);
  }
  if (roles().long_term !== number)
    throw new Error("Long-term account changed during sync.");
  recordLearningOrders(
    {
      market: "US",
      horizon: "long_term",
      broker: "robinhood",
      scope: learningScope(number),
    },
    orders,
  );
  store.saveCsv(
    holdingsPath(),
    [...quantities].map(([symbol, quantity]) => ({ symbol, quantity })),
  );
  return {
    count: quantities.size,
    omitted,
    order_history_available: historyAvailable,
    ...(historyAvailable
      ? {}
      : {
          message:
            "Holdings synced; broker order history was unavailable to the learning journal.",
        }),
  };
}
export const ticketsFile = join(US, "live_order_tickets.json");
export const tickets = (): Record<string, Row> => store.json(ticketsFile, {});
export function saveTicket(ticket: Row): void {
  store.save(ticketsFile, { ...tickets(), [ticket.id]: ticket });
  if (
    ticket.result?.order &&
    typeof ticket.arguments?.account_number === "string"
  )
    recordLearningOrders(
      {
        market: "US",
        horizon: ticket.role === "long_term" ? "long_term" : "trading",
        broker: "robinhood",
        scope: learningScope(ticket.arguments.account_number),
      },
      [{ ...ticket.arguments, ...ticket.result.order }],
      [ticket],
    );
}
export const listTickets = (number?: string | null, role: AccountRole = "trading") =>
  Object.values(tickets())
    .filter((t) => t.arguments.account_number === number && (t.role ?? "trading") === role)
    .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at));
export function positiveDecimal(raw: unknown, places = 6): string {
  let d: Decimal;
  try {
    d = new Decimal(String(raw));
  } catch {
    throw new Error("Enter a positive order amount.");
  }
  const match = String(raw)
    .trim()
    .match(/^\+?\d*\.?(\d*)(?:[eE]([+-]?\d+))?$/);
  const fractional = match
    ? (String(raw).trim().split(/[eE]/)[0].split(".")[1]?.length ?? 0) -
      Number(match[2] ?? 0)
    : d.decimalPlaces();
  if (!d.isFinite() || d.lte(0) || fractional > places)
    throw new Error(
      `Order amounts must be positive with at most ${places} decimal places.`,
    );
  return d.toFixed(Math.max(0, fractional));
}
function dollarBuyAmount(raw: unknown): string {
  const amount = positiveDecimal(raw, 2);
  if (new Decimal(amount).lt(MIN_DOLLAR_BUY))
    throw new TradeDecisionChanged(
      "Buy amount is below Robinhood's $1 minimum; keeping the remainder in cash.",
    );
  return amount;
}
function validateBuyAmount(args: Row): void {
  if (args.side === "buy") dollarBuyAmount(args.dollar_amount);
}
export function argumentsFor(number: string, a: Row): Row {
  if (
    !a.enabled ||
    !["BUY", "EXIT"].includes(a.action) ||
    !/^[A-Z][A-Z0-9.-]{0,14}$/.test(a.symbol)
  )
    throw new Error("This strategy action is no longer eligible.");
  requireTrading(number);
  return {
    account_number: number,
    symbol: a.symbol,
    side: a.side,
    type: "market",
    time_in_force: "gfd",
    market_hours: "regular_hours",
    ...(a.side === "buy"
      ? { dollar_amount: dollarBuyAmount(a.dollar_amount) }
      : { quantity: positiveDecimal(a.quantity) }),
  };
}
async function sellCheck(s: BrokerSession, args: Row) {
  if (args.side === "sell") {
    const quantity = positiveDecimal(args.quantity);
    const held = (
      await s.rows("get_equity_positions", args.account_number, "positions")
    )
      .filter((p) => p.symbol === args.symbol)
      .reduce<Decimal>((n, p) => {
        const raw = p.shares_available_for_sells ?? p.quantity;
        let available: Decimal;
        try {
          if (typeof raw !== "string" && typeof raw !== "number")
            throw new Error();
          available = new Decimal(raw);
          if (!available.isFinite() || available.isNegative())
            throw new Error();
        } catch {
          throw new Error(
            "Broker sellable quantity is unavailable or invalid.",
          );
        }
        return n.plus(available);
      }, new Decimal(0));
    if (new Decimal(quantity).gt(held))
      throw new Error("Sell quantity exceeds available holdings.");
  }
}
export async function review(
  args: Row,
  broker: typeof connected = connected,
  role: AccountRole = "trading",
): Promise<Row> {
  validateBuyAmount(args);
  const data = await broker(async (s) => {
    await verifyRole(s, args.account_number, role);
    await sellCheck(s, args);
    return s.call("review_equity_order", args);
  });
  if (
    data.symbol !== args.symbol ||
    data.side !== args.side ||
    data.type !== args.type
  )
    throw new Error("Broker preview does not match the order.");
  return data;
}
export async function preview(
  args: Row,
  broker: typeof connected = connected,
  role: AccountRole = "trading",
): Promise<Row> {
  const data = await review(args, broker, role);
  const ticket = {
    id: randomUUID(),
    role,
    arguments: args,
    preview: data,
    reviewed_at: new Date().toISOString(),
    status: "preview",
  };
  saveTicket(ticket);
  return ticket;
}
export const previewCurrent = (ticket: Row, now = Date.now()) =>
  ticket.status === "preview" &&
  now - Date.parse(ticket.reviewed_at) >= 0 &&
  now - Date.parse(ticket.reviewed_at) <= 120000;
export async function submit(
  id: string,
  acknowledged: boolean,
  validate: (ticket: Row, s: BrokerSession) => Promise<void>,
  consent: () => void,
  broker: typeof connected = connected,
  role: AccountRole = "trading",
): Promise<Row> {
  return submitLock.run(async () => {
    if (acknowledged !== true)
      throw new Error("Explicit confirmation is required.");
    const all = tickets(),
      ticket = all[id];
    if (!ticket || ticket.status !== "preview")
      throw new Error("Order preview expired or was already submitted.");
    if ((ticket.role ?? "trading") !== role)
      throw new Error("Order belongs to a different account role.");
    if (!previewCurrent(ticket))
      throw new TradeDecisionChanged(
        "Order preview expired. Review a fresh order.",
      );
    if (
      Object.values(all).some(
        (t) =>
          t.id !== id &&
          t.arguments.account_number === ticket.arguments.account_number &&
          ["submitting", "unknown"].includes(t.status),
      )
    )
      throw new Error(
        "Another order has unresolved status. Check Robinhood before trading.",
      );
    consent();
    ticket.status = "submitting";
    saveTicket(ticket);
    let placement = false;
    try {
      validateBuyAmount(ticket.arguments);
      await broker(async (s) => {
        await verifyRole(s, ticket.arguments.account_number, role);
        await sellCheck(s, ticket.arguments);
        await validate(ticket, s);
        // Revalidation can shrink a previously valid preview.
        validateBuyAmount(ticket.arguments);
        const age = Date.now() - Date.parse(ticket.reviewed_at);
        if (age < 0 || age > 120000)
          throw new TradeDecisionChanged("Preview expired while connecting.");
        consent();
        ticket.submitted_at = new Date().toISOString();
        saveTicket(ticket);
        placement = true;
        const result = await s.call("place_equity_order", {
          ...ticket.arguments,
          ref_id: id,
        });
        if (typeof result?.order?.id !== "string" || !result.order.id.trim())
          throw new Error(
            "Broker returned no order ID. Check broker order status before trading.",
          );
        // Keep the receipt even if persisting or closing the broker session fails.
        ticket.status = "submitted";
        ticket.result = result;
        saveTicket(ticket);
      });
    } catch (error) {
      // An MCP error after sending is not proof that the broker rejected it.
      if (ticket.status !== "submitted")
        ticket.status = placement ? "unknown" : "not_submitted";
      ticket.error = errorMessage(error);
      if (!placement && error instanceof TradeDecisionChanged)
        ticket.decision_changed = true;
      saveTicket(ticket);
    }
    return ticket;
  });
}
export async function reconcile(
  id: string,
  broker: typeof connected = connected,
): Promise<Row> {
  const ticket = tickets()[id];
  if (!ticket) throw new Error("Order ticket not found.");
  const orders = await broker((s) =>
    s.rows("get_equity_orders", ticket.arguments.account_number, "orders"),
  );
  return reconcileFromOrders(ticket, orders);
}
/** Reconcile saved receipts against an already-fetched snapshot; never submits. */
export function reconcileFromOrders(ticket: Row, orders: Row[]): Row {
  const brokerId = ticket.result?.order?.id;
  const match = orders.find(
    (o) => o.ref_id === ticket.id || (brokerId && o.id === brokerId),
  );
  if (
    match &&
    (ticket.status !== "submitted" ||
      ticket.error ||
      JSON.stringify(ticket.result?.order) !== JSON.stringify(match))
  ) {
    ticket.status = "submitted";
    ticket.result = { order: match };
    delete ticket.error;
    saveTicket(ticket);
  }
  return ticket;
}

/** Suggestions require explicit confirmation; similar trades are not identities. */
export function recoveryOrders(ticket: Row, orders: Row[], all: Row[]): Row[] {
  if (!["unknown", "submitting"].includes(ticket.status)) return [];
  const args = ticket.arguments;
  if (!["buy", "sell"].includes(args.side) || args.type !== "market") return [];
  const start = Date.parse(ticket.submitted_at ?? ticket.reviewed_at);
  // Legacy tickets lack a send time: include the two-minute preview lifetime.
  const window = ticket.submitted_at ? 90000 : 210000;
  const amountKey = args.side === "sell" ? "quantity" : "dollar_amount";
  return orders.filter((order) => {
    const elapsed = Date.parse(order.created_at) - start;
    if (
      typeof order.id !== "string" ||
      !order.id ||
      order.state !== "filled" ||
      (ticket.result?.order?.id && ticket.result.order.id !== order.id) ||
      order.symbol !== args.symbol ||
      order.side !== args.side ||
      order.type !== args.type ||
      (order.account_number && order.account_number !== args.account_number) ||
      !(elapsed >= 0 && elapsed <= window) ||
      all.some(
        (other) =>
          other.id !== ticket.id &&
          (other.result?.order?.id === order.id || other.id === order.ref_id),
      )
    )
      return false;
    try {
      const amount = new Decimal(args[amountKey]);
      return (
        amount.isFinite() &&
        amount.gt(0) &&
        amount.eq(new Decimal(order[amountKey]))
      );
    } catch {
      return false;
    }
  });
}

export function linkOrder(
  id: string,
  orderId: string,
  acknowledged: boolean,
  broker: typeof connected = connected,
): Promise<Row> {
  return submitLock.run(async () => {
    if (acknowledged !== true)
      throw new Error("Confirm the matching broker receipt first.");
    const ticket = tickets()[id];
    if (!ticket) throw new Error("Order ticket not found.");
    requireTrading(ticket.arguments.account_number);
    return broker(async (s) => {
      await verifyTrading(s, ticket.arguments.account_number);
      const orders = await s.rows(
        "get_equity_orders",
        ticket.arguments.account_number,
        "orders",
      );
      const all = tickets();
      const current = all[id];
      if (
        !current ||
        current.status !== ticket.status ||
        JSON.stringify(current.arguments) !== JSON.stringify(ticket.arguments)
      )
        throw new Error(
          "Order ticket changed; check broker order status again.",
        );
      requireTrading(current.arguments.account_number);
      const order = recoveryOrders(current, orders, Object.values(all)).find(
        (o) => o.id === orderId,
      );
      if (!order)
        throw new Error(
          "Receipt no longer matches this unresolved order or is already linked.",
        );
      current.reconciliation = {
        method: "user_confirmed_receipt",
        confirmed_at: new Date().toISOString(),
        previous_error: current.error,
        broker_order_id: orderId,
      };
      current.result = { order: { id: orderId } };
      return reconcileFromOrders(current, [order]);
    });
  });
}
export const oauthConnected = () => existsSync(oauthFile);

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  store,
  INDIA,
  Mutex,
  errorMessage,
  type Row,
} from "../shared/storage.js";
import { localDay } from "../shared/calendar.js";
import { history, concurrent } from "../shared/prices.js";
import { recordLearningOrders, learningScope } from "../learning.js";
export const tokenFile = join(INDIA, "kite_access_token.json"),
  journal = join(INDIA, "kite_rebalances.json");
export class KiteError extends Error {}
export function tokenCurrent(now = Date.now()): boolean {
  try {
    const token = store.json<Row>(tokenFile, {}),
      day = localDay(now, "NSE"),
      hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(now),
      ),
      valid =
        hour >= 6
          ? day
          : new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
    return !!token.access_token && token.date >= valid;
  } catch {
    return false;
  }
}
export const login = (redirectParams?: Record<string, string>) => {
  const url = new URL("https://kite.zerodha.com/connect/login");
  url.searchParams.set("v", "3");
  url.searchParams.set("api_key", store.setting("KITE_API_KEY"));
  if (redirectParams)
    url.searchParams.set(
      "redirect_params",
      new URLSearchParams(redirectParams).toString(),
    );
  return url.toString();
};
export async function connect(value: string): Promise<Row> {
  return submitLock.run(async () => {
    const token = value.includes("request_token=")
      ? new URL(value).searchParams.get("request_token")
      : value.trim();
    if (!token)
      throw new Error("Paste the one-time Kite request token or redirect URL.");
    const api_key = store.setting("KITE_API_KEY"),
      checksum = createHash("sha256")
        .update(api_key + token + store.setting("KITE_API_SECRET"))
        .digest("hex"),
      data = await request(
        "/session/token",
        "POST",
        { api_key, request_token: token, checksum },
        false,
      );
    if (!data.access_token) throw new Error("Kite returned no access token.");
    store.save(tokenFile, {
      date: localDay(Date.now(), "NSE"),
      access_token: data.access_token,
    });
    return { connected: true };
  });
}
export async function request(
  path: string,
  method = "GET",
  body?: Row | Row[],
  authenticated = true,
): Promise<any> {
  const apiKey = store.setting("KITE_API_KEY"),
    headers: Record<string, string> = { "X-Kite-Version": "3" };
  if (authenticated) {
    if (!tokenCurrent())
      throw new Error(
        "Connect Kite to renew today’s session in Account settings.",
      );
    headers.Authorization = `token ${apiKey}:${store.json<Row>(tokenFile, {}).access_token}`;
  }
  const json = Array.isArray(body);
  if (body)
    headers["Content-Type"] = json
      ? "application/json"
      : "application/x-www-form-urlencoded";
  const response = await fetch("https://api.kite.trade" + path, {
    method,
    headers,
    body: body
      ? json
        ? JSON.stringify(body)
        : new URLSearchParams(
            Object.entries(body).map(([k, v]) => [k, String(v)]),
          ).toString()
      : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const payload = (await response.json()) as Row;
  if (!response.ok || payload.status === "error")
    throw new KiteError(
      `Kite ${payload.error_type ?? "request"}: ${payload.message ?? "request failed"}`,
    );
  return payload.data;
}
export async function state(): Promise<Row> {
  const [profile, holdings, orders, margins] = await Promise.all([
    request("/user/profile"),
    request("/portfolio/holdings"),
    request("/orders"),
    request("/user/margins/equity"),
  ]);
  if (!Number.isFinite(Number(margins.net)))
    throw new Error("Kite equity funds are unavailable.");
  recordLearningOrders(
    {
      market: "India",
      horizon: "long_term",
      broker: "kite",
      scope: learningScope("kite:" + profile.user_id),
    },
    orders,
  );
  return {
    user: profile.user_id,
    holdings,
    orders,
    funds: Number(margins.net),
  };
}
export function whole(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Enter non-negative whole-share quantities.");
  return n;
}
export function holdingMap(s: Row): Map<string, number> {
  const held = new Map<string, number>();
  for (const h of s.holdings) {
    const key = h.exchange + ":" + h.tradingsymbol;
    held.set(
      key,
      (held.get(key) ?? 0) +
        Math.max(0, whole(h.quantity ?? 0) - whole(h.used_quantity ?? 0)),
    );
  }
  return held;
}
export function editorRows(view: Row[], s: Row): Row[] {
  const held = holdingMap(s);
  return view.map((r) => {
    const current = held.get(r.exchange + ":" + r.symbol) ?? 0,
      target = r.target_shares == null ? current : whole(r.target_shares);
    return {
      symbol: r.symbol,
      exchange: r.exchange,
      status: current === 0 ? "New" : r.status,
      current_shares: current,
      target_shares: target,
      sell_shares: Math.max(0, current - target),
      buy_shares: Math.max(0, target - current),
    };
  });
}
export function ordersFromEditor(edited: Row[], original: Row[]): Row[] {
  const allowed = new Set(original.map((r) => r.exchange + ":" + r.symbol)),
    seen = new Set<string>(),
    orders: Row[] = [];
  for (const row of edited) {
    const key = row.exchange + ":" + row.symbol;
    if (
      !allowed.has(key) ||
      seen.has(key) ||
      !["NSE", "BSE"].includes(row.exchange) ||
      !/^[A-Z0-9&.\-]+$/.test(row.symbol)
    )
      throw new Error("Stock list changed or duplicated. Reopen the plan.");
    seen.add(key);
    const sell = whole(row.sell_shares),
      buy = whole(row.buy_shares);
    if (sell && buy)
      throw new Error("Cannot buy and sell the same stock in one rebalance.");
    if (sell || buy)
      orders.push({
        exchange: row.exchange,
        tradingsymbol: row.symbol,
        transaction_type: sell ? "SELL" : "BUY",
        quantity: sell || buy,
        product: "CNC",
        order_type: "MARKET",
        validity: "DAY",
      });
  }
  if (seen.size !== allowed.size || !orders.length)
    throw new Error(
      "Keep the complete stock list and enter at least one order.",
    );
  return orders.sort(
    (a, b) =>
      Number(a.transaction_type !== "SELL") -
        Number(b.transaction_type !== "SELL") ||
      a.tradingsymbol.localeCompare(b.tradingsymbol),
  );
}
const terminal = new Set(["COMPLETE", "REJECTED", "CANCELLED"]);
export function validateHoldings(orders: Row[], s: Row): void {
  const held = holdingMap(s);
  for (const o of orders) {
    if (
      s.orders.some(
        (b: Row) =>
          b.exchange === o.exchange &&
          b.tradingsymbol === o.tradingsymbol &&
          !terminal.has(b.status),
      )
    )
      throw new Error(`An order is already pending for ${o.tradingsymbol}.`);
    if (
      o.transaction_type === "SELL" &&
      o.quantity > (held.get(o.exchange + ":" + o.tradingsymbol) ?? 0)
    )
      throw new Error(
        `Sell quantity for ${o.tradingsymbol} exceeds settled holdings.`,
      );
  }
}
export async function quotes(keys: string[]): Promise<Row> {
  const entries = await concurrent([...new Set(keys)], 4, async (key) => {
    const [exchange, symbol] = key.split(":"),
      h = await history(
        symbol + (exchange === "BSE" ? ".BO" : ".NS"),
        "5d",
        "1m",
        false,
      ),
      last = h.bars.at(-1)!,
      age = Date.now() - last.time;
    if (age < 0 || age > 7 * 86400000)
      throw new Error(`Quote is outdated for ${key}.`);
    return [
      key,
      {
        last_price: last.close,
        quoted_at: new Date(last.time).toISOString(),
        source: h.source,
      },
    ];
  });
  return Object.fromEntries(entries);
}
export async function buyMargin(orders: Row[]): Promise<number> {
  const buys = orders
    .filter((o) => o.transaction_type === "BUY")
    .map((o) => ({ ...o, variety: "regular" }));
  if (!buys.length) return 0;
  const response: Row[] = await request("/margins/orders", "POST", buys);
  if (response.length !== buys.length)
    throw new Error("Kite margin estimate is incomplete.");
  return response.reduce((n, r) => {
    const total = Number(r.total),
      charges = Number(r.charges?.total ?? 0);
    if (
      !Number.isFinite(total) ||
      total < 0 ||
      !Number.isFinite(charges) ||
      charges < 0
    )
      throw new Error("Invalid margin estimate.");
    return n + total + charges;
  }, 0);
}
export const batches = (): Record<string, Row> => store.json(journal, {});
const save = (batch: Row) =>
  store.save(journal, { ...batches(), [batch.id]: batch });
export async function review(edited: Row[], original: Row[]): Promise<Row> {
  const orders = ordersFromEditor(edited, original),
    account = await state();
  validateHoldings(orders, account);
  const prices = await quotes(
    orders.map((o) => o.exchange + ":" + o.tradingsymbol),
  );
  let sells = 0,
    buys = 0;
  for (const o of orders) {
    const v =
      prices[o.exchange + ":" + o.tradingsymbol].last_price * o.quantity;
    if (o.transaction_type === "SELL") sells += v;
    else buys += v;
  }
  const margin = await buyMargin(orders);
  if (margin > account.funds + sells * 0.99)
    throw new Error("Edited buys exceed funds plus estimated sale proceeds.");
  const batch = {
    id: randomUUID().replaceAll("-", ""),
    user: account.user,
    orders,
    status: "review",
    results: [],
    reviewed_at: new Date().toISOString(),
    estimated_buys: buys,
    estimated_sells: sells,
    required_buy_margin: margin,
    available_funds: account.funds,
    price_source: [
      ...new Set(
        Object.values(prices as Record<string, Row>).map((q) => q.source),
      ),
    ].join(", "),
    quotes: prices,
  };
  save(batch);
  return batch;
}
const submitLock = new Mutex();
export async function submit(id: string, acknowledged: boolean): Promise<Row> {
  return submitLock.run(async () => {
    if (acknowledged !== true)
      throw new Error("Confirm the edited rebalance first.");
    const all = batches(),
      batch = all[id];
    if (!batch || batch.status !== "review")
      throw new Error("Rebalance missing or already confirmed.");
    const age = Date.now() - Date.parse(batch.reviewed_at);
    if (age < 0 || age > 120000) throw new Error("Rebalance review expired.");
    if (
      Object.values(all).some(
        (b) =>
          b.user === batch.user && ["submitting", "unknown"].includes(b.status),
      )
    )
      throw new Error("An earlier rebalance is unresolved.");
    const account = await state();
    if (account.user !== batch.user)
      throw new Error("Connected Kite account changed.");
    validateHoldings(batch.orders, account);
    batch.status = "submitting";
    save(batch);
    for (let i = 0; i < batch.orders.length; i++) {
      const o = batch.orders[i];
      let started = false;
      try {
        if (o.transaction_type === "BUY") {
          const needed = await buyMargin(batch.orders.slice(i)),
            margins = await request("/user/margins/equity");
          if (
            !Number.isFinite(Number(margins.net)) ||
            Number(margins.net) < 0 ||
            needed > Number(margins.net)
          )
            throw new Error(
              "Fresh available funds cannot cover remaining buys.",
            );
        }
        const result: Row = {
          symbol: o.tradingsymbol,
          side: o.transaction_type,
          quantity: o.quantity,
          tag: "rb" + batch.id.slice(0, 14) + i,
          status: "submitting",
        };
        batch.results.push(result);
        save(batch);
        started = true;
        const receipt = await request("/orders/regular", "POST", {
          ...o,
          market_protection: -1,
          tag: result.tag,
        });
        if (!receipt.order_id)
          throw new Error("Kite returned no order identifier.");
        result.order_id = String(receipt.order_id);
        result.status = "submitted";
        save(batch);
        let status: string | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          const h: Row[] = await request(
            "/orders/" + encodeURIComponent(result.order_id),
          );
          status = h.at(-1)?.status;
          if (status && terminal.has(status)) break;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
        }
        result.broker_status = status ?? null;
        result.status =
          status === "COMPLETE"
            ? "filled"
            : status === "REJECTED"
              ? "rejected"
              : status === "CANCELLED"
                ? "cancelled"
                : "pending";
        if (status !== "COMPLETE") {
          batch.status = "stopped";
          batch.error =
            "Order not fully filled. Remaining orders were not sent.";
          save(batch);
          return batch;
        }
        save(batch);
      } catch (error) {
        const last = batch.results.at(-1);
        if (started && !last.order_id) {
          last.status = error instanceof KiteError ? "rejected" : "unknown";
          batch.status = error instanceof KiteError ? "stopped" : "unknown";
        } else batch.status = "stopped";
        batch.error = errorMessage(error);
        save(batch);
        return batch;
      }
    }
    batch.status = "completed";
    save(batch);
    return batch;
  });
}
export async function refreshStatus(id: string): Promise<Row> {
  const batch = batches()[id];
  if (!batch) throw new Error("Rebalance record missing.");
  if ((await request("/user/profile")).user_id !== batch.user)
    throw new Error("Connected Kite account changed.");
  const orders: Row[] = await request("/orders");
  for (const r of batch.results) {
    const match = orders.find(
      (o) => o.order_id === r.order_id || (r.tag && o.tag === r.tag),
    );
    if (match) {
      Object.assign(r, {
        order_id: match.order_id,
        broker_status: match.status,
        status:
          match.status === "COMPLETE"
            ? "filled"
            : match.status === "REJECTED"
              ? "rejected"
              : match.status === "CANCELLED"
                ? "cancelled"
                : "pending",
      });
    }
  }
  if (
    batch.status === "unknown" &&
    !batch.results.some((r: Row) => r.status === "unknown")
  )
    batch.status = "stopped";
  if (
    batch.results.length === batch.orders.length &&
    batch.results.every((r: Row) => r.status === "filled")
  )
    batch.status = "completed";
  save(batch);
  return batch;
}

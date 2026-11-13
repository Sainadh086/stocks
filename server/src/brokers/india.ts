import { join } from "node:path";
import { INDIA, store, type Row } from "../shared/storage.js";
import { amount } from "../trading/live.js";
import { localDay } from "../shared/calendar.js";
import * as kite from "./kite.js";
import { recordLearningOrders, learningScope } from "../learning.js";

export const brokerIds = ["kite", "upstox", "groww"] as const;
export type IndiaBroker = (typeof brokerIds)[number];
export const credentialsFile = join(INDIA, "trading_broker_sessions.json");
export const names = { kite: "Zerodha Kite", upstox: "Upstox", groww: "Groww" };
export interface IndiaSnapshot {
  learning_broker?: IndiaBroker;
  user: string;
  cash: number;
  positions: Row[];
  orders: Row[];
  quotes: Record<string, Row>;
  updated_at: string;
}
export class IndiaBrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const terminal = new Set(["filled", "rejected", "cancelled"]);
export function orderState(value: unknown): string {
  const state = String(value).toUpperCase();
  if (["COMPLETE", "COMPLETED", "EXECUTED", "DELIVERY_AWAITED"].includes(state))
    return "filled";
  if (["REJECTED", "FAILED"].includes(state)) return "rejected";
  if (["CANCELLED", "CANCELED"].includes(state)) return "cancelled";
  return "pending";
}
function number(value: unknown, name: string, signed = false): number {
  const n = amount(value);
  if (n == null || (!signed && n < 0))
    throw new Error(`Broker ${name} is unavailable or invalid.`);
  return n;
}
function array(value: unknown, name: string): Row[] {
  if (!Array.isArray(value))
    throw new Error(`Broker ${name} response is incomplete.`);
  return value;
}
function saved(broker: IndiaBroker): Row {
  return store.json<Row>(credentialsFile, {})[broker] ?? {};
}
export function connections(): Row[] {
  return brokerIds.map((id) => ({
    id,
    name: names[id],
    connected:
      id === "kite"
        ? kite.tokenCurrent()
        : !!saved(id).access_token &&
          saved(id).day === localDay(Date.now(), "NSE"),
    ending:
      id === "kite"
        ? null
        : saved(id).user
          ? "••••" + String(saved(id).user).slice(-4)
          : null,
  }));
}
export async function request(
  broker: IndiaBroker,
  path: string,
  method = "GET",
  body?: Row,
  token?: string,
): Promise<any> {
  if (broker === "kite") return kite.request(path, method, body);
  const credential = token ?? saved(broker).access_token;
  if (!credential)
    throw new Error(`Connect ${names[broker]} in Account settings first.`);
  const host =
    broker === "groww"
      ? "https://api.groww.in/v1"
      : path.startsWith("/v3/order/")
        ? "https://api-hft.upstox.com"
        : "https://api.upstox.com";
  const response = await fetch(host + path, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential}`,
      ...(broker === "groww" ? { "X-API-VERSION": "1.0" } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data: Row;
  try {
    data = (await response.json()) as Row;
  } catch {
    throw new IndiaBrokerError(
      `${names[broker]} returned an unreadable response.`,
      response.status,
    );
  }
  if (!response.ok || !["success", "SUCCESS"].includes(data.status)) {
    // Broker error text may echo request credentials; never expose its raw body.
    const code = String(
      data.errors?.[0]?.error_code ??
        data.error?.code ??
        data.code ??
        "request_failed",
    )
      .replaceAll(String(credential), "redacted")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 60);
    throw new IndiaBrokerError(
      `${names[broker]} request failed (${response.status}, ${code}). Check token validity, API permissions and registered static IP in the broker portal.`,
      response.status,
    );
  }
  const payload = broker === "groww" ? data.payload : data.data;
  if (payload == null)
    throw new Error(`${names[broker]} response is incomplete.`);
  return payload;
}
export async function connect(
  broker: Exclude<IndiaBroker, "kite">,
  accessToken: string,
): Promise<Row> {
  const profile = await request(
    broker,
    broker === "groww" ? "/user/detail" : "/v2/user/profile",
    "GET",
    undefined,
    accessToken,
  );
  const user = broker === "groww" ? profile.ucc : profile.user_id;
  if (typeof user !== "string" || !user.trim())
    throw new Error("Broker returned no account identity.");
  store.save(credentialsFile, {
    ...store.json<Row>(credentialsFile, {}),
    [broker]: {
      access_token: accessToken,
      user,
      day: localDay(Date.now(), "NSE"),
    },
  });
  return { connected: true, ending: "••••" + user.slice(-4) };
}
const instruments = new Map<string, { day: string; key: string }>();
export async function instrument(symbol: string): Promise<string> {
  const day = localDay(Date.now(), "NSE"),
    cached = instruments.get(symbol);
  if (cached?.day === day) return cached.key;
  const rows = array(
    await request(
      "upstox",
      "/v2/instruments/search?" +
        new URLSearchParams({
          query: symbol,
          exchanges: "NSE",
          segments: "EQ",
          records: "30",
          instrument_types: "EQ",
        }),
    ),
    "instruments",
  );
  const matches = rows.filter(
    (r) =>
      r.trading_symbol === symbol &&
      r.segment === "NSE_EQ" &&
      r.instrument_type === "EQ" &&
      Number(r.lot_size) === 1 &&
      /^NSE_EQ\|[A-Z0-9]+$/.test(r.instrument_key),
  );
  if (matches.length !== 1)
    throw new Error(`No unique NSE equity instrument for ${symbol}.`);
  instruments.set(symbol, { day, key: matches[0].instrument_key });
  return matches[0].instrument_key;
}
function normalizeOrder(broker: IndiaBroker, r: Row): Row {
  const id = broker === "groww" ? r.groww_order_id : r.order_id;
  if (typeof id !== "string" || !id)
    throw new Error("Broker returned an order without an identity.");
  return {
    id,
    reference: r.order_reference_id ?? r.tag,
    symbol: r.trading_symbol ?? r.tradingsymbol,
    side: String(r.transaction_type).toLowerCase(),
    quantity: number(r.quantity, "order quantity"),
    filled_quantity: number(r.filled_quantity ?? 0, "filled quantity"),
    average_price: amount(
      r.average_price ?? r.average_traded_price ?? r.filled_avg_price,
    ),
    order_timestamp: r.order_timestamp ?? r.created_at ?? r.created_time,
    exchange_update_timestamp:
      r.exchange_update_timestamp ?? r.exchange_timestamp ?? r.updated_at,
    state: orderState(r.order_status ?? r.status),
    exchange: r.exchange,
    intraday: r.product === (broker === "upstox" ? "I" : "MIS"),
  };
}
export async function snapshot(
  broker: IndiaBroker,
  wanted: string[],
): Promise<IndiaSnapshot> {
  let profile: Row, funds: Row, positions: Row[], orders: Row[];
  if (broker === "kite") {
    const result = await Promise.all([
      request(broker, "/user/profile"),
      request(broker, "/user/margins/equity"),
      request(broker, "/portfolio/positions"),
      request(broker, "/orders"),
    ]);
    [profile, funds] = result;
    positions = array(result[2].net, "positions");
    orders = array(result[3], "orders");
  } else if (broker === "upstox") {
    const result = await Promise.all([
      request(broker, "/v2/user/profile"),
      request(broker, "/v2/user/get-funds-and-margin?segment=SEC"),
      request(broker, "/v2/portfolio/short-term-positions"),
      request(broker, "/v2/order/retrieve-all"),
    ]);
    [profile, funds] = result;
    positions = array(result[2], "positions");
    orders = array(result[3], "orders");
  } else {
    const result = await Promise.all([
      request(broker, "/user/detail"),
      request(broker, "/margins/detail/user"),
      request(broker, "/positions/user?segment=CASH"),
    ]);
    [profile, funds] = result;
    positions = array(result[2].positions, "positions");
    orders = [];
    for (let page = 0; ; page++) {
      if (page >= 100)
        throw new Error("Groww order history exceeded its pagination limit.");
      const batch = array(
        (
          await request(
            broker,
            `/order/list?segment=CASH&page=${page}&page_size=100`,
          )
        ).order_list,
        "orders",
      );
      orders.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const user = broker === "groww" ? profile.ucc : profile.user_id;
  if (typeof user !== "string" || !user)
    throw new Error("Broker account identity is unavailable.");
  if (broker !== "kite" && user !== saved(broker).user)
    throw new Error(
      "Connected broker account changed. Reconnect from Account settings.",
    );
  const cash = Math.max(
    0,
    broker === "groww"
      ? Math.min(
          number(funds.clear_cash, "cash", true),
          number(
            funds.equity_margin_details?.mis_balance_available,
            "intraday buying power",
            true,
          ),
        )
      : number(
          broker === "kite" ? funds.net : funds.equity?.available_margin,
          "buying power",
          true,
        ),
  );
  positions = positions
    .filter(
      (p) =>
        p.exchange === "NSE" &&
        p.product === (broker === "upstox" ? "I" : "MIS"),
    )
    .map((p) => {
      const quantity = number(p.quantity, "position quantity", true);
      if (!Number.isSafeInteger(quantity))
        throw new Error("Broker returned fractional NSE shares.");
      return {
        symbol: p.trading_symbol ?? p.tradingsymbol,
        quantity,
        average_price: number(
          p.average_price ?? p.net_price ?? p.buy_price,
          "position cost",
          true,
        ),
        realised_pnl: number(
          p.realised_pnl ?? p.realised ?? p.realized ?? 0,
          "realized P&L",
          true,
        ),
        pnl: amount(p.pnl),
      };
    });
  const symbols = [
    ...new Set([
      ...wanted,
      ...positions.filter((p) => p.quantity !== 0).map((p) => p.symbol),
    ]),
  ];
  const quotes: Record<string, Row> = {};
  if (broker === "groww") {
    // Stay below the live-data per-minute quota with a small focused watchlist.
    for (const symbol of symbols) {
      const q = await request(
        broker,
        "/live-data/quote?" +
          new URLSearchParams({
            exchange: "NSE",
            segment: "CASH",
            trading_symbol: symbol,
          }),
      );
      quotes[symbol] = {
        last_trade_price: q.last_price,
        venue_last_trade_time: new Date(
          number(q.last_trade_time, "quote time"),
        ).toISOString(),
        bid_price: q.bid_price,
        ask_price: q.offer_price,
      };
    }
  } else if (symbols.length) {
    const keys =
      broker === "upstox"
        ? await Promise.all(symbols.map(instrument))
        : symbols.map((s) => "NSE:" + s);
    const data = await request(
      broker,
      broker === "upstox"
        ? "/v2/market-quote/quotes?instrument_key=" +
            encodeURIComponent(keys.join(","))
        : "/quote?" + keys.map((k) => "i=" + encodeURIComponent(k)).join("&"),
    );
    for (let i = 0; i < symbols.length; i++) {
      const q =
        broker === "kite"
          ? data[keys[i]]
          : Object.values(data as Record<string, Row>).find(
              (q) => q.instrument_token === keys[i],
            );
      if (!q) throw new Error(`Broker quote is missing for ${symbols[i]}.`);
      const rawTime =
        broker === "kite"
          ? q.last_trade_time
          : number(q.last_trade_time, "quote time");
      quotes[symbols[i]] = {
        last_trade_price: q.last_price,
        venue_last_trade_time:
          broker === "kite"
            ? new Date(
                /[Z+]/.test(rawTime) ? rawTime : rawTime + "+05:30",
              ).toISOString()
            : new Date(rawTime).toISOString(),
        bid_price: q.depth?.buy?.[0]?.price,
        ask_price: q.depth?.sell?.[0]?.price,
      };
    }
  }
  const normalizedOrders = orders.map((r) => normalizeOrder(broker, r));
  recordLearningOrders(
    {
      market: "India",
      horizon: "trading",
      broker,
      scope: learningScope(broker + ":" + user),
    },
    normalizedOrders,
  );
  return {
    user,
    learning_broker: broker,
    cash,
    positions,
    orders: normalizedOrders,
    quotes,
    updated_at: new Date().toISOString(),
  };
}
export async function place(
  broker: IndiaBroker,
  order: Row,
  reference: string,
): Promise<string> {
  let result: Row;
  const body = {
    quantity: order.quantity,
    validity: "DAY",
    order_type: "MARKET",
    transaction_type: order.side.toUpperCase(),
  };
  if (broker === "upstox")
    result = await request(broker, "/v3/order/place", "POST", {
      ...body,
      product: "I",
      price: 0,
      trigger_price: 0,
      disclosed_quantity: 0,
      instrument_token: await instrument(order.symbol),
      tag: reference,
      is_amo: false,
      slice: false,
      market_protection: -1,
    });
  else if (broker === "groww")
    result = await request(broker, "/order/create", "POST", {
      ...body,
      exchange: "NSE",
      segment: "CASH",
      product: "MIS",
      trading_symbol: order.symbol,
      order_reference_id: reference,
    });
  else
    result = await request(broker, "/orders/regular", "POST", {
      ...body,
      exchange: "NSE",
      product: "MIS",
      tradingsymbol: order.symbol,
      tag: reference,
      market_protection: -1,
    });
  const id =
    broker === "upstox"
      ? result.order_ids?.length === 1
        ? result.order_ids[0]
        : null
      : broker === "groww"
        ? result.groww_order_id
        : result.order_id;
  if (typeof id !== "string" || !id)
    throw new Error(
      "Broker returned no unique order ID. Reconcile before trading again.",
    );
  return id;
}
export async function cancel(broker: IndiaBroker, id: string): Promise<void> {
  if (broker === "upstox")
    await request(
      broker,
      "/v3/order/cancel?order_id=" + encodeURIComponent(id),
      "DELETE",
    );
  else if (broker === "groww")
    await request(broker, "/order/cancel", "POST", {
      segment: "CASH",
      groww_order_id: id,
    });
  else
    await request(
      broker,
      "/orders/regular/" + encodeURIComponent(id),
      "DELETE",
    );
}

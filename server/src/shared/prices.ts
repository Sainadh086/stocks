import YahooFinance from "yahoo-finance2";
import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { localDay } from "./calendar.js";
export interface Bar {
  kind?: "quote";
  time: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface History {
  bars: Bar[];
  latest_quote?: Bar;
  source: string;
  adjustment: string;
}
export const yahoo = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false },
});
export const daysFor = (period: string) =>
  ({
    "1m": 31,
    "3m": 93,
    "6m": 186,
    "1y": 366,
    "2y": 732,
    "60d": 60,
    "1d": 1,
    "5d": 5,
  })[period] ?? 732;
export function validBars(bars: Bar[], intervalMs?: number): Bar[] {
  const seen = new Map<number, Bar>();
  for (const b of bars) {
    if (
      (intervalMs === undefined || b.time % intervalMs === 0) &&
      [b.time, b.open, b.high, b.low, b.close, b.volume].every(
        Number.isFinite,
      ) &&
      Math.min(b.open, b.high, b.low, b.close) > 0 &&
      b.volume >= 0 &&
      b.high >= Math.max(b.open, b.close, b.low) &&
      b.low <= Math.min(b.open, b.close, b.high)
    )
      seen.set(b.time, b);
  }
  const result = [...seen.values()].sort((a, b) => a.time - b.time);
  if (!result.length) throw new Error("No valid OHLCV history.");
  return result;
}
const mappings: Record<string, string> = {
  "^GSPC": "SP:SPX",
  "^NDX": "NASDAQ:NDX",
  "^DJI": "DJ:DJI",
  "^RUT": "TVC:RUT",
  "^NSEI": "NSE:NIFTY",
  "^NSEBANK": "NSE:BANKNIFTY",
  "^BSESN": "BSE:SENSEX",
};
export const tvSymbols = (symbol: string) =>
  symbol.includes(":")
    ? [symbol]
    : mappings[symbol]
      ? [mappings[symbol]]
      : symbol.endsWith(".NS")
        ? ["NSE:" + symbol.slice(0, -3)]
        : symbol.endsWith(".BO")
          ? ["BSE:" + symbol.slice(0, -3)]
          : ["NASDAQ", "NYSE", "AMEX"].map(
              (e) => e + ":" + symbol.replaceAll("-", "."),
            );
export function decodeFrames(buffer: Buffer): {
  messages: string[];
  pending: Buffer;
} {
  const messages: string[] = [];
  while (buffer.subarray(0, 3).toString() === "~m~") {
    const index = buffer.indexOf("~m~", 3);
    if (index < 0) break;
    const size = Number(buffer.subarray(3, index).toString());
    if (!Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024)
      throw new Error("Invalid TradingView frame.");
    if (buffer.length < index + 3 + size) break;
    messages.push(
      buffer.subarray(index + 3, index + 3 + size).toString("utf8"),
    );
    buffer = buffer.subarray(index + 3 + size);
  }
  return { messages, pending: buffer };
}
function tradingView(
  symbol: string,
  interval: string,
  count: number,
): Promise<Bar[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://data.tradingview.com/socket.io/websocket", {
        origin: "https://www.tradingview.com",
        maxPayload: 4 * 1024 * 1024,
        handshakeTimeout: 8000,
      }),
      id = "cs_" + randomBytes(6).toString("hex");
    let buffer: Buffer = Buffer.alloc(0);
    const series: Bar[] = [];
    const timer = setTimeout(
      () => finish(new Error("TradingView request timed out.")),
      12000,
    );
    let finished = false;
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else {
        try {
          resolve(validBars(series));
        } catch (e) {
          reject(e);
        }
      }
    }
    const send = (m: string, p: unknown[]) => {
      const msg = JSON.stringify({ m, p });
      ws.send(`~m~${Buffer.byteLength(msg)}~m~${msg}`);
    };
    ws.on("open", () => {
      send("set_auth_token", ["unauthorized_user_token"]);
      send("chart_create_session", [id, ""]);
      send("resolve_symbol", [
        id,
        "symbol_1",
        "=" +
          JSON.stringify({ symbol, adjustment: "splits", session: "regular" }),
      ]);
      send("create_series", [
        id,
        "s1",
        "s1",
        "symbol_1",
        interval === "1d" ? "1D" : interval.replace("m", ""),
        count,
      ]);
    });
    ws.on("message", (raw) => {
      buffer = Buffer.concat([
        buffer,
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      ]);
      let messages: string[];
      try {
        const decoded = decodeFrames(buffer);
        buffer = decoded.pending;
        messages = decoded.messages;
      } catch (error) {
        finish(error as Error);
        return;
      }
      for (const body of messages) {
        if (body.startsWith("~h~")) {
          ws.send(`~m~${Buffer.byteLength(body)}~m~${body}`);
          continue;
        }
        try {
          const msg = JSON.parse(body);
          if (["timescale_update", "du"].includes(msg.m)) {
            for (const s of msg.p?.[1]?.s1?.s ?? []) {
              const v = s.v;
              const time = Number(v[0]) * 1000;
              series.push({
                time,
                date: localDay(
                  time,
                  symbol.startsWith("NSE:") || symbol.startsWith("BSE:")
                    ? "NSE"
                    : "NYSE",
                ),
                open: v[1],
                high: v[2],
                low: v[3],
                close: v[4],
                // Indices have no traded share volume.
                volume: v[5] ?? 0,
              });
            }
          } else if (msg.m === "series_completed") finish();
          else if (
            [
              "symbol_error",
              "series_error",
              "critical_error",
              "protocol_error",
            ].includes(msg.m)
          )
            finish(new Error("TradingView symbol unavailable."));
        } catch {
          finish(new Error("Invalid TradingView response."));
        }
      }
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => {
      if (!finished)
        finish(
          series.length
            ? undefined
            : new Error("TradingView connection closed."),
        );
    });
  });
}
export async function history(
  symbol: string,
  period = "1y",
  interval = "1d",
  autoAdjust = true,
  now = Date.now(),
): Promise<History> {
  const start = now - daysFor(period) * 86400000;
  const exchange =
    symbol.endsWith(".NS") ||
    symbol.endsWith(".BO") ||
    symbol.startsWith("^NSE") ||
    symbol === "^BSESN" ||
    symbol.startsWith("NSE:") ||
    symbol.startsWith("BSE:")
      ? "NSE"
      : "NYSE";
  try {
    if (symbol.includes(":")) throw new Error("TradingView index symbol");
    const result = await yahoo.chart(
      symbol,
      {
        period1: new Date(start),
        period2: new Date(now),
        interval: interval as "1d",
        return: "array",
      },
      { fetchOptions: { signal: AbortSignal.timeout(12000) } },
    );
    const observations = validBars(
      result.quotes.map((q) => {
        const close = Number(q.close),
          factor = autoAdjust && q.adjclose ? Number(q.adjclose) / close : 1,
          time = q.date.getTime();
        return {
          time,
          date: localDay(time, exchange),
          open: Number(q.open) * factor,
          high: Number(q.high) * factor,
          low: Number(q.low) * factor,
          close: close * factor,
          volume: Number(q.volume),
        };
      }),
    );
    const bars =
      interval === "5m" ? validBars(observations, 300000) : observations;
    const quote =
      interval === "5m"
        ? observations.filter((b) => b.time % 300000 !== 0).at(-1)
        : undefined;
    return {
      bars,
      latest_quote: quote ? { ...quote, kind: "quote" } : undefined,
      source: "Yahoo Finance",
      adjustment: autoAdjust
        ? "splits and dividends"
        : "splits; excludes dividends",
    };
  } catch {
    for (const qualified of tvSymbols(symbol)) {
      try {
        const bars = (
          await tradingView(
            qualified,
            interval,
            interval === "1d" ? Math.min(5000, daysFor(period) + 40) : 5000,
          )
        ).filter((b) => b.time >= start && b.time <= now);
        return {
          bars: validBars(bars),
          source: "TradingView",
          adjustment: "splits; excludes dividends",
        };
      } catch {}
    }
    throw new Error(
      `${symbol}: Yahoo Finance and TradingView are unavailable.`,
    );
  }
}
export async function concurrent<T, R>(
  items: T[],
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await action(items[index]);
      }
    }),
  );
  return results;
}

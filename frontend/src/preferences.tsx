import { applyTheme } from "./themes";
import { savePreferenceCookie } from "./mobile-cache";
import { createContext, useContext, useEffect, useState } from "react";
import type { InputHTMLAttributes, ReactNode, MouseEvent } from "react";
import { useData } from "./api";
import type { Preferences, Row } from "./types";
import { Chart, Modal, Notice, Failure } from "./components";

const PreferencesContext = createContext<{
  privacy: boolean;
  provider: "yahoo" | "tradingview";
  view: "external" | "embedded";
}>({ privacy: false, provider: "yahoo", view: "embedded" });
export const usePreferences = () => useContext(PreferencesContext);
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const query = useData<Preferences>("preferences", "/preferences");
  // Keep a saved privacy choice effective while the server is loading.
  const privacy = query.data ? (query.data.privacy_mode ?? false) : true;
  useEffect(() => {
    if (!query.data) return;
    localStorage.setItem(
      "varshan-privacy",
      String(query.data.privacy_mode ?? false),
    );
    const theme = query.data.theme ?? "light";
    savePreferenceCookie(theme, query.data.privacy_mode ?? false);
    localStorage.setItem("varshan-theme", theme);
    applyTheme(theme);
  }, [query.data]);
  return (
    <PreferencesContext.Provider
      value={{
        privacy,
        provider: query.data?.chart_provider ?? "yahoo",
        view: query.data?.chart_view ?? "embedded",
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}
export function PrivateValue({ children }: { children: ReactNode }) {
  return <>{usePreferences().privacy ? "••••" : children}</>;
}
export function PrivateInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { privacy } = usePreferences();
  return (
    <input
      {...props}
      type={privacy ? "password" : props.type}
      value={privacy ? "" : props.value}
      placeholder={privacy ? "Hidden" : props.placeholder}
      disabled={privacy || props.disabled}
    />
  );
}
export function stockTargets(symbol: string, exchange?: string) {
  const ticker = /\.(NS|BO)$/.test(symbol)
    ? symbol
    : symbol + (exchange === "NSE" ? ".NS" : exchange === "BSE" ? ".BO" : "");
  const tv = ticker.endsWith(".NS")
    ? `NSE:${ticker.slice(0, -3)}`
    : ticker.endsWith(".BO")
      ? `BSE:${ticker.slice(0, -3)}`
      : exchange && ["NASDAQ", "NYSE", "AMEX"].includes(exchange)
        ? `${exchange}:${symbol}`
        : symbol;
  return {
    ticker,
    yahoo: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`,
    tradingview: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tv)}`,
  };
}
export function StockLink({
  symbol,
  exchange,
}: {
  symbol: string;
  exchange?: string;
}) {
  const prefs = usePreferences();
  const targets = stockTargets(symbol, exchange);
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (
      prefs.view !== "embedded" ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent("varshan-stock-chart", {
        detail: { ...targets, symbol },
      }),
    );
  }
  return (
    <a
      href={targets[prefs.provider]}
      target="_blank"
      rel="noreferrer"
      onClick={open}
    >
      {symbol}
    </a>
  );
}
export function StockChartWindow() {
  const [stock, setStock] = useState<
    (ReturnType<typeof stockTargets> & { symbol: string }) | null
  >(null);
  const [period, setPeriod] = useState("3m");
  const prefs = usePreferences();
  useEffect(() => {
    const open = (event: Event) => {
      setStock((event as CustomEvent).detail);
      setPeriod("3m");
    };
    window.addEventListener("varshan-stock-chart", open);
    return () => window.removeEventListener("varshan-stock-chart", open);
  }, []);
  return stock ? (
    <StockChartContent
      stock={stock}
      period={period}
      setPeriod={setPeriod}
      provider={prefs.provider}
      close={() => setStock(null)}
    />
  ) : null;
}
function StockChartContent({
  stock,
  period,
  setPeriod,
  provider,
  close,
}: {
  stock: ReturnType<typeof stockTargets> & { symbol: string };
  period: string;
  setPeriod: (p: string) => void;
  provider: "yahoo" | "tradingview";
  close: () => void;
}) {
  const data = useData<{ bars: Row[]; source: string; adjustment: string }>(
    ["stock-chart", stock.ticker, period],
    `/charts/${encodeURIComponent(stock.ticker)}?period=${period}`,
  );
  return (
    <Modal title={`${stock.symbol} · Price chart`} onClose={close}>
      <div className="actions">
        {["1m", "3m", "6m", "1y"].map((p) => (
          <button
            key={p}
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
          >
            {p.toUpperCase()}
          </button>
        ))}
        <a href={stock[provider]} target="_blank" rel="noreferrer">
          Open in {provider === "yahoo" ? "Yahoo Finance" : "TradingView"} ↗
        </a>
      </div>
      <Failure error={data.error} />
      {data.isLoading && <Notice>Loading price history…</Notice>}
      {data.data && (
        <>
          <Chart
            rows={data.data.bars}
            lines={["close"]}
            title={`${stock.symbol} price history`}
            privateData={false}
          />
          <p className="muted">
            {data.data.source} · {data.data.adjustment}
          </p>
        </>
      )}
    </Modal>
  );
}

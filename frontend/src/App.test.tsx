import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { queryClient } from "./api";
import { ConfirmDialog, Table } from "./components";
import type { Accounts, Comparison, Row } from "./types";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  LineChart: ({ data }: { data: Row[] }) => <div>{JSON.stringify(data)}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Legend: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));
class Socket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}
vi.stubGlobal("WebSocket", Socket);
let saved: Comparison | null = null;
let failComparison = false;
const calls: { path: string; body: unknown }[] = [];
beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  saved = null;
  failComparison = false;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as unknown)
        : undefined;
      calls.push({ path, body });
      let value: unknown = {};
      if (path === "/api/health") value = { status: "ok", app: "varshan" };
      if (path === "/api/bootstrap") value = { token: "test-token" };
      if (path === "/api/accounts")
        value = {
          roles: {
            long_term: {
              selected: true,
              ending: "1234",
              scope: "investing-one",
            },
            trading: { selected: true, ending: "5678" },
          },
          kite_connected: true,
          live_settings: { budget: 1000, reserve_pct: 10 },
        };
      if (path === "/api/preferences")
        value = {
          top_benchmarks: ["Nifty 50", "S&P 500"],
          catalog: [
            { name: "Nifty 50", ticker: "^NSEI", region: "India" },
            { name: "S&P 500", ticker: "^GSPC", region: "US" },
            { name: "Nasdaq-100", ticker: "^NDX", region: "US" },
          ],
        };
      if (path === "/api/indices") value = [];
      if (path.startsWith("/api/weekly/"))
        value =
          init?.method === "POST"
            ? {
                id: "no-news",
                status: "failed",
                error: "Fixture news unavailable",
                result: null,
              }
            : null;
      if (path === "/api/markets")
        value = ["IND", "US"].map((code) => ({
          code,
          name: code,
          benchmark: code === "IND" ? "Nifty 50" : "S&P 500",
          theme: "bullish",
          report: { price: 100, change_pct: 1 },
          history: [],
          phase: "Market closed",
          reflection: {
            opening: "Have a plan.",
            closing: "Review the session.",
          },
        }));
      if (path === "/api/portfolios")
        value = {
          india: {
            holdings: [
              {
                symbol: "DEMO",
                exchange: "NSE",
                shares: 10,
                price: 100,
                market_value_inr: 1000,
              },
            ],
            replacements: [],
            gems: [
              {
                symbol: "INDIAGEM",
                gems_candidate: true,
                gems_status: "RESEARCH CANDIDATE",
                scanned_at: new Date().toISOString(),
                trailing_pe: 18,
                rsi: 55,
                qualitative_review:
                  "Policy, management and vision review pending",
              },
              {
                symbol: "RISKY",
                gems_candidate: false,
                gems_status: "REJECT",
                scanned_at: new Date().toISOString(),
                gems_reasons: "Volatility too high",
              },
            ],
            history: [],
          },
          us: {
            holdings: [{ symbol: "ABC", quantity: 2 }],
            picks: [],
            gems: [
              {
                symbol: "USGEM",
                gems_candidate: true,
                gems_status: "RESEARCH CANDIDATE",
                scanned_at: new Date().toISOString(),
              },
            ],
            report: [],
            review: [],
          },
        };
      if (path.startsWith("/api/comparisons/"))
        value = path.endsWith("long_term") ? saved : null;
      if (path === "/api/comparisons") {
        if (failComparison)
          value = {
            id: "bad",
            status: "failed",
            error: "Price feed unavailable",
            result: null,
          };
        else {
          saved = {
            scope: "investing-one",
            role: "long_term",
            benchmark: "S&P 500",
            period: "1y",
            updated_at: "2026-10-10T12:00:00Z",
            sources: [{ symbol: "ABC", source: "TradingView" }],
            curve: [
              {
                date: "2026-10-01",
                "Current holdings basket": 100,
                "S&P 500": 100,
              },
              {
                date: "2026-10-09",
                "Current holdings basket": 112,
                "S&P 500": 104,
              },
            ],
          };
          value = { id: "done", status: "completed", result: saved };
        }
      }
      if (path === "/api/live")
        value = {
          snapshot: null,
          model: null,
          auto: { enabled: false },
          batch: null,
          tickets: [],
        };
      if (path === "/api/paper") value = null;
      if (path === "/api/us/gems/plan")
        value = {
          scope: "investing-one",
          budget: 10000,
          reserve_pct: 10,
          saved: false,
          picks: [],
          schedule: [],
          reviews: {},
          target_cash_usd: 10000,
          ready_initial_usd: 0,
          message: "Refresh US Gems analysis before building current targets.",
          review_policy: "Review quarterly.",
        };
      if (/\/api\/analysis\/(India|US)\/gems$/.test(path))
        value = {
          id: "gems-done",
          status: "completed",
          result: { candidates: 1 },
        };
      if (path === "/api/kite/batches") value = [];
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}
describe("workspace state and trading separation", () => {
  it("shows Gems in both markets, separates rejected stocks, and refreshes research without broker orders", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Recommendations" }));
    fireEvent.change(await screen.findByLabelText("Strategy"), {
      target: { value: "gems" },
    });
    expect(await screen.findByText("INDIAGEM")).toBeVisible();
    expect(screen.queryByText("RISKY")).not.toBeInTheDocument();
    expect(screen.getByText(/checks require evidence/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Review in Kite" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show Gems screening details" }),
    );
    expect(screen.getByText("RISKY")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh analysis" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/analysis/India/gems")).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "US long term" }));
    expect(await screen.findByText("USGEM")).toBeVisible();
    expect(screen.queryByText("INDIAGEM")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh analysis" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh analysis" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/analysis/US/gems")).toBe(true),
    );
    expect(
      calls.some((c) =>
        /\/api\/(kite\/draft|india\/plan|live\/.*confirm)/.test(c.path),
      ),
    ).toBe(false);
  });
  it("retains a completed graph and draft controls across navigation and failed refreshes", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Benchmark comparison" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare holdings" }));
    expect(
      await screen.findByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Period"), {
      target: { value: "6m" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Market learning" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Benchmark comparison" }),
    );
    expect(screen.getByLabelText("Period")).toHaveValue("6m");
    expect(
      screen.getByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).toBeVisible();
    failComparison = true;
    fireEvent.click(screen.getByRole("button", { name: "Compare holdings" }));
    expect(await screen.findByText("Price feed unavailable")).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).toBeVisible();
    expect(screen.getByText("TradingView")).toBeVisible();
  });
  it("isolates benchmark results when the portfolio selector changes", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Benchmark comparison" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare holdings" }));
    await screen.findByRole("img", {
      name: "Current holdings basket versus the selected benchmark",
    });
    fireEvent.change(screen.getByLabelText("Portfolio"), {
      target: { value: "India" },
    });
    await screen.findByText("See your portfolio in context");
    expect(
      screen.queryByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Portfolio"), {
      target: { value: "long_term" },
    });
    expect(
      await screen.findByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).toBeVisible();
  });
  it("clears the old account graph immediately when saved account roles change", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Benchmark comparison" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare holdings" }));
    await screen.findByRole("img", {
      name: "Current holdings basket versus the selected benchmark",
    });
    const current = queryClient.getQueryData<Accounts>(["accounts"])!;
    queryClient.setQueryData(["accounts"], {
      ...current,
      roles: {
        ...current.roles,
        long_term: { selected: true, ending: "9999", scope: "investing-two" },
      },
    });
    await screen.findByText("See your portfolio in context");
    expect(
      screen.queryByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).not.toBeInTheDocument();
    queryClient.setQueryData(["accounts"], current);
    expect(
      await screen.findByRole("img", {
        name: "Current holdings basket versus the selected benchmark",
      }),
    ).toBeVisible();
  });
  it("shows account settings only on request and does not enable trading on mount", async () => {
    mount();
    await screen.findByText(/Robinhood configured/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "US trading" }));
    expect(await screen.findByText("Live trading settings")).toBeVisible();
    expect(calls.some((call) => call.path === "/api/live/automation")).toBe(
      false,
    );
    expect(calls.some((call) => call.path === "/api/paper/control")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Paper trading" }));
    expect(
      screen.getByText(
        /Starting, pausing or ending it never submits brokerage orders/,
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Open account settings" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
describe("order confirmation and tables", () => {
  it("requires explicit real-order acknowledgement", () => {
    const send = vi.fn();
    render(
      <ConfirmDialog
        title="Confirm live orders"
        pending={false}
        onClose={vi.fn()}
        onConfirm={send}
      >
        <p>Sell ABC</p>
      </ConfirmDialog>,
    );
    const button = screen.getByRole("button", { name: "Confirm real orders" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("searches and sorts numerical values rather than their string representations", async () => {
    render(
      <Table
        rows={[
          { symbol: "ABC", price: 100 },
          { symbol: "XYZ", price: 20 },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Price" }));
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("XYZ");
    fireEvent.change(screen.getByLabelText("Search Holdings"), {
      target: { value: "ABC" },
    });
    await waitFor(() =>
      expect(screen.queryByText("XYZ")).not.toBeInTheDocument(),
    );
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Trading } from "./trading";

afterEach(() => vi.unstubAllGlobals());
function setup(
  automatic = false,
  eligible = true,
  automaticBatch = false,
  overrides: Record<string, unknown> = {},
) {
  const posts: string[] = [];
  const requests: { path: string; body: unknown }[] = [];
  const live: any = {
    scope: "fixture",
    snapshot: null,
    auto: { enabled: automatic },
    batch: automaticBatch
      ? { id: "auto-batch", status: "preview", automatic: true }
      : null,
    tickets: [],
    model: {
      actions: [
        {
          symbol: "DEMO",
          action: eligible ? "BUY" : "WAIT",
          enabled: eligible,
          dollar_amount: "25.00",
          reason: "Completed breakout",
        },
      ],
    },
  };
  Object.assign(live, overrides);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        posts.push(path);
        requests.push({ path, body: JSON.parse(String(init.body)) });
      }
      let data: unknown = null;
      if (path === "/api/bootstrap") data = { token: "fixture-token" };
      if (path === "/api/accounts")
        data = {
          roles: {
            trading: { selected: true, scope: "fixture", ending: "1234" },
          },
          live_settings: { budget: 100, reserve_pct: 10 },
        };
      if (path === "/api/live") data = live;
      if (path === "/api/paper")
        data = {
          status: "Running",
          budget: 100,
          reserve_pct: 10,
          cash: 100,
          realized_pnl: 0,
          positions: {},
          fills: [],
          message: "Monitoring",
          last_check: null,
          decisions: [
            {
              symbol: "PAPER",
              action: "WAIT",
              reason: "Waiting for completed breakout",
            },
          ],
        };
      if (path === "/api/live/automation") {
        live.auto = { enabled: JSON.parse(String(init?.body)).enabled };
        data = live.auto;
      }
      if (path === "/api/live/preview") {
        const symbol = JSON.parse(String(init?.body)).symbol ?? "DEMO";
        live.batch = {
          id: "batch",
          status: "preview",
          ticket_ids: ["ticket"],
          ...(symbol !== "DEMO" ? { buy_symbol: symbol } : {}),
        };
        live.tickets = [
          {
            id: "ticket",
            status: "preview",
            arguments: { symbol, side: "buy", dollar_amount: "25.00" },
          },
        ];
        data = { id: "job", status: "completed", result: live };
      }
      if (path === "/api/live/batches/batch/confirm") {
        expect(JSON.parse(String(init?.body))).toEqual({ acknowledged: true });
        live.batch.status = "completed";
        data = { id: "job", status: "completed", result: live };
      }
      if (path === "/api/live/tickets/unresolved/link") {
        expect(JSON.parse(String(init?.body))).toEqual({
          order_id: "broker-receipt",
          acknowledged: true,
        });
        live.tickets[0] = {
          ...live.tickets[0],
          status: "submitted",
          recovery_orders: [],
          result: { order: { state: "filled" } },
        };
        data = { id: "job", status: "completed", result: live };
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Trading connection="fixture" />
    </QueryClientProvider>,
  );
  return { posts, requests, client, live };
}

describe("trading review prompts", () => {
  it("requires receipt verification before resolving an unknown order and shows its broker state", async () => {
    const { posts } = setup(true, false, false, {
      tickets: [
        {
          id: "unresolved",
          status: "unknown",
          reviewed_at: "2026-10-26T18:22:40Z",
          arguments: { symbol: "TSLA", side: "sell", quantity: "0.107717" },
          recovery_orders: [
            {
              id: "broker-receipt",
              symbol: "TSLA",
              side: "sell",
              quantity: "0.107717",
              state: "filled",
              created_at: "2026-10-26T18:22:43Z",
            },
          ],
        },
      ],
    });
    const review = await screen.findByRole("button", {
      name: /Review matching fill/,
    });
    expect(posts).toEqual([]);
    fireEvent.click(review);
    const link = await screen.findByRole("button", {
      name: "Link confirmed receipt",
    });
    expect(link).toBeDisabled();
    expect(
      screen.getByText(/Automatic trading can resume/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I verified in Robinhood/ }),
    );
    fireEvent.click(link);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "Confirm matching broker receipt",
        }),
      ).toBeNull(),
    );
    expect(posts).toEqual(["/api/live/tickets/unresolved/link"]);
    expect(await screen.findByText("filled")).toBeInTheDocument();
  });
  for (const enabled of [true, false])
    it(`does not request confirmation for automatic previews with automation ${enabled ? "running" : "paused"}`, async () => {
      const { posts } = setup(enabled, true, true);
      await screen.findByText(
        "Automatic rebalance is being prepared. No order confirmation is required.",
      );
      expect(
        screen.queryByRole("button", { name: "Open confirmation" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Confirm real orders" }),
      ).toBeNull();
      expect(
        screen.queryByRole("heading", {
          name: "Buy or sell signals are ready",
        }),
      ).toBeNull();
      expect(posts).toEqual([]);
    });
  it("dismisses an existing manual confirmation when automation starts", async () => {
    const { posts, client, live } = setup();
    await screen.findByRole("button", { name: "Review broker preview" });
    fireEvent.click(
      screen.getByRole("button", { name: "Review broker preview" }),
    );
    await screen.findByRole("button", { name: "Confirm real orders" });
    act(() => {
      client.setQueryData(["live", "fixture"], {
        ...live,
        auto: { enabled: true },
      });
    });
    await screen.findByRole("button", { name: "Stop automatic trading" });
    expect(
      screen.queryByRole("button", { name: "Confirm real orders" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open confirmation" }),
    ).toBeNull();
    expect(posts).toEqual(["/api/live/preview"]);
  });
  it("does not prompt or request previews for waiting signals", async () => {
    const { posts } = setup(false, false);
    await screen.findByRole("button", { name: "Manual buy / sell" });
    expect(
      screen.getByRole("button", { name: "Manual buy / sell" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("heading", { name: "Buy or sell signals are ready" }),
    ).toBeNull();
    expect(posts).toEqual([]);
  });
  it("prompts for eligible manual trades and requires broker review and explicit confirmation before submission", async () => {
    const { posts } = setup();
    await screen.findByRole("heading", {
      name: "Buy or sell signals are ready",
    });
    expect(posts).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Review broker preview" }),
    );
    await screen.findByRole("heading", { name: /Confirm Robinhood rebalance/ });
    expect(posts).toEqual(["/api/live/preview"]);
    const confirm = screen.getByRole("button", { name: "Confirm real orders" });
    expect(confirm).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I confirm that this places real orders/,
      }),
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(posts).toEqual([
        "/api/live/preview",
        "/api/live/batches/batch/confirm",
      ]),
    );
  });
  it("leaves automatic mode under backend consent and displays paper shortlist reasons", async () => {
    const { posts } = setup(true);
    await screen.findByRole("button", { name: "Stop automatic trading" });
    expect(
      screen.queryByRole("heading", { name: "Buy or sell signals are ready" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Paper trading" }));
    await screen.findByRole("heading", { name: "Paper shortlist" });
    expect(
      screen.getByText("Waiting for completed breakout"),
    ).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});

describe("manual handoff", () => {
  it("pauses automation and opens the manual order review without submitting", async () => {
    const { posts } = setup(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Manual buy / sell" }),
    );
    await screen.findByRole("button", { name: "Confirm real orders" });
    expect(posts).toEqual(["/api/live/automation", "/api/live/preview"]);
    expect(
      screen.getByRole("button", { name: "Confirm real orders" }),
    ).toBeDisabled();
  });
  it("shows the manual review control while automation is paused", async () => {
    const { posts } = setup(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "Manual buy / sell" }),
    );
    await screen.findByRole("button", { name: "Confirm real orders" });
    expect(posts).toEqual(["/api/live/preview"]);
  });
  it("keeps the manual control visible and explains when no strategy trade qualifies", async () => {
    const { posts } = setup(false, false);
    expect(
      await screen.findByRole("button", { name: "Manual buy / sell" }),
    ).toBeDisabled();
    expect(screen.getByText(/No trades qualify now/)).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
  it("disables manual handoff while an automatic order is pending", async () => {
    const { posts } = setup(true, true, false, {
      batch: { id: "running", automatic: true, status: "waiting_buys" },
    });
    expect(
      await screen.findByRole("button", { name: "Manual buy / sell" }),
    ).toBeDisabled();
    expect(posts).toEqual([]);
  });
});

describe("live trading visibility", () => {
  it("places decision history after the other live trading cards", async () => {
    setup(false, false);
    await screen.findByRole("heading", { name: "Trading decision history" });
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.at(-1)).toBe("Trading decision history");
    expect(headings.indexOf("Order tickets")).toBeLessThan(
      headings.indexOf("Trading decision history"),
    );
    expect(
      screen.getByText("Remembers your choice across app restarts"),
    ).toBeInTheDocument();
  });

  it("shows persisted reasons for historical checks and order results", async () => {
    setup(false, false, false, {
      decision_history: [
        {
          created_at: "2026-10-16T15:00:00.000Z",
          kind: "decision",
          automatic: true,
          summary:
            "DEMO WAIT: Waiting for a completed close above the opening range.",
        },
        {
          created_at: "2026-10-16T15:05:00.000Z",
          kind: "order",
          automatic: true,
          summary: "BUY DEMO: submitted (filled)",
        },
      ],
    });
    expect(
      await screen.findByText("BUY DEMO: submitted (filled)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "DEMO WAIT: Waiting for a completed close above the opening range.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the scan progress and waiting reason when no strategy decisions exist", async () => {
    const { posts } = setup(true, false, false, {
      model: null,
      monitor: {
        stage: "Scanning stocks",
        message: "Loading opening-range history (12/100 stocks)…",
        candidates: 0,
        signal_fresh: false,
        scan: { phase: "loading_history", completed: 12, total: 100 },
        orders: [],
        total: 0,
        filled: 0,
        pending: 0,
        unsent: 0,
        rl: "RL model is not configured; opening-range allocation is active.",
      },
    });
    await screen.findByText("Scanning stocks");
    expect(
      screen.getByRole("progressbar", { name: "Stock scan progress" }),
    ).toHaveAttribute("value", "12");
    expect(screen.getByText("No stock decisions yet")).toBeInTheDocument();
    expect(screen.getByText("No orders in progress")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
  it("shows pending and unsent rebalance orders, including with the previous backend response", async () => {
    const { posts } = setup(true, false, false, {
      model: null,
      batch: {
        id: "progress",
        automatic: true,
        status: "waiting_sales",
        progress: "Waiting for SELLER to fill…",
        ticket_ids: ["sell", "buy"],
        results: [
          {
            id: "sell",
            symbol: "SELLER",
            side: "sell",
            status: "pending",
            broker_state: "queued",
          },
        ],
      },
      tickets: [
        {
          id: "sell",
          status: "submitted",
          arguments: { symbol: "SELLER", side: "sell", quantity: "4" },
        },
        {
          id: "buy",
          status: "preview",
          arguments: { symbol: "BUYER", side: "buy", dollar_amount: "200" },
        },
      ],
    });
    await screen.findByText("Waiting for SELLER to fill…");
    expect(screen.getAllByText("SELLER").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BUYER").length).toBeGreaterThan(0);
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("No stock decisions yet")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});

describe("shortlist row buys", () => {
  const model = (blocked = false) => ({
    shortlist: [{ symbol: "AAA" }, { symbol: "BBB" }],
    actions: ["AAA", "BBB"].map((symbol) => ({
      symbol,
      side: "buy",
      action: blocked ? "WAIT" : "BUY",
      enabled: !blocked,
      dollar_amount: "25.00",
      reason: blocked ? "Waiting for a current quote" : "Confirmed breakout",
    })),
  });
  it("reviews only the clicked US stock and requires explicit order confirmation", async () => {
    const f = setup(false, true, false, { model: model() });
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Buy BBB" }));
    const dialog = await screen.findByRole("dialog", {
      name: /Confirm US BUY BBB/,
    });
    expect(f.requests).toEqual([
      {
        path: "/api/live/preview",
        body: { symbol: "BBB", expected_scope: "fixture" },
      },
    ]);
    expect(
      within(dialog).getByRole("table", { name: "Selected US buy" }),
    ).toHaveTextContent("BBB");
    expect(within(dialog).queryByText("AAA")).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", {
      name: "Confirm real orders",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(f.posts).toEqual([
        "/api/live/preview",
        "/api/live/batches/batch/confirm",
      ]),
    );
  });
  it("keeps a shortlisted US buy disabled while automation is running", async () => {
    const f = setup(true, true, false, { model: model() });
    expect(
      await screen.findByRole("button", { name: "Buy BBB" }),
    ).toBeDisabled();
    expect(
      screen.getAllByText("Pause automatic trading to buy manually.").length,
    ).toBeGreaterThan(0);
    expect(f.posts).toEqual([]);
  });
  it("shows an ineligible shortlisted stock's reason and cannot submit it", async () => {
    const f = setup(false, false, false, { model: model(true) });
    const button = await screen.findByRole("button", { name: "Buy BBB" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(f.posts).toEqual([]);
  });
});

it.each(["closed", "stale"])(
  "blocks a US shortlist row buy when the monitor is %s",
  async (state) => {
    const f = setup(false, true, false, {
      monitor: {
        market_open: state !== "closed",
        signal_fresh: state !== "stale",
        watchlist: [{ symbol: "DEMO" }],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.getByRole("button", { name: "Buy DEMO" })).toBeDisabled();
    expect(f.posts).toEqual([]);
  },
);

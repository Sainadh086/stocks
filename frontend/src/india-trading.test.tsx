import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  IndiaTrading,
  IndiaBrokerConnections,
  type IndiaLive,
} from "./india-trading";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});
function setup(
  pending = false,
  connections = false,
  overrides: Partial<IndiaLive> = {},
) {
  const calls: { path: string; body: any }[] = [];
  const reads: string[] = [];
  const data: IndiaLive = {
    broker: "groww",
    brokers: [
      { id: "kite", name: "Zerodha Kite", connected: true, ending: null },
      { id: "upstox", name: "Upstox", connected: false, ending: null },
      { id: "groww", name: "Groww", connected: true, ending: "••••1234" },
    ],
    scope: "india-one",
    configured: true,
    indices: [
      "Nifty 50",
      "Nifty Next 50",
      "Nifty 100",
      "Nifty 200",
      "Nifty 500",
      "Nifty Bank",
      "Nifty IT",
    ],
    settings_revision: 0,
    settings: {
      selection_mode: "manual",
      budget: 100000,
      reserve_pct: 10,
      symbols: ["INFY", "RELIANCE"],
    },
    auto: { enabled: false },
    phase: "Market open",
    snapshot: {
      user: "••••1234",
      cash: 100000,
      positions: [],
      updated_at: new Date().toISOString(),
    },
    signals: { message: "Monitoring NSE completed breakouts", asof: null },
    actions: [
      {
        symbol: "INFY",
        side: "buy",
        quantity: 5,
        price: 1000,
        enabled: true,
        reason: "Completed breakout",
      },
    ],
    tickets: pending
      ? [
          {
            id: "uncertain",
            symbol: "INFY",
            side: "buy",
            quantity: 5,
            price: 1000,
            enabled: false,
            status: "unknown",
          },
        ]
      : [],
    history: [],
    error: null,
  };
  Object.assign(data, overrides);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === "POST") calls.push({ path, body });
      else if (path === "/api/india/trading") reads.push(path);
      let result: unknown =
        path === "/api/bootstrap" ? { token: "test-token" } : data;
      if (init?.method === "POST") {
        let value: unknown = data;
        if (path.endsWith("/preview"))
          value = {
            id: "reviewed",
            symbol: "INFY",
            side: "buy",
            quantity: 5,
            price: 1000,
            status: "preview",
          };
        if (path === "/api/india/broker") data.broker = body.broker;
        if (path.endsWith("/settings")) {
          if (body.expected_revision !== (data.settings_revision ?? 0))
            return new Response(
              JSON.stringify({
                id: "conflict",
                status: "failed",
                error:
                  "Trading settings changed in another window. Reload saved settings before saving again.",
              }),
            );
          const {
            expected_revision,
            expected_broker,
            expected_scope,
            ...settings
          } = body;
          data.settings = settings;
          data.settings_revision = (data.settings_revision ?? 0) + 1;
          data.settings_saved_at = new Date().toISOString();
        }
        if (path.endsWith("/automation")) data.auto.enabled = body.enabled;
        if (path.endsWith("/connect")) value = { connected: true };
        result = { id: "job", status: "completed", result: value };
      }
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      {connections ? <IndiaBrokerConnections /> : <IndiaTrading />}
    </QueryClientProvider>,
  );
  return { calls, data, reads, client, ...rendered };
}

it("shows the dedicated India controls, all three brokers and INR budget without submitting on render", async () => {
  const f = setup();
  expect(
    await screen.findByRole("heading", { name: "India intraday trading" }),
  ).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Trading broker" })).toHaveValue(
    "groww",
  );
  expect(screen.getByRole("option", { name: /Upstox/ })).toBeVisible();
  expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toHaveValue(
    100000,
  );
  expect(f.calls).toEqual([]);
});

it("requires review and explicit checkbox confirmation before placing an India order", async () => {
  const f = setup();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review BUY INFY" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm India BUY INFY",
  });
  const confirm = within(dialog).getByRole("button", {
    name: "Confirm real orders",
  });
  expect(confirm).toBeDisabled();
  expect(f.calls.map((c) => c.path)).toEqual(["/api/india/trading/preview"]);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(f.calls[1]).toEqual({
      path: "/api/india/trading/orders/reviewed/confirm",
      body: { acknowledged: true },
    }),
  );
});

it("India automation has its own explicit consent", async () => {
  const f = setup();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Start India automatic trading",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Start India automatic trading",
  });
  expect(f.calls).toEqual([]);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm real orders" }),
  );
  await waitFor(() =>
    expect(f.calls).toContainEqual({
      path: "/api/india/trading/automation",
      body: { enabled: true, acknowledged: true },
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Stop India automatic trading" }),
  ).toBeVisible();
});

it("unresolved India orders block new trades and broker switching while leaving reconciliation available", async () => {
  setup(true);
  expect(
    await screen.findByRole("button", {
      name: "Start India automatic trading",
    }),
  ).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "Trading broker" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Review BUY INFY" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Check broker status" }),
  ).toBeEnabled();
  expect(screen.getByText(/Placement status is uncertain/)).toBeVisible();
});

it("saves INR settings with normalized NSE symbols", async () => {
  const f = setup();
  fireEvent.change(
    await screen.findByRole("textbox", { name: /NSE watchlist/ }),
    { target: { value: "infy.ns, RELIANCE" } },
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Budget (₹)" }), {
    target: { value: "50000" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save India trading settings" }),
  );
  await waitFor(() =>
    expect(f.calls).toContainEqual({
      path: "/api/india/trading/settings",
      body: {
        budget: 50000,
        reserve_pct: 10,
        symbols: ["INFY", "RELIANCE"],
        selection_mode: "manual",
        index: "Nifty 100",
        expected_revision: 0,
        expected_broker: "groww",
        expected_scope: "india-one",
      },
    }),
  );
});

it("shows setup steps and keeps automatic trading disabled until its account is configured", async () => {
  setup(false, false, { configured: false, snapshot: null });
  expect(
    await screen.findByRole("list", { name: "India trading setup" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Start India automatic trading" }),
  ).toBeDisabled();
  expect(screen.getByText("Positions haven’t been checked")).toBeVisible();
});

it("connects the chosen broker and clears the token after verification", async () => {
  const f = setup(false, true);
  fireEvent.change(screen.getByLabelText("Daily access token"), {
    target: { value: "secret-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect Upstox" }));
  await waitFor(() =>
    expect(f.calls).toContainEqual({
      path: "/api/india/trading/connect",
      body: { broker: "upstox", access_token: "secret-value" },
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Daily access token")).toHaveValue(""),
  );
});

it("refreshes manual monitoring every fifteen seconds without placing trades", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = setup();
  await screen.findByRole("heading", { name: "India intraday trading" });
  expect(f.calls).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(f.calls).toEqual([{ path: "/api/india/trading/refresh", body: {} }]);
});

for (const [name, overrides] of Object.entries({
  unconfigured: { configured: false },
  disconnected: {
    brokers: [{ id: "groww", name: "Groww", connected: false, ending: null }],
  },
  closed: { phase: "After market close" },
  failed: {
    error: "Kite PermissionException: Insufficient permission for that call.",
  },
  idle: { snapshot: null },
} satisfies Record<string, Partial<IndiaLive>>))
  it(`does not repeatedly load an ${name} India session`, async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = setup(false, false, overrides);
    await screen.findByRole("heading", { name: "India intraday trading" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45000);
    });
    expect(f.calls).toEqual([]);
    expect(f.reads).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Refresh account & broker status" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("spinbutton", { name: "Budget (₹)" }),
    ).toBeEnabled();
  });

it("keeps manual controls usable while a routine background broker check is pending", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = setup();
  await screen.findByRole("heading", { name: "India intraday trading" });
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation((input, init) =>
    String(input).endsWith("/india/trading/refresh")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(input, init),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.queryByText("Checking account…")).not.toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Save India trading settings" }),
  ).toBeEnabled();
  await act(async () => {
    finish(
      new Response(
        JSON.stringify({ id: "refresh", status: "completed", result: f.data }),
      ),
    );
  });
});

it("shows a failed status request with retry instead of an endless loading notice", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: "India status is unavailable" }),
          { status: 503 },
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IndiaTrading />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("button", { name: "Retry India trading" }),
  ).toBeEnabled();
  expect(screen.queryByText("Loading India trading…")).not.toBeInTheDocument();
  expect(screen.getByText("India status is unavailable")).toBeVisible();
});

it("requires an explicit choice even with connected brokers and saves it for trading and investing", async () => {
  const f = setup(false, false, {
    broker: null,
    scope: null,
    configured: false,
    snapshot: null,
    actions: [],
  });
  const picker = await screen.findByRole("combobox", {
    name: "Trading broker",
  });
  expect(picker).toHaveValue("");
  expect(
    screen.getByRole("option", { name: "Choose a broker account" }),
  ).toBeVisible();
  expect(
    screen.getByText(/Used for all India trades and long-term investments/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save India trading settings" }),
  ).toBeDisabled();
  expect(f.calls).toEqual([]);
  fireEvent.change(picker, { target: { value: "groww" } });
  await waitFor(() => expect(picker).toHaveValue("groww"));
  expect(f.calls).toEqual([
    { path: "/api/india/broker", body: { broker: "groww" } },
  ]);
});

it("automatic selection needs no tickers, exposes the shortlist and saves the mode without enabling trading", async () => {
  const f = setup(false, false, {
    settings: {
      budget: 100000,
      reserve_pct: 10,
      symbols: [],
      selection_mode: "automatic",
    },
    signals: {
      message: "Monitoring confirmed breakouts",
      asof: null,
      shortlist: [
        {
          symbol: "TATAMOTORS",
          relative_volume: 2,
          rotation_score: 0.8,
          baseline_sessions: 20,
        },
      ],
    },
    actions: [],
  });
  expect(
    await screen.findByRole("combobox", { name: "Stock selection" }),
  ).toHaveValue("automatic");
  expect(
    screen.queryByRole("textbox", { name: /NSE watchlist/ }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("table", { name: "India shortlisted stocks" }),
  ).toHaveTextContent("TATAMOTORS");
  expect(f.calls).toEqual([]);
  fireEvent.click(
    screen.getByRole("button", { name: "Save India trading settings" }),
  );
  await waitFor(() =>
    expect(f.calls).toEqual([
      {
        path: "/api/india/trading/settings",
        body: {
          budget: 100000,
          reserve_pct: 10,
          symbols: [],
          selection_mode: "automatic",
          index: "Nifty 100",
          expected_revision: 0,
          expected_broker: "groww",
          expected_scope: "india-one",
        },
      },
    ]),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Stock selection" }), {
    target: { value: "manual" },
  });
  expect(screen.getByRole("textbox", { name: /NSE watchlist/ })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save India trading settings" }),
  ).toBeDisabled();
});

it("persists a confirmed budget and chosen index through broker refreshes and remounts", async () => {
  const f = setup(false, false, {
    settings: {
      budget: 100000,
      reserve_pct: 10,
      symbols: [],
      selection_mode: "automatic",
      index: "Nifty 100",
    },
  });
  const budget = await screen.findByRole("spinbutton", { name: "Budget (₹)" });
  fireEvent.change(budget, { target: { value: "25000" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Trading index" }), {
    target: { value: "Nifty Bank" },
  });
  expect(
    screen.getByRole("button", { name: "Start India automatic trading" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Save India trading settings" }),
  );
  await screen.findByText(/Saved locally:/);
  expect(budget).toHaveValue(25000);
  expect(f.data.settings.index).toBe("Nifty Bank");
  expect(
    localStorage.getItem("india-trading-draft:groww:india-one"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh account & broker status" }),
  );
  await waitFor(() =>
    expect(f.calls.some((c) => c.path.endsWith("/refresh"))).toBe(true),
  );
  expect(budget).toHaveValue(25000);
  f.unmount();
  setup(false, false, f.data);
  expect(
    await screen.findByRole("spinbutton", { name: "Budget (₹)" }),
  ).toHaveValue(25000);
  expect(screen.getByRole("combobox", { name: "Trading index" })).toHaveValue(
    "Nifty Bank",
  );
});

it("restores unsaved edits after refresh without treating them as confirmed trading limits", async () => {
  const f = setup();
  fireEvent.change(
    await screen.findByRole("spinbutton", { name: "Budget (₹)" }),
    { target: { value: "37500" } },
  );
  await act(() => f.client.invalidateQueries({ queryKey: ["india-trading"] }));
  expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toHaveValue(
    37500,
  );
  f.unmount();
  const next = setup();
  expect(
    await screen.findByRole("spinbutton", { name: "Budget (₹)" }),
  ).toHaveValue(37500);
  expect(next.data.settings.budget).toBe(100000);
  expect(
    screen.getByRole("button", { name: "Start India automatic trading" }),
  ).toBeDisabled();
  expect(next.calls).toEqual([]);
});

it("updates clean forms from saved settings and rejects an older window's budget edits", async () => {
  const f = setup();
  await screen.findByRole("spinbutton", { name: "Budget (₹)" });
  await act(() =>
    f.client.setQueryData(["india-trading"], {
      ...f.data,
      settings: { ...f.data.settings, budget: 42000 },
      settings_revision: 1,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toHaveValue(
      42000,
    ),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Budget (₹)" }), {
    target: { value: "50000" },
  });
  f.data.settings.budget = 75000;
  f.data.settings_revision = 2;
  await act(() =>
    f.client.setQueryData(["india-trading"], structuredClone(f.data)),
  );
  expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toHaveValue(
    50000,
  );
  expect(
    await screen.findByText(/Saved settings changed in another window/),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Save India trading settings" }),
  );
  await screen.findByText(/Trading settings changed in another window/);
  expect(f.data.settings.budget).toBe(75000);
  expect(
    screen.getByRole("button", { name: "Start India automatic trading" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved settings" }),
  );
  expect(screen.getByRole("spinbutton", { name: "Budget (₹)" })).toHaveValue(
    75000,
  );
});

it("buys the clicked India shortlist stock through the selected account preview and confirmation", async () => {
  const f = setup(false, false, {
    signals: {
      message: "Ready",
      asof: new Date().toISOString(),
      fresh: true,
      shortlist: [{ symbol: "INFY", relative_volume: 2 }],
    },
  });
  const table = await screen.findByRole("table", {
    name: "India shortlisted stocks",
  });
  fireEvent.click(within(table).getByRole("button", { name: "Buy INFY" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm India BUY INFY",
  });
  expect(f.calls).toEqual([
    {
      path: "/api/india/trading/preview",
      body: {
        symbol: "INFY",
        side: "buy",
        expected_scope: "india-one",
        expected_revision: 0,
        expected_broker: "groww",
      },
    },
  ]);
  const confirm = within(dialog).getByRole("button", {
    name: "Confirm real orders",
  });
  expect(confirm).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(f.calls.map((c) => c.path)).toEqual([
      "/api/india/trading/preview",
      "/api/india/trading/orders/reviewed/confirm",
    ]),
  );
});

it.each(["cached", "automatic", "pending", "ineligible"])(
  "blocks a %s India shortlist buy",
  async (state) => {
    const f = setup(state === "pending", false, {
      signals: {
        message: "Ready",
        asof: new Date().toISOString(),
        fresh: state !== "cached",
        shortlist: [{ symbol: "INFY" }],
      },
      ...(state === "automatic" ? { auto: { enabled: true } } : {}),
      ...(state === "ineligible" ? { actions: [] } : {}),
    });
    const table = await screen.findByRole("table", {
      name: "India shortlisted stocks",
    });
    const button = within(table).getByRole("button", { name: "Buy INFY" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(f.calls).toEqual([]);
  },
);

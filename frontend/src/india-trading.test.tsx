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
    settings: {
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
  render(
    <QueryClientProvider client={client}>
      {connections ? <IndiaBrokerConnections /> : <IndiaTrading />}
    </QueryClientProvider>,
  );
  return { calls, data, reads };
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
      body: { budget: 50000, reserve_pct: 10, symbols: ["INFY", "RELIANCE"] },
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

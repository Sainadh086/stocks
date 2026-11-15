import { expect, test } from "@playwright/test";

test("India trading has its own tab, broker choices and explicit manual order confirmation", async ({
  page,
}) => {
  const sent: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/bootstrap") data = { token: "fixture-token" };
    if (path === "/api/access/status")
      data = { local: true, authenticated: true };
    if (path === "/api/indices" || path === "/api/markets") data = [];
    if (path === "/api/mobile/setup")
      data = {
        urls: [],
        setup_urls: [],
        certificate_urls: [],
        profile_urls: [],
        connected: false,
        expires_at: null,
      };
    if (path === "/api/accounts")
      data = {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        kite_connected: false,
        live_settings: { budget: null, reserve_pct: null },
      };
    if (path === "/api/preferences")
      data = {
        privacy_mode: false,
        theme: "light",
        top_benchmarks: [],
        catalog: [],
      };
    if (path === "/api/india/trading")
      data = {
        broker: "groww",
        brokers: [
          { id: "kite", name: "Zerodha Kite", connected: true },
          { id: "upstox", name: "Upstox", connected: false },
          { id: "groww", name: "Groww", connected: true },
        ],
        scope: "india-fixture",
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
          cash: 80000,
          positions: [],
          updated_at: "2026-11-11T05:45:00Z",
        },
        signals: {
          message:
            "Monitoring confirmed NSE breakouts and managed-share exits.",
          asof: "2026-11-11T05:45:00Z",
          shortlist: [
            {
              symbol: "INFY",
              relative_volume: 2,
              rotation_score: 0.8,
              baseline_sessions: 20,
            },
          ],
        },
        actions: [
          {
            symbol: "INFY",
            exchange: "NSE",
            action: "BUY",
            side: "buy",
            quantity: 5,
            price: 1500,
            stop: 1480,
            target: 1540,
            enabled: true,
            reason: "Completed breakout with VWAP and EMA confirmation.",
          },
        ],
        tickets: [],
        history: [],
        error: null,
      };
    if (route.request().method() === "POST") {
      sent.push(path);
      data = {
        id: "job",
        status: "completed",
        result: path.endsWith("/preview")
          ? {
              id: "ticket",
              symbol: "INFY",
              side: "buy",
              quantity: 5,
              price: 1500,
              status: "preview",
            }
          : {},
      };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/?workspace=india-trading");
  await expect(
    page.getByRole("heading", { name: "India trading", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Trading broker" }),
  ).toHaveValue("groww");
  await expect(
    page.getByRole("button", { name: "US trading", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-india-trading-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("combobox", { name: "Stock selection" }),
  ).toHaveValue("automatic");
  await expect(
    page.getByRole("table", { name: "India shortlisted stocks" }),
  ).toContainText("INFY");
  await expect(
    page.getByRole("textbox", { name: /NSE watchlist/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Review BUY INFY" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm India BUY INFY" });
  const confirm = dialog.getByRole("button", { name: "Confirm real orders" });
  await expect(confirm).toBeDisabled();
  expect(sent).toEqual(["/api/india/trading/preview"]);
  await dialog.getByRole("checkbox").check();
  await confirm.click();
  await expect
    .poll(() => sent)
    .toEqual([
      "/api/india/trading/preview",
      "/api/india/trading/orders/ticket/confirm",
    ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("heading", { name: "India trading", exact: true })
    .click();
  await page.screenshot({
    path: "/private/tmp/varshan-india-trading-phone.png",
    animations: "disabled",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Manage broker connections" }).click();
  const settings = page.getByRole("dialog", { name: "Account settings" });
  await expect(
    settings.getByRole("button", { name: "Broker accounts", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    settings.getByRole("heading", { name: "Broker connections", exact: true }),
  ).toBeInViewport();
  await expect(
    settings.getByRole("heading", { name: "Upstox & Groww connections" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-broker-settings-phone.png",
    animations: "disabled",
  });
  expect(
    await settings.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await settings
    .getByRole("button", { name: "Broker accounts", exact: true })
    .click();
  await page.screenshot({
    path: "/private/tmp/varshan-broker-settings-desktop.png",
    animations: "disabled",
  });
});

test("India index and budget survive refresh while browser drafts never change confirmed trading limits", async ({
  page,
}) => {
  const sent: string[] = [];
  const live = {
    broker: "groww",
    brokers: [
      { id: "groww", name: "Groww", connected: true, ending: "••••1234" },
    ],
    scope: "a".repeat(20),
    investment_scope: "a".repeat(20),
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
    settings: {
      budget: 100000,
      reserve_pct: 10,
      index: "Nifty 100",
      selection_mode: "automatic",
      symbols: [],
    },
    settings_revision: 0,
    settings_saved_at: null as string | null,
    auto: { enabled: false },
    phase: "Market open",
    snapshot: null,
    signals: {
      message: "Waiting for a current scan",
      asof: null,
      fresh: false,
      shortlist: [],
    },
    actions: [],
    tickets: [],
    history: [],
    error: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let value: unknown = {};
    if (path === "/api/health") value = { status: "ok", app: "varshan" };
    if (path === "/api/bootstrap") value = { token: "fixture-token" };
    if (path === "/api/access/status")
      value = { local: true, authenticated: true };
    if (path === "/api/preferences")
      value = {
        privacy_mode: false,
        theme: "forest",
        top_benchmarks: [],
        catalog: [],
      };
    if (["/api/indices", "/api/markets"].includes(path)) value = [];
    if (path === "/api/accounts")
      value = {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        live_settings: { budget: null, reserve_pct: null },
      };
    if (path === "/api/india/trading") value = live;
    if (route.request().method() === "POST") {
      sent.push(path);
      if (path === "/api/india/trading/settings") {
        const {
          expected_revision,
          expected_scope,
          expected_broker,
          ...settings
        } = route.request().postDataJSON();
        expect(expected_revision).toBe(live.settings_revision);
        expect(expected_scope).toBe(live.scope);
        expect(expected_broker).toBe(live.broker);
        live.settings = settings;
        live.settings_revision++;
        live.settings_saved_at = new Date().toISOString();
      }
      value = { id: "saved", status: "completed", result: live };
    }
    await route.fulfill({ json: value });
  });
  await page.goto("/?workspace=india-trading");
  const amount = page.getByRole("spinbutton", { name: "Budget (₹)" });
  const index = page.getByRole("combobox", { name: "Trading index" });
  await expect(index.locator("option")).toHaveText(live.indices);
  await amount.fill("25000");
  await index.selectOption("Nifty Bank");
  await expect(
    page.getByRole("button", {
      name: "Start India automatic trading",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Save India trading settings" })
    .click();
  await expect(page.getByText(/Saved locally:/)).toBeVisible();
  await expect(amount).toHaveValue("25000");
  await page
    .getByRole("button", { name: "Refresh account & broker status" })
    .click();
  await expect(amount).toHaveValue("25000");
  await page.reload();
  await expect(amount).toHaveValue("25000");
  await expect(index).toHaveValue("Nifty Bank");
  await amount.fill("40000");
  await page.reload();
  await expect(amount).toHaveValue("40000");
  expect(live.settings.budget).toBe(25000);
  await expect(page.getByText(/Confirmed budget:/)).toContainText("25,000");
  await expect(
    page.getByRole("button", {
      name: "Start India automatic trading",
      exact: true,
    }),
  ).toBeDisabled();
  expect(sent).toEqual([
    "/api/india/trading/settings",
    "/api/india/trading/refresh",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: "/private/tmp/varshan-india-saved-settings-phone.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

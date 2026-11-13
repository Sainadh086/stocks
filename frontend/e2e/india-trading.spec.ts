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

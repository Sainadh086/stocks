import { expect, test } from "@playwright/test";

test("recommendations show learning for both markets and the settings switch survives reload without trading", async ({
  page,
}) => {
  let enabled = false;
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let data: unknown = {};
    if (path === "/api/bootstrap") data = { token: "fixture-token" };
    if (path === "/api/access/status")
      data = { local: true, authenticated: true };
    if (path === "/api/mobile/setup")
      data = {
        urls: [],
        setup_urls: [],
        certificate_urls: [],
        profile_urls: [],
        connected: false,
        expires_at: null,
      };
    if (["/api/markets", "/api/indices"].includes(path)) data = [];
    if (path === "/api/preferences")
      data = {
        privacy_mode: false,
        theme: "light",
        top_benchmarks: [],
        catalog: [],
      };
    if (path === "/api/accounts")
      data = {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        live_settings: { budget: null, reserve_pct: null },
      };
    if (path === "/api/india/trading")
      data = {
        broker: null,
        brokers: [],
        tickets: [],
        auto: { enabled: false },
      };
    if (path === "/api/portfolios")
      data = { india: { gems: [] }, us: { gems: [], picks: [] } };
    if (path === "/api/learning/settings") {
      if (route.request().method() === "POST")
        enabled = route.request().postDataJSON().execution_enabled;
      data = { execution_enabled: enabled };
    }
    if (path === "/api/learning") {
      const market = url.searchParams.get("market") ?? "US";
      data = {
        contexts: [{ bucket: market, label: `${market} trading` }],
        selected: market,
        orders: [],
        episodes: [],
        insights: [],
        policy: null,
        execution_enabled: enabled,
        recommendations: [
          {
            symbol: market === "US" ? "DEMO" : "INFY",
            strategy: "intraday_rotation_v1",
            learning_suggestion: "Evidence needed",
            learning_reason: "More completed cycles needed",
            observed_at: new Date().toISOString(),
          },
        ],
      };
    }
    if (route.request().method() === "POST")
      writes.push({ path, body: route.request().postDataJSON() });
    await route.fulfill({ json: data });
  });
  await page.goto("/?workspace=recommendations");
  await expect(
    page.getByRole("heading", {
      name: "India reinforcement learning recommendations",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Learning stock recommendations" }),
  ).toContainText("INFY");
  await expect(page.getByText("Recommendations only")).toBeVisible();
  await page.getByRole("button", { name: "US long term", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "US reinforcement learning recommendations",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Learning stock recommendations" }),
  ).toContainText("DEMO");
  expect(writes).toEqual([]);
  await page
    .getByRole("button", { name: "Open account settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reinforcement learning", exact: true })
    .click();
  const toggle = page.getByRole("checkbox", {
    name: "Use reinforcement learning in trading and automatic trading",
  });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByText("Learning preference saved.")).toBeVisible();
  await expect(toggle).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Reinforcement learning", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/private/tmp/varshan-learning-settings-mobile.png",
    animations: "disabled",
  });
  await page.reload();
  await expect(page.getByText("Enabled in settings")).toBeVisible();
  expect(writes).toEqual([
    { path: "/api/learning/settings", body: { execution_enabled: true } },
  ]);
});

test("learning journal explains cold-start evidence and records reasoning without broker actions", async ({
  page,
}) => {
  const writes: string[] = [];
  const journal = {
    contexts: [{ bucket: "us-investing", label: "US investing · fixture" }],
    selected: "us-investing",
    orders: [
      {
        key: "observed-buy",
        order_id: "buy-one",
        symbol: "DEMO",
        side: "buy",
        status: "filled",
        quantity: 2,
        price: 100,
        strategy: "unattributed",
        reason: "Strategy attribution needed",
      },
    ],
    episodes: [],
    insights: [],
    policy: null,
    error: null,
    coverage: "Historical coverage depends on broker retention.",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/bootstrap") data = { token: "fixture-token" };
    if (path === "/api/access/status")
      data = { local: true, authenticated: true };
    if (["/api/markets", "/api/indices"].includes(path)) data = [];
    if (path === "/api/preferences")
      data = {
        privacy_mode: false,
        theme: "light",
        top_benchmarks: [],
        catalog: [],
      };
    if (path === "/api/accounts")
      data = {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        kite_connected: false,
        live_settings: { budget: null, reserve_pct: null },
      };
    if (path.startsWith("/api/learning")) data = journal;
    if (route.request().method() === "POST") writes.push(path);
    await route.fulfill({ json: data });
  });
  await page.goto("/?workspace=learning");
  await expect(
    page.getByRole("heading", { name: "Strategy learning & trade journal" }),
  ).toBeVisible();
  await expect(page.getByText("Collecting evidence")).toBeVisible();
  await page
    .getByRole("button", { name: "Train and evaluate advisor" })
    .click();
  await expect.poll(() => writes).toEqual(["/api/learning/train"]);
  await page.getByText("Buy / sell journal and strategy attribution").click();
  await expect(
    page.getByRole("table", { name: "Buy sell learning journal" }),
  ).toContainText("buy-one");
  await page.getByLabel("Order to explain").selectOption("observed-buy");
  await page
    .getByLabel("Decision reasoning")
    .fill("Reviewed the dated Gems screen before this entry.");
  await page.getByRole("button", { name: "Save strategy reasoning" }).click();
  await expect
    .poll(() => writes)
    .toEqual(["/api/learning/train", "/api/learning/attribute"]);
  await page.screenshot({
    path: "/private/tmp/varshan-learning-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/private/tmp/varshan-learning-phone.png",
    fullPage: true,
  });
});

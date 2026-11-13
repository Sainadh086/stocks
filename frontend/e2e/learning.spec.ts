import { expect, test } from "@playwright/test";

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

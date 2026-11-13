import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("Botanical selectors match text fields across recommendations, trading and mobile", async ({
  page,
}) => {
  let theme = "forest";
  const posted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/bootstrap") data = { token: "fixture-token" };
    if (path === "/api/access/status")
      data = { local: true, authenticated: true };
    if (["/api/markets", "/api/indices"].includes(path)) data = [];
    if (path === "/api/accounts")
      data = {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        kite_connected: true,
        live_settings: { budget: null, reserve_pct: null },
      };
    if (path === "/api/preferences")
      data = { theme, privacy_mode: false, top_benchmarks: [], catalog: [] };
    if (path === "/api/portfolios")
      data = {
        india: { holdings: [], gems: [] },
        us: { holdings: [], gems: [], picks: [] },
      };
    if (path === "/api/kite/batches") data = [];
    if (path === "/api/india/trading")
      data = {
        broker: "kite",
        brokers: [{ id: "kite", name: "Zerodha Kite", connected: true }],
        scope: "fixture",
        configured: false,
        settings: {
          budget: 100000,
          reserve_pct: 10,
          symbols: ["RELIANCE", "INFY"],
        },
        auto: { enabled: false },
        phase: "Market closed",
        snapshot: null,
        signals: { message: "NSE market closed.", asof: null },
        actions: [],
        tickets: [],
        history: [],
        error: null,
      };
    if (route.request().method() === "POST") posted.push(path);
    await route.fulfill({ json: data });
  });
  await page.goto("/?workspace=recommendations");
  const strategy = page.getByRole("combobox", {
    name: "Strategy",
    exact: true,
  });
  await expect(strategy).toBeVisible();
  await expect(strategy).toHaveCSS("appearance", "none");
  expect(
    await strategy.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(46);
  await strategy.selectOption("weekend_style");
  await expect(strategy).toHaveValue("weekend_style");
  await expect(page.locator(".recommendations-toolbar")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({
    path: "/private/tmp/varshan-recommendation-controls.png",
  });
  await page
    .getByRole("button", { name: "India trading", exact: true })
    .click();
  const broker = page.getByRole("combobox", { name: "Trading broker" });
  const budget = page.getByLabel("Budget (₹)", { exact: true });
  const sizes = await page
    .locator(".india-trading-controls")
    .evaluate((card) => {
      const select = card.querySelector("select")!,
        input = card.querySelector('input[type="number"]')!;
      const a = getComputedStyle(select),
        b = getComputedStyle(input);
      return {
        selectHeight: select.getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height,
        selectFont: a.fontFamily,
        inputFont: b.fontFamily,
        selectWeight: a.fontWeight,
        inputWeight: b.fontWeight,
        arrow: a.backgroundImage,
        radius: a.borderRadius,
      };
    });
  expect(sizes.selectHeight).toBeCloseTo(sizes.inputHeight, 0);
  expect(sizes.selectFont).toBe(sizes.inputFont);
  expect(sizes.selectWeight).toBe("500");
  expect(sizes.inputWeight).toBe("500");
  expect(sizes.arrow).toContain("linear-gradient");
  expect(sizes.radius).toBe("8px");
  await budget.fill("125000");
  await budget.press("ArrowUp");
  await expect(budget).toHaveValue("125001");
  await broker.focus();
  await expect(broker).toHaveCSS("outline-style", "solid");
  await page.screenshot({ path: "/private/tmp/varshan-trading-controls.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(broker).toHaveCSS("font-size", "16px");
  await expect(budget).toHaveCSS("font-size", "16px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/private/tmp/varshan-trading-controls-phone.png",
    fullPage: true,
  });
  theme = "forest-dark";
  await page.goto("/?workspace=india-trading");
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "forest-dark",
  );
  await expect(
    page.getByRole("combobox", { name: "Trading broker" }),
  ).toHaveCSS("appearance", "none");
  expect(
    await page
      .getByRole("combobox", { name: "Trading broker" })
      .evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("linear-gradient");
  expect(posted).toEqual([]);
});

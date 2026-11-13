import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("API health detects a timeout and recovers, including on mobile", async ({
  page,
}) => {
  let stalled = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health" && stalled)
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    const fixtures: Record<string, unknown> = {
      "/api/health": { status: "ok", app: "varshan" },
      "/api/bootstrap": { token: "fixture-token" },
      "/api/access/status": { local: true, authenticated: true },
      "/api/markets": [],
      "/api/indices": [],
      "/api/accounts": {
        roles: { long_term: { selected: false }, trading: { selected: false } },
        live_settings: { budget: null, reserve_pct: null },
      },
      "/api/preferences": { theme: "forest", top_benchmarks: [], catalog: [] },
      "/api/portfolios": {
        india: { holdings: [], gems: [] },
        us: { holdings: [], gems: [], picks: [] },
      },
      "/api/kite/batches": [],
    };
    await route.fulfill({ json: fixtures[path] ?? {} });
  });
  await page.goto("/?workspace=recommendations");
  await expect(
    page.getByRole("status", { name: "API health: online" }),
  ).toBeVisible();
  stalled = true;
  await expect(
    page.getByRole("status", { name: "API health: offline" }),
  ).toBeVisible({ timeout: 12_000 });
  stalled = false;
  await expect(
    page.getByRole("status", { name: "API health: online" }),
  ).toBeVisible({ timeout: 8_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await expect(
    page.getByRole("status", { name: "API health: online" }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/private/tmp/varshan-api-health-phone.png" });
});

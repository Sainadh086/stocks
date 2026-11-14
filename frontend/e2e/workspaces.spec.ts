import { expect, test } from "@playwright/test";

test("an unresolved order can only be linked after reviewing and confirming its filled receipt", async ({
  page,
}) => {
  let linked = false;
  const receipt = {
    id: "broker-receipt",
    symbol: "TSLA",
    side: "sell",
    quantity: "0.107717",
    state: "filled",
    created_at: "2026-10-26T18:22:43Z",
  };
  await page.route("**/api/live", (route) =>
    route.fulfill({
      json: {
        snapshot: null,
        auto: { enabled: false },
        batch: null,
        model: {
          actions: [],
          message: linked
            ? "Monitoring signals"
            : "An order has unresolved status.",
        },
        tickets: [
          {
            id: "unresolved",
            status: linked ? "submitted" : "unknown",
            arguments: { symbol: "TSLA", side: "sell", quantity: "0.107717" },
            reviewed_at: "2026-10-26T18:22:40Z",
            recovery_orders: linked ? [] : [receipt],
            ...(linked ? { result: { order: receipt } } : {}),
          },
        ],
      },
    }),
  );
  await page.route("**/api/live/tickets/unresolved/link", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      order_id: receipt.id,
      acknowledged: true,
    });
    linked = true;
    return route.fulfill({
      json: { id: "link-job", status: "completed", result: {} },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "US trading", exact: true }).click();
  await page.getByRole("button", { name: /Review matching fill/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Confirm matching broker receipt",
  });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Link confirmed receipt",
  });
  await expect(confirm).toBeDisabled();
  expect(linked).toBe(false);
  await page.screenshot({ path: "/private/tmp/varshan-receipt-recovery.png" });
  await dialog
    .getByRole("checkbox", { name: /I verified in Robinhood/ })
    .check();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("table", { name: "Order tickets" })
      .getByText("filled", { exact: true }),
  ).toBeVisible();
  expect(linked).toBe(true);
});

test.beforeEach(async ({ page }) => {
  // Public-looking fixture data only: no requests reach private storage or a broker.
  await page.addInitScript(() => {
    class FixtureSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      send(data: string) {
        if (JSON.parse(data).token)
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({
                  type: "connected",
                  connection: "fixture",
                }),
              }),
            0,
          );
      }
      close() {}
    }
    Object.defineProperty(window, "WebSocket", { value: FixtureSocket });
  });
  let comparison: unknown = null;
  let automation = {
    enabled: false,
    background: false,
    expires_at: null as string | null,
  };
  let topBenchmarks = ["Nifty 50", "S&P 500"];
  let appearance = {
    privacy_mode: false,
    theme: "light",
    supported_themes: [
      "light",
      "midnight",
      "forest",
      "obsidian",
      "aurora",
      "sandstone",
      "dark",
      "forest-dark",
    ],
    chart_provider: "yahoo",
    chart_view: "embedded",
  };
  const catalog = [
    {
      name: "Nifty MidSmallCap 400",
      ticker: "NSE:NIFTYMIDSML400",
      region: "India",
    },
    { name: "Nifty 50", ticker: "^NSEI", region: "India" },
    { name: "Nifty Bank", ticker: "^NSEBANK", region: "India" },
    { name: "Sensex", ticker: "^BSESN", region: "India" },
    { name: "S&P 500", ticker: "^GSPC", region: "US" },
    { name: "Nasdaq-100", ticker: "^NDX", region: "US" },
    { name: "Dow Jones", ticker: "^DJI", region: "US" },
    { name: "Russell 2000", ticker: "^RUT", region: "US" },
  ];
  const weeklies = new Map<string, unknown>();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path === "/api/live/automation") {
      const body = route.request().postDataJSON();
      automation = {
        enabled: body.enabled,
        background: body.background,
        expires_at: body.enabled
          ? new Date(Date.now() + 12 * 3600000).toISOString()
          : null,
      };
      data = automation;
    }
    if (path === "/api/access/status")
      data = { authenticated: true, local: true, secure: false };
    if (path === "/api/mobile/setup")
      data = {
        urls: ["https://10.1.2.3:8443"],
        setup_urls: ["http://10.1.2.3:8080"],
        profile_urls: ["http://10.1.2.3:8080/varshan.mobileconfig"],
        connected: false,
        expires_at: null,
        certificate_urls: ["http://10.1.2.3:8080/certificate.cer"],
      };
    if (path === "/api/mobile/pairing")
      data = {
        code: "123456",
        expires_at: new Date(Date.now() + 300000).toISOString(),
      };
    if (path === "/api/notifications")
      data = {
        public_key: "B" + "A".repeat(86),
        devices: 0,
        events: [],
        delivery_error: null,
      };
    if (path === "/api/notifications/subscribe") data = { subscribed: true };
    if (path === "/api/notifications/test") data = { queued: true };
    if (path === "/api/kite/login") {
      const page =
        new URL(route.request().url()).searchParams.get("return_page") ??
        "holdings";
      const params = new URLSearchParams({
        varshan_kite_state: "fixture-state",
        varshan_return_page: page,
      });
      data = {
        url: `https://kite.zerodha.com/connect/login?v=3&api_key=fixture&redirect_params=${encodeURIComponent(params.toString())}`,
      };
    }
    if (path === "/api/kite/callback") {
      const payload = route.request().postDataJSON();
      data =
        payload.state === "fixture-state"
          ? {
              id: "kite-return",
              status: "completed",
              result:
                payload.request_token === "no-page"
                  ? { connected: true }
                  : payload.request_token === "bad-result"
                    ? null
                    : { connected: true, return_page: "weekly" },
            }
          : {
              id: "kite-return",
              status: "failed",
              error: "Kite login expired. Start a new login.",
            };
    }
    if (path === "/api/preferences") {
      if (route.request().method() === "POST") {
        const patch = route.request().postDataJSON();
        if (patch.top_benchmarks) topBenchmarks = patch.top_benchmarks;
        appearance = { ...appearance, ...patch };
      }
      data = { ...appearance, top_benchmarks: topBenchmarks, catalog };
    }
    if (path.startsWith("/api/charts/"))
      data = {
        source: "Fixture",
        adjustment: "splits",
        bars: [
          { date: "2026-10-01", close: 100 },
          { date: "2026-10-09", close: 105 },
        ],
      };
    if (path === "/api/indices")
      data = catalog
        .filter((index) => topBenchmarks.includes(index.name))
        .map((index) => ({
          code: index.region === "India" ? "IND" : "US",
          name: index.region,
          benchmark: index.name,
          theme: "bullish",
          phase: "Market closed",
          report: {
            price: index.region === "India" ? 25760.25 : 6600.85,
            change_pct: 0.72,
            date: "2026-10-09",
            source: "Fixture",
          },
          history: [],
        }));
    if (path.startsWith("/api/weekly/")) {
      const selected = path.split("/").at(-1)!;
      if (route.request().method() === "POST") {
        const result = {
          role: selected,
          from: "2026-10-03T12:00:00Z",
          to: "2026-10-10T12:00:00Z",
          generated_at: new Date().toISOString(),
          summary:
            "Fixture weekly summary: dated market events and holdings moves.",
          markets: ["India", "US"].map((region) => ({
            region,
            summary: `${region} completed-session market review.`,
            price_source: "Fixture",
            headlines: [
              {
                title: `${region} weekly market event`,
                url: "https://example.com/" + region,
                publisher: "Fixture publisher",
                published_at: "2026-10-09T12:00:00Z",
              },
            ],
          })),
          holdings: [
            {
              symbol:
                selected === "India"
                  ? "INFY.NS"
                  : selected === "trading"
                    ? "TRADE"
                    : "ABC",
              weekly_price_change_pct: 1.2,
              start_date: "2026-10-02",
              end_date: "2026-10-09",
              source: "Fixture",
              headlines: [
                {
                  title: "Company reports quarterly results",
                  url: "https://example.com/results",
                  publisher: "Fixture",
                  published_at: "2026-10-09T12:00:00Z",
                },
              ],
            },
          ],
        };
        weeklies.set(selected, result);
        data = { id: "weekly", status: "completed", result };
      } else data = weeklies.get(selected) ?? null;
    }
    if (path === "/api/bootstrap") data = { token: "fixture" };
    if (path === "/api/accounts")
      data = {
        roles: {
          long_term: { selected: true, ending: "1234" },
          trading: { selected: true, ending: "5678" },
        },
        kite_connected: true,
        live_settings: { budget: 1500, reserve_pct: 15 },
      };
    if (path === "/api/markets")
      data = ["IND", "US"].map((code, i) => ({
        code,
        name: i ? "US" : "India",
        benchmark: i ? "S&P 500" : "Nifty 50",
        theme: i ? "bearish" : "bullish",
        phase: "Market closed",
        report: {
          price: i ? 6600.85 : 25760.25,
          change_pct: i ? -0.45 : 0.72,
          date: "2026-10-09",
          source: "Fixture data",
        },
        history: Array.from({ length: 12 }, (_, j) => ({
          date: `2026-09-${j + 10}`,
          value: 100 + j,
        })),
        education_url: "https://www.investor.gov",
        reflection: {
          opening: "Begin with a clear plan.",
          closing: "Review risk and process.",
        },
      }));
    if (path === "/api/portfolios")
      data = {
        india: {
          as_of: "2026-10-09",
          holdings: [
            {
              symbol: "INFY",
              exchange: "NSE",
              shares: 20,
              price: 1850,
              market_value_inr: 37000,
              action: "HOLD",
              momentum_score: 80,
              portfolio_plan: "KEEP",
              plan_reason: "Trend remains positive",
            },
            {
              symbol: "TCS",
              exchange: "NSE",
              shares: 12,
              price: 4030,
              market_value_inr: 48360,
              action: "WATCH",
              momentum_score: 45,
              portfolio_plan: "KEEP",
              plan_reason: "Review trend confirmation",
            },
            {
              symbol: "HDFCBANK",
              exchange: "NSE",
              shares: 30,
              price: 1710,
              market_value_inr: 51300,
              action: "HOLD",
              momentum_score: 72,
              portfolio_plan: "KEEP",
              plan_reason: "Retain pending review",
            },
          ],
          replacements: [
            {
              stock: "DEMO",
              strategies: "momentum",
              momentum_score: 78,
              reason: "Illustrative research candidate",
            },
          ],
          plan: [],
          history: [
            {
              date: "2026-10-02",
              holdings: [
                {
                  symbol: "INFY",
                  exchange: "NSE",
                  action: "WATCH",
                  market_value_inr: 36000,
                },
              ],
            },
            {
              date: "2026-10-09",
              holdings: [
                {
                  symbol: "INFY",
                  exchange: "NSE",
                  action: "HOLD",
                  market_value_inr: 37000,
                },
                {
                  symbol: "TCS",
                  exchange: "NSE",
                  action: "WATCH",
                  market_value_inr: 48360,
                },
                {
                  symbol: "HDFCBANK",
                  exchange: "NSE",
                  action: "HOLD",
                  market_value_inr: 51300,
                },
              ],
            },
          ],
          weekly:
            "# Weekly review\nFixture portfolio review for layout testing.",
        },
        us: {
          holdings: [
            { symbol: "ABC", quantity: 10, price: 120, market_value: 1200 },
          ],
          picks: [],
          ranked: [],
          review: [],
          report_current: false,
        },
      };
    if (path.startsWith("/api/comparisons/")) data = comparison;
    if (path === "/api/comparisons") {
      const chosen = route.request().postDataJSON().benchmarks || ["S&P 500"];
      comparison = {
        benchmarks: chosen,
        insights: {
          portfolio: {
            name: "Current holdings basket",
            return_pct: 16.8,
            volatility_pct: 22.4,
            max_drawdown_pct: -12,
            beta: 1.15,
            momentum_3m_pct: 8.5,
            momentum_6m_pct: 12.5,
          },
          comparisons: chosen.map((name: string) => ({
            name,
            return_pct: 11.2,
            volatility_pct: 15.3,
            max_drawdown_pct: -8,
            beta: 1,
            momentum_3m_pct: 5,
            momentum_6m_pct: 9,
            excess_return_pp: 5.6,
          })),
          stocks: [
            {
              symbol: "ABC",
              weight_pct: 100,
              volatility_pct: 22.4,
              beta: 1.15,
              momentum_3m_pct: 8.5,
              momentum_6m_pct: 12.5,
              revenue_growth_pct: 10,
              earnings_growth_pct: 12,
              free_cash_flow: 200000,
              financial_period: "2025-12-31",
              quality_status: "HOLD",
              quality_review: "Fixture positive earnings and cash generation",
            },
          ],
          candidates: [
            {
              symbol: "GROW",
              volatility_pct: 18.2,
              momentum_3m_pct: 7,
              momentum_6m_pct: 11,
              revenue_growth_pct: 9,
              earnings_growth_pct: 13,
              free_cash_flow: 100000,
              financial_period: "2025-12-31",
              quality_review: "Fixture research candidate",
            },
          ],
          effective_positions: 1,
          top_three_weight_pct: 100,
          weighted_stock_volatility_pct: 22.4,
          diversification_reduction_pct: 0,
          start_date: "2026-09-10",
          end_date: "2026-09-24",
          methodology: "Fixture metrics for layout testing only.",
        },
        role: "long_term",
        benchmark: chosen[0],
        period: "1y",
        updated_at: "2026-10-10T12:00:00Z",
        sources: [{ symbol: "ABC", source: "TradingView" }],
        curve: Array.from({ length: 15 }, (_, i) => ({
          date: `2026-09-${i + 10}`,
          "Current holdings basket": 100 + i * 1.2,
          ...Object.fromEntries(
            chosen.map((name: string, j: number) => [
              name,
              100 + i * (0.8 + j * 0.2),
            ]),
          ),
        })),
      };
      data = { id: "fixture", status: "completed", result: comparison };
    }
    if (path === "/api/live")
      data = {
        equity_history: [
          { date: "2026-10-09T14:00:00Z", equity: 11000 },
          { date: "2026-10-09T14:15:00Z", equity: 11125 },
        ],
        snapshot: null,
        model: null,
        auto: automation,
        batch: null,
        tickets: [],
      };
    if (path === "/api/paper") data = null;
    if (path === "/api/india/investing/batches") data = [];
    if (path === "/api/india/trading")
      data = {
        broker: null,
        brokers: [],
        scope: null,
        investment_scope: null,
        auto: { enabled: false },
        tickets: [],
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
});

test("desktop tabs preserve the comparison and display consistent market status", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  await expect(page.getByText("INFY", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Benchmark comparison", exact: true })
    .click();
  await page.getByRole("button", { name: "Compare holdings" }).click();
  const graph = page.getByRole("img", {
    name: "Current holdings basket versus the selected benchmark",
  });
  await expect(graph).toBeVisible();
  await page.getByLabel("Period").selectOption("6m");
  await page
    .getByRole("button", { name: "Market learning", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "India market" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-learning.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Benchmark comparison", exact: true })
    .click();
  await expect(graph).toBeVisible();
  await expect(page.getByLabel("Period")).toHaveValue("6m");
  await page.screenshot({
    path: "/private/tmp/varshan-benchmark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "US trading", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Live trading settings" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-trading.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Paper trading", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start paper session" }),
  ).toBeVisible();
  for (const name of ["Recommendations", "Replacements", "Weekly review"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name, exact: true, level: 1 }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Your portfolio at a glance" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Weekly attention" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Weekly changes" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-weekly.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("mobile layout stays within viewport and account controls remain hidden until opened", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/private/tmp/varshan-mobile.png",
    fullPage: true,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Dismiss navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "Market learning", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "India market" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your portfolio at a glance" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "/private/tmp/varshan-weekly-mobile.png",
    fullPage: true,
  });
});

test("weekly portfolios, multiple comparison indices and saved header preferences", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(
    page.getByText("India weekly market event", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Weekly holdings moves" }),
  ).toContainText("INFY.NS");
  const portfolios = page.getByLabel("Weekly portfolio");
  await portfolios.getByRole("button", { name: "US", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Weekly holdings moves" }),
  ).toContainText("ABC");
  await expect(
    page.getByRole("table", { name: "Weekly holdings moves" }),
  ).not.toContainText("INFY.NS");
  await portfolios
    .getByRole("button", { name: "US trading", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Weekly holdings moves" }),
  ).toContainText("TRADE");
  await page.screenshot({
    path: "/private/tmp/varshan-weekly-events.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Benchmark comparison", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Nasdaq-100", exact: true }).check();
  await page.getByRole("checkbox", { name: "Dow Jones", exact: true }).check();
  await page.getByRole("button", { name: "Compare holdings" }).click();
  await expect(
    page.getByRole("heading", {
      name: "S&P 500 · Nasdaq-100 · Dow Jones comparison",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Benchmark risk and momentum" }),
  ).toContainText("Nasdaq-100");
  await expect(
    page.getByRole("table", { name: "Stock risk and quality" }),
  ).toContainText("ABC");
  await expect(
    page.getByRole("table", { name: "Growth research candidates" }),
  ).toContainText("GROW");
  await page.screenshot({
    path: "/private/tmp/varshan-multi-benchmark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open account settings" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: "Nifty 50", exact: true })
    .uncheck();
  await dialog
    .getByRole("checkbox", { name: "Nifty Bank", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Nasdaq-100", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save top-bar benchmarks" }).click();
  await expect(dialog.getByText("Top-bar benchmarks saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".topbar")).toContainText("Nifty Bank");
  await expect(page.locator(".topbar")).toContainText("Nasdaq-100");
  await expect(page.locator(".topbar")).not.toContainText("Nifty 50");
  await page.reload();
  await expect(page.locator(".topbar")).toContainText("Nifty Bank");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});

test("saved privacy, themes and stock charts work across tabs", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  await page.getByRole("link", { name: "INFY", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText("Price chart");
  await expect(
    page.getByRole("img", { name: "INFY price history" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Open account settings" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Theme", { exact: true }).selectOption("midnight");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await dialog.getByLabel("Stock link provider").selectOption("tradingview");
  await expect(dialog.getByLabel("Stock link provider")).toHaveValue(
    "tradingview",
  );
  await dialog.getByLabel("Open stock charts").selectOption("external");
  await expect(dialog.getByLabel("Open stock charts")).toHaveValue("external");
  await dialog.getByRole("checkbox", { name: /Privacy mode/ }).check();
  await expect(
    dialog.getByRole("checkbox", { name: /Privacy mode/ }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Nifty MidSmallCap 400", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save top-bar benchmarks" }).click();
  await expect(dialog.getByText("Top-bar benchmarks saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const holdings = page.getByRole("table", { name: "Holdings" });
  await expect(holdings).toContainText("••••");
  await expect(holdings).not.toContainText("37,000");
  await expect(
    holdings.locator("tbody tr").first().locator("td").nth(2),
  ).toHaveText("••••");
  await expect(
    page.getByRole("button", { name: "Download Holdings" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "INFY", exact: true }).first(),
  ).toHaveAttribute("href", /tradingview.*NSE/);
  await page
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await expect(
    page.getByText("Portfolio review hidden in privacy mode."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Benchmark comparison", exact: true })
    .click();
  await page.getByRole("button", { name: "Compare holdings" }).click();
  await expect(
    page.getByText("Portfolio graph hidden in privacy mode."),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-privacy-midnight.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await page.getByRole("button", { name: "Holdings", exact: true }).click();
  await expect(page.getByRole("table", { name: "Holdings" })).toContainText(
    "••••",
  );
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("forest");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await page.getByRole("checkbox", { name: /Privacy mode/ }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: /Privacy mode/ }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "US trading", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Live trading account value" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-forest.png",
    fullPage: true,
  });
});

test("Kite login returns to the original workspace and clears callback tokens", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Weekly review", exact: true })
    .click();
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByRole("button", { name: "Get Kite login link" }).click();
  const link = page.getByRole("link", { name: /Continue to Kite login/ });
  await expect(link).toBeVisible();
  await expect(link).not.toHaveAttribute("target", "_blank");
  const loginUrl = new URL((await link.getAttribute("href"))!);
  const params = new URLSearchParams(
    loginUrl.searchParams.get("redirect_params")!,
  );
  expect(params.get("varshan_return_page")).toBe("weekly");
  // Simulate the broker callback, with no real broker connection or credentials.
  await page.goto(
    `/?request_token=fixture-token&status=success&${params.toString()}`,
  );
  await expect(
    page.getByText("Kite connected. You’re back in your workspace."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekly review", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("request_token");
  expect(page.url()).not.toContain("varshan_kite_state");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Weekly review", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("curated theme previews save and render on desktop and mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  for (const [id, name] of [
    ["light", "Porcelain"],
    ["midnight", "Midnight"],
    ["forest", "Botanical"],
    ["obsidian", "Obsidian"],
    ["aurora", "Aurora"],
    ["sandstone", "Sandstone"],
    ["dark", "Dark"],
    ["forest-dark", "Forest at night"],
  ]) {
    const option = page.getByRole("button", { name: `Use ${name} theme` });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await page.screenshot({ path: `/private/tmp/varshan-theme-${id}.png` });
  }
  await page.getByRole("button", { name: "Use Aurora theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.screenshot({
    path: "/private/tmp/varshan-aurora-workspace.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(
    page.getByRole("button", { name: "Use Aurora theme" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-theme-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("failed Kite returns show a usable login error without retaining URL tokens", async ({
  page,
}) => {
  await page.goto(
    "/?request_token=fixture&varshan_kite_state=expired&varshan_return_page=weekly&status=success",
  );
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Kite login expired. Start a new login."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Get Kite login link" }),
  ).toBeEnabled();
  expect(page.url()).not.toContain("request_token");
  expect(page.url()).not.toContain("varshan_kite_state");
});

test("phone pairing keeps portfolio requests gated until authenticated", async ({
  page,
}) => {
  let paired = false;
  await page.route("**/api/access/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: paired,
        local: false,
        secure: true,
      }),
    }),
  );
  await page.route("**/api/access/pair", (route) => {
    paired = route.request().postDataJSON().code === "123456";
    return route.fulfill({
      status: paired ? 200 : 400,
      contentType: "application/json",
      body: JSON.stringify(
        paired ? { authenticated: true } : { detail: "Incorrect code" },
      ),
    });
  });
  const portfolioRequests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/portfolios")
      portfolioRequests.push(r.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#pair=123456");
  await expect(
    page.getByRole("heading", { name: "Pair your phone" }),
  ).toBeVisible();
  expect(portfolioRequests).toEqual([]);
  await expect(page.getByLabel("Pairing code")).toHaveValue("123456");
  expect(page.url()).not.toContain("pair=");
  await page.getByRole("button", { name: "Open my workspace" }).click();
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  expect(portfolioRequests.length).toBeGreaterThan(0);
  await page.screenshot({
    path: "/private/tmp/varshan-mobile-paired.png",
    fullPage: true,
  });
});

test("backend-session confirmation sends explicit authorization and keeps the Stop control visible", async ({
  page,
}) => {
  const payloads: any[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/live/automation")
      payloads.push(r.postDataJSON());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "US trading", exact: true }).click();
  await page
    .getByRole("button", { name: "Start automatic trading", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("including while your browser is closed");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Confirm real orders" }).click();
  await expect(
    page.getByText(/Backend trading session is active until/),
  ).toBeVisible();
  expect(payloads[0]).toMatchObject({
    enabled: true,
    acknowledged: true,
    background: true,
  });
  await page.getByRole("button", { name: /Stop automatic trading/ }).click();
  await expect(
    page.getByRole("button", { name: "Start automatic trading", exact: true }),
  ).toBeVisible();
});

test("mobile setup, service worker and notification subscription work without caching private data", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
      expirationTime: null,
      keys: { p256dh: "fixture-public-key", auth: "fixture-auth" },
    };
    let saved: object | null = null;
    Object.defineProperty(PushManager.prototype, "getSubscription", {
      value: async () => saved,
    });
    Object.defineProperty(PushManager.prototype, "subscribe", {
      value: async () => {
        saved = {
          ...subscription,
          toJSON: () => subscription,
          unsubscribe: async () => {
            saved = null;
            return true;
          },
        };
        return saved;
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(
    page.getByRole("link", { name: "https://10.1.2.3:8443", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate pairing code" }).click();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Scan to pair your phone with Varshan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Scan to install the phone certificate" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enable notifications on this device" })
    .click();
  await expect(
    page.getByText("Trading notifications enabled on this device."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(
    page.getByText("Test notification queued for this device."),
  ).toBeVisible();
  const worker = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, active: !!r.active, caches: await caches.keys() };
  });
  expect(worker.active).toBe(true);
  expect(worker.caches).toEqual([]);
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  expect((await page.request.get("/icons/varshan-192.png")).status()).toBe(200);
  await page.screenshot({
    path: "/private/tmp/varshan-mobile-settings.png",
    fullPage: true,
  });
});

test("incomplete Kite callback responses stay recoverable instead of crashing the workspace", async ({
  page,
}) => {
  await page.goto(
    "/?request_token=no-page&varshan_kite_state=fixture-state&varshan_return_page=weekly&status=success",
  );
  await expect(
    page.getByRole("heading", { name: "Weekly review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Kite connected. You’re back in your workspace."),
  ).toBeVisible();
  await page.goto(
    "/?request_token=bad-result&varshan_kite_state=fixture-state&varshan_return_page=weekly&status=success",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Kite did not confirm the connection.",
  );
  await expect(
    page.getByRole("heading", { name: "Let’s reopen your workspace" }),
  ).toHaveCount(0);
});

test("cancelled fingerprint approval keeps privacy enabled and holdings masked", async ({
  page,
}) => {
  await page.route("**/api/preferences", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().privacy_mode === false
    ) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Touch ID verification was cancelled. Nothing was changed.",
        }),
      });
    } else await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  const privacy = page.getByRole("checkbox", { name: /Privacy mode/ });
  await privacy.check();
  await expect(privacy).toBeEnabled();
  await privacy.uncheck();
  await expect(
    page.getByText("Touch ID verification was cancelled. Nothing was changed."),
  ).toBeVisible();
  await expect(privacy).toBeChecked();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("table", { name: "Holdings" })).toContainText(
    "••••",
  );
});

test("an existing phone blocks new pairing until desktop access is revoked", async ({
  page,
}) => {
  let connected = true;
  await page.route("**/api/mobile/setup", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        urls: ["https://10.1.2.3:8443"],
        setup_urls: ["http://10.1.2.3:8080"],
        profile_urls: ["http://10.1.2.3:8080/varshan.mobileconfig"],
        certificate_urls: ["http://10.1.2.3:8080/certificate.cer"],
        connected,
        expires_at: new Date(Date.now() + 12 * 3600000).toISOString(),
      }),
    }),
  );
  await page.route("**/api/mobile/revoke", (route) => {
    connected = false;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ revoked: true }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(
    page.getByRole("button", { name: "Generate pairing code" }),
  ).toBeDisabled();
  await expect(page.getByText(/One phone is connected/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Install iPhone certificate profile" }),
  ).toHaveAttribute("href", "http://10.1.2.3:8080/varshan.mobileconfig");
  await page.getByRole("button", { name: "Revoke all phone access" }).click();
  await expect(
    page.getByRole("button", { name: "Generate pairing code" }),
  ).toBeEnabled();
});

test("phone privacy unlock uses the phone platform authenticator and sends its proof", async ({
  page,
  context,
}) => {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.route("**/api/access/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, local: false, secure: true }),
    }),
  );
  await page.route("**/api/phone-verification/options", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "fixture-challenge",
        kind: "registration",
        options: {
          challenge: btoa(String.fromCharCode(...Array(32).fill(1))).replace(
            /=+$/,
            "",
          ),
          rp: { id: "localhost", name: "Varshan" },
          user: {
            id: btoa(String.fromCharCode(...Array(32).fill(2))).replace(
              /=+$/,
              "",
            ),
            name: "Varshan phone",
            displayName: "Varshan phone",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            userVerification: "required",
          },
          attestation: "none",
          timeout: 60000,
        },
      }),
    }),
  );
  let verified = false;
  await page.route("**/api/phone-verification/verify", (route) => {
    const data = route.request().postDataJSON();
    const client = JSON.parse(
      atob(
        data.response.response.clientDataJSON
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
      ),
    );
    expect(client.type).toBe("webauthn.create");
    expect(client.origin).toBe("http://localhost:8002");
    verified = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ proof: "fixture-phone-approval" }),
    });
  });
  const patches: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/preferences" &&
      request.method() === "POST"
    )
      patches.push(request.postDataJSON());
  });
  await page.goto("http://localhost:8002/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  const privacy = page.getByRole("checkbox", { name: /Privacy mode/ });
  await privacy.check();
  await expect(privacy).toBeEnabled();
  await privacy.uncheck();
  await expect(privacy).toBeEnabled();
  await expect(privacy).not.toBeChecked();
  expect(verified).toBe(true);
  expect(patches).toContainEqual({
    privacy_mode: false,
    verification: "fixture-phone-approval",
  });
});

test("mobile cache encrypts snapshots, restores after reload and clears on revocation", async ({
  page,
}) => {
  let authenticated = true;
  const expires = new Date(Date.now() + 12 * 3600000).toISOString();
  await page.route("**/api/access/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated,
        local: false,
        secure: true,
        cache_id: authenticated ? "fixture-cache-session" : null,
        expires_at: authenticated ? expires : null,
      }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          new Promise<boolean>((resolve) => {
            const r = indexedDB.open("varshan-mobile-cache", 1);
            r.onsuccess = () => {
              const q = r.result
                .transaction("cache")
                .objectStore("cache")
                .get("snapshot");
              q.onsuccess = () => resolve(!!q.result?.encrypted);
            };
          }),
      ),
    )
    .toBe(true);
  const snapshot = await page.evaluate(
    () =>
      new Promise<{ encrypted: boolean; scope: string; expires: number }>(
        (resolve, reject) => {
          const r = indexedDB.open("varshan-mobile-cache", 1);
          r.onerror = () => reject(String(r.error));
          r.onblocked = () => reject("IDB blocked");
          r.onsuccess = () => {
            const q = r.result
              .transaction("cache")
              .objectStore("cache")
              .get("snapshot");
            q.onerror = () => reject(String(q.error));
            q.onsuccess = () => {
              resolve({
                encrypted: q.result?.encrypted instanceof ArrayBuffer,
                scope: q.result?.scope ?? "missing",
                expires: q.result?.expires ?? 0,
              });
            };
          };
        },
      ),
  );
  expect(snapshot).toEqual({
    encrypted: true,
    scope: "fixture-cache-session",
    expires: Date.parse(expires),
  });
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "varshan_preferences",
  );
  expect(cookie?.value).toContain("theme");
  expect(cookie?.value).not.toContain("holdings");
  await page.route("**/api/portfolios", (route) => {
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Fixture temporarily unavailable" }),
    });
  });
  await page.reload();
  await expect(page.getByRole("table", { name: "Holdings" })).toBeVisible();
  // Fresh snapshots are attempted after the normal query freshness interval.
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByRole("button", { name: "Unpair this device" }).click();
  authenticated = false;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Pair your phone" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          new Promise<boolean>((resolve) => {
            const r = indexedDB.open("varshan-mobile-cache", 1);
            r.onsuccess = () => {
              const q = r.result
                .transaction("cache")
                .objectStore("cache")
                .get("snapshot");
              q.onsuccess = () => resolve(!q.result);
            };
          }),
      ),
    )
    .toBe(true);
});

test("forest scenery survives dark-mode switching and reload on desktop and phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  await page.getByRole("button", { name: "Use Botanical theme" }).click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator(".forest-atmosphere")).toBeVisible();
  await expect(page.locator(".forest-retreat")).toBeVisible();
  await expect(page.locator(".forest-detail-icon").first()).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-forest-day.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "forest-dark",
  );
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "forest-dark",
  );
  await page.screenshot({
    path: "/private/tmp/varshan-forest-night.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".forest-atmosphere")).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/varshan-forest-phone.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
});

test("old backends cannot receive unsupported themes and settings sections navigate", async ({
  page,
}) => {
  let theme = "light";
  const submitted: string[] = [];
  await page.route("**/api/preferences", (route) => {
    if (route.request().method() === "POST") {
      theme = route.request().postDataJSON().theme ?? theme;
      submitted.push(theme);
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        theme,
        top_benchmarks: ["Nifty 50"],
        catalog: [],
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Restart Varshan and refresh/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Use Dark theme", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Use Forest at night theme" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use Botanical theme" }).click();
  await expect(
    dialog.getByRole("switch", { name: "Dark mode" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Use Midnight theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  expect(submitted).toEqual(["forest", "midnight"]);
  await dialog
    .getByRole("button", { name: "Mobile & security", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Download phone identity certificate" }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeInViewport();
  await dialog
    .getByRole("button", { name: "Appearance & privacy", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Use Midnight theme" }),
  ).toBeInViewport();
  await page.screenshot({
    path: "/private/tmp/varshan-settings-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/private/tmp/varshan-settings-phone.png",
    animations: "disabled",
  });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});

import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });
for (const market of ["India", "US"] as const) {
  test(`${market} shortlist Buy reviews only the chosen stock and requires final consent`, async ({
    page,
  }) => {
    const sent: { path: string; body: any }[] = [];
    const scope = "a".repeat(20);
    const us: any = {
      scope,
      snapshot: null,
      auto: { enabled: false },
      batch: null,
      tickets: [],
      model: {
        shortlist: [{ symbol: "AAA" }, { symbol: "BBB" }],
        actions: ["AAA", "BBB"].map((symbol) => ({
          symbol,
          side: "buy",
          action: "BUY",
          enabled: true,
          dollar_amount: "25.00",
          reason: "Confirmed breakout",
        })),
      },
    };
    const india: any = {
      broker: "groww",
      brokers: [
        { id: "groww", name: "Groww", connected: true, ending: "••••1234" },
      ],
      scope,
      investment_scope: scope,
      configured: true,
      settings_revision: 7,
      indices: ["Nifty 50", "Nifty 100"],
      settings: {
        budget: 100000,
        reserve_pct: 10,
        selection_mode: "automatic",
        index: "Nifty 50",
        symbols: [],
      },
      auto: { enabled: false },
      phase: "Market open",
      snapshot: {
        user: "••••1234",
        cash: 100000,
        positions: [],
        updated_at: new Date().toISOString(),
      },
      signals: {
        fresh: true,
        message: "Ready",
        asof: new Date().toISOString(),
        shortlist: [
          { symbol: "AAA", relative_volume: 2 },
          { symbol: "BBB", relative_volume: 2 },
        ],
      },
      actions: ["AAA", "BBB"].map((symbol) => ({
        symbol,
        side: "buy",
        action: "BUY",
        enabled: true,
        quantity: 5,
        price: 1000,
        reason: "Confirmed breakout",
      })),
      tickets: [],
      history: [],
      error: null,
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let value: any = {};
      if (path === "/api/bootstrap") value = { token: "fixture" };
      if (path === "/api/health") value = { status: "ok", app: "varshan" };
      if (path === "/api/access/status")
        value = { local: true, authenticated: true };
      if (["/api/markets", "/api/indices"].includes(path)) value = [];
      if (path === "/api/accounts")
        value = {
          roles: {
            long_term: { selected: false },
            trading: { selected: true, ending: "1234", scope },
          },
          live_settings: { budget: 100, reserve_pct: 10 },
          kite_connected: false,
        };
      if (path === "/api/preferences")
        value = {
          theme: "forest",
          privacy_mode: false,
          top_benchmarks: [],
          catalog: [],
        };
      if (path === "/api/live") value = us;
      if (path === "/api/paper") value = null;
      if (path === "/api/india/trading") value = india;
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        sent.push({ path, body });
        if (path === "/api/live/preview") {
          us.batch = {
            id: "single-buy",
            status: "preview",
            buy_symbol: body.symbol,
            ticket_ids: ["chosen"],
          };
          us.tickets = [
            {
              id: "old",
              arguments: { symbol: "AAA", side: "sell", quantity: "1" },
            },
            {
              id: "chosen",
              status: "preview",
              arguments: {
                symbol: body.symbol,
                side: "buy",
                dollar_amount: "25.00",
              },
              stop: "95",
              target: "110",
            },
          ];
          value = us;
        } else if (path === "/api/india/trading/preview")
          value = {
            id: "chosen",
            status: "preview",
            symbol: body.symbol,
            side: "buy",
            quantity: 5,
            price: 1000,
          };
        else {
          us.batch = us.batch ? { ...us.batch, status: "completed" } : null;
          value = market === "US" ? us : india;
        }
        value = { id: "job", status: "completed", result: value };
      }
      await route.fulfill({ json: value });
    });
    await page.goto(
      `/?workspace=${market === "India" ? "india-trading" : "trading"}`,
    );
    if (market === "US")
      await page.getByRole("button", { name: "Later", exact: true }).click();
    const table = page.getByRole("table", {
      name: market === "India" ? "India shortlisted stocks" : "Live decisions",
    });
    await table.getByRole("button", { name: "Buy BBB", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: market === "US" ? /Confirm US BUY BBB/ : "Confirm India BUY BBB",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("AAA", { exact: true })).toHaveCount(0);
    expect(sent).toEqual([
      {
        path:
          market === "US" ? "/api/live/preview" : "/api/india/trading/preview",
        body:
          market === "US"
            ? { symbol: "BBB", expected_scope: scope }
            : {
                symbol: "BBB",
                side: "buy",
                expected_scope: scope,
                expected_revision: 7,
                expected_broker: "groww",
              },
      },
    ]);
    const confirm = dialog.getByRole("button", {
      name: "Confirm real orders",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await page.screenshot({
      path: `/private/tmp/varshan-${market.toLowerCase()}-shortlist-buy-desktop.png`,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `/private/tmp/varshan-${market.toLowerCase()}-shortlist-buy.png`,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toEqual({
      path:
        market === "US"
          ? "/api/live/batches/single-buy/confirm"
          : "/api/india/trading/orders/chosen/confirm",
      body: { acknowledged: true },
    });
  });
}

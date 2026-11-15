import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { scope, rolesFile } from "../src/brokers/accounts.js";
import { comparisonIdentity } from "../src/workspaces.js";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
function isolatedService() {
  const saved = new Map<string, any>();
  mock.method(store, "json", (path: string, fallback: any) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: any) => {
    saved.set(path, structuredClone(value));
  });
  mock.method(store, "csv", () => []);
  return {
    service: new Service(false, {
      comparisons: {},
      batch: null,
      india_draft: null,
    }),
    saved,
  };
}
const options = { headers: { host: "127.0.0.1:8000" } };
test("Gems research accepts supported markets with local authorization and cannot create a trading draft", async () => {
  const { service } = isolatedService();
  const calls: string[] = [];
  mock.method(service, "analyzeGems", async (market: string) => {
    calls.push(market);
    return { candidates: 0 };
  });
  const app = await createApp(service);
  try {
    const token = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": token };
    assert.equal(
      (
        await app.inject({
          ...options,
          url: "/api/analysis/India/gems",
          method: "POST",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          headers,
          url: "/api/analysis/invalid/gems",
          method: "POST",
        })
      ).statusCode,
      422,
    );
    for (const market of ["India", "US"])
      assert.equal(
        (
          await app.inject({
            headers,
            url: `/api/analysis/${market}/gems`,
            method: "POST",
          })
        ).statusCode,
        200,
      );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["India", "US"]);
    assert.equal(
      (
        await app.inject({
          headers,
          url: "/api/kite/draft",
          method: "POST",
          payload: { strategy: "gems" },
        })
      ).statusCode,
      422,
    );
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("linking an order receipt requires explicit confirmation and a local authenticated request", async () => {
  const { service } = isolatedService();
  const calls: unknown[][] = [];
  mock.method(service, "linkLiveOrder", async (...args: unknown[]) => {
    calls.push(args);
    return {};
  });
  const app = await createApp(service);
  try {
    const token = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": token };
    const url = "/api/live/tickets/ticket/link";
    assert.equal(
      (
        await app.inject({
          ...options,
          url,
          method: "POST",
          payload: { order_id: "receipt", acknowledged: true },
        })
      ).statusCode,
      403,
    );
    for (const payload of [
      { order_id: "receipt" },
      { order_id: "receipt", acknowledged: false },
      { order_id: "", acknowledged: true },
    ]) {
      assert.equal(
        (await app.inject({ headers, url, method: "POST", payload }))
          .statusCode,
        422,
      );
    }
    assert.deepEqual(calls, []);
    const response = await app.inject({
      headers,
      url,
      method: "POST",
      payload: { order_id: "receipt", acknowledged: true },
    });
    assert.equal(response.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["ticket", "receipt", true]]);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("local API security, strict schemas and static React delivery", async () => {
  const { service } = isolatedService(),
    app = await createApp(service);
  try {
    assert.deepEqual(
      (await app.inject({ ...options, url: "/api/health" })).json(),
      { status: "ok", app: "varshan" },
    );
    const boot = await app.inject({ ...options, url: "/api/bootstrap" }),
      token = boot.json().token;
    assert.equal(boot.headers["cache-control"], "no-store");
    assert.equal(
      (
        await app.inject({
          url: "/api/health",
          headers: { host: "evil.example" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...options,
          url: "/api/bootstrap",
          headers: { host: "127.0.0.1:8000", origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...options,
          method: "POST",
          url: "/api/live/settings",
          payload: { budget: 1000, reserve_pct: 10 },
        })
      ).statusCode,
      403,
    );
    const headers = { ...options.headers, "x-varshan-token": token };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/live/settings",
          headers,
          payload: { budget: -1, reserve_pct: 10 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/live/settings",
          headers,
          payload: { budget: 1000, reserve_pct: 10, account: "OTHER" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/live/batches/anything/confirm",
          headers,
          payload: { acknowledged: false },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await app.inject({ ...options, url: "/api/missing" })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ ...options, url: "/brand/varshan-logo.svg" }))
        .statusCode,
      200,
    );
    const spa = await app.inject({ ...options, url: "/benchmark" });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.body, /<div id="root">/);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("paper controls work through HTTP without invoking a brokerage", async () => {
  const { service } = isolatedService(),
    app = await createApp(service);
  try {
    const token = (
        await app.inject({ ...options, url: "/api/bootstrap" })
      ).json().token,
      headers = { ...options.headers, "x-varshan-token": token };
    assert.equal(
      (await app.inject({ ...options, url: "/api/paper" })).json(),
      null,
    );
    const control = async (action: string) =>
      app.inject({
        method: "POST",
        url: "/api/paper/control",
        headers,
        payload: { action, budget: 10000, reserve_pct: 10 },
      });
    const started = await control("start");
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().status, "Running");
    assert.equal(started.json().cash, 10000);
    assert.deepEqual(started.json().positions, {});
    assert.equal((await control("start")).statusCode, 400);
    assert.equal((await control("pause")).json().status, "Paused");
    assert.equal((await control("resume")).json().status, "Running");
    assert.equal((await control("end")).json().status, "Ended");
    assert.equal((await control("resume")).statusCode, 400);
    assert.equal(
      (await app.inject({ ...options, url: "/api/live" })).json().auto.enabled,
      false,
    );
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("jobs deduplicate in-flight work and expose failures without retrying", async () => {
  const { service } = isolatedService();
  try {
    let release!: () => void,
      calls = 0;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const a = service.job("test", async () => {
        calls++;
        await pending;
        return { ok: true };
      }),
      b = service.job("test", () => {
        throw new Error("must not run");
      });
    assert.equal(a.id, b.id);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(service.jobStatus(a.id).status, "completed");
    const fail = service.job("fail", () => {
      throw new Error("expected failure");
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(service.jobStatus(fail.id).status, "failed");
    assert.equal(service.jobStatus(fail.id).error, "expected failure");
  } finally {
    await service.close();
    mock.restoreAll();
  }
});
test("automation requires acknowledgment, active lease and a distinct saved trading account", async () => {
  const { service, saved } = isolatedService();
  try {
    await assert.rejects(service.setAuto(true, "missing", true), /active/);
    service.touch("connection", true);
    await assert.rejects(service.setAuto(true, "connection", false), /Confirm/);
    await assert.rejects(service.setAuto(true, "connection", true), /budget/);
    const rolesPath = [...saved.keys()].find((p) =>
      p.endsWith("account_roles.json"),
    );
    assert.equal(rolesPath, undefined);
    assert.equal((await service.setAuto(false, "", false)).enabled, false);
  } finally {
    await service.close();
    mock.restoreAll();
  }
});
test("without a saved enabled choice, restart stops old batches and keeps automation off", async () => {
  const initial: Row = {
    comparisons: {},
    batch: {
      id: "b",
      automatic: true,
      account: "123",
      status: "waiting_sales",
    },
    india_draft: null,
  };
  isolatedService();
  const service = new Service(false, initial);
  try {
    assert.equal(initial.batch.status, "stopped");
    assert.equal(service.liveView().auto.enabled, false);
  } finally {
    await service.close();
    mock.restoreAll();
  }
});

test("saved Python comparison survives restart and unavailable fresh holdings", async () => {
  const { saved } = isolatedService();
  saved.set(rolesFile, { long_term: "LONG", trading: "TRADE" });
  const id = comparisonIdentity("trading"),
    comparison = {
      scope: scope("TRADE"),
      role: "trading",
      holdings: [["A", 3]],
      curve: [
        { date: "2026-10-01", "Current holdings basket": 100, "S&P 500": 100 },
      ],
    };
  const service = new Service(false, {
    comparisons: { [id]: comparison },
    batch: null,
  });
  try {
    const result = service.comparison("trading")!;
    assert.equal(result.scope, scope("TRADE"));
    assert.deepEqual(result.curve, comparison.curve);
    assert.equal(result.holdings_changed, true);
    saved.set(rolesFile, { long_term: "LONG", trading: "OTHER" });
    assert.equal(service.comparison("trading"), null);
  } finally {
    await service.close();
    mock.restoreAll();
  }
});

test("WebSocket authentication, invalidations and disconnect revoke automatic consent", async () => {
  const { service, saved } = isolatedService(),
    app = await createApp(service);
  saved.set(rolesFile, { long_term: "LONG", trading: "TRADE" });
  const settingsPath = rolesFile.replace(
    "account_roles.json",
    `live_trading_settings_${scope("TRADE")}.json`,
  );
  saved.set(settingsPath, {
    version: 1,
    account_number: "TRADE",
    budget: 10000,
    reserve_pct: 10,
  });
  await app.ready();
  const token = (await app.inject({ ...options, url: "/api/bootstrap" })).json()
    .token;
  const socket = await app.injectWS("/api/stream", {
    headers: { host: "127.0.0.1:8000", origin: "http://127.0.0.1:8000" },
  });
  const message = () =>
    new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket timed out")),
        1000,
      );
      socket.once("message", (raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(raw.toString()));
      });
    });
  try {
    let next = message();
    socket.send(JSON.stringify({ token }));
    const hello = await next;
    assert.equal(hello.type, "connected");
    assert.equal(
      (await service.setAuto(true, hello.connection, true)).enabled,
      true,
    );
    next = message();
    socket.send(JSON.stringify({ type: "heartbeat", live: true }));
    assert.deepEqual((await next).topics, ["live", "paper", "markets"]);
    // Backend changes reach a connected dashboard without waiting for the
    // five-second heartbeat or the fallback HTTP poll.
    next = message();
    (service as any).publishLive();
    assert.deepEqual((await next).topics, ["live"]);
    next = message();
    (service as any).publishLive("india-trading");
    (service as any).publishLive();
    assert.deepEqual(
      (await next).topics,
      ["india-trading", "live"],
      "coalescing must retain both changed markets",
    );
    next = message();
    (service as any).publishLive("india-trading");
    assert.deepEqual((await next).topics, ["india-trading"]);
    socket.terminate();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.liveView().auto.enabled, false);
    await assert.rejects(
      service.setAuto(true, hello.connection, true),
      /active/,
    );
  } finally {
    socket.terminate();
    await app.close();
    mock.restoreAll();
  }
});

test("appearance preferences patch independently, persist and validate before saving", async () => {
  const { service } = isolatedService();
  const app = await createApp(service);
  try {
    const token = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": token };
    // Exercise service persistence without involving broker connections.
    service.savePreferences({
      privacy_mode: true,
      theme: "midnight",
      chart_provider: "tradingview",
      chart_view: "external",
    });
    service.savePreferences(["Nifty MidSmallCap 400"]);
    assert.equal(service.preferences().privacy_mode, true);
    assert.equal(service.preferences().theme, "midnight");
    assert.equal(
      service
        .preferences()
        .catalog.find((i) => i.name === "Nifty MidSmallCap 400")?.region,
      "India",
    );
    assert.equal(
      service
        .preferences()
        .catalog.find((i) => i.name === "Nifty MidSmallCap 400")?.ticker,
      "NSE:NIFTYMIDSML400",
    );
    const invalid = await app.inject({
      headers,
      method: "POST",
      url: "/api/preferences",
      payload: { theme: "invalid" },
    });
    assert.notEqual(invalid.statusCode, 200);
    assert.equal(service.preferences().theme, "midnight");
    const snapshot = {
      account_number: "TEST",
      updated_at: "2026-10-09T14:00:00Z",
      portfolio: { total_value: "1000" },
    };
    (service as any).snapshot = snapshot;
    (service as any).recordEquity();
    const writesBeforeView = (store.save as any).mock.callCount();
    service.liveView();
    service.liveView();
    assert.equal(
      (store.save as any).mock.callCount(),
      writesBeforeView,
      "GET live status must not write to disk",
    );
    const histories = (service as any).state.equity_histories;
    assert.equal(histories[scope("TEST")].length, 1);
    assert.deepEqual(histories[scope("TEST")][0], {
      date: snapshot.updated_at,
      equity: 1000,
    });
    (service as any).snapshot = {
      ...snapshot,
      account_number: "OTHER",
      updated_at: "2026-10-09T14:01:00Z",
    };
    (service as any).recordEquity();
    service.liveView();
    assert.equal(histories[scope("TEST")].length, 1);
    assert.equal(histories[scope("OTHER")].length, 1);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});

test("Kite login restores its initiating workspace and consumes its return state once", async () => {
  const { service } = isolatedService();
  mock.method(store, "setting", (name: string) =>
    name === "KITE_API_KEY" ? "fixture-key" : "fixture-secret",
  );
  let exchanges = 0;
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.kite.trade/session/token");
    exchanges++;
    return new Response(
      JSON.stringify({
        status: "success",
        data: { access_token: "fixture-access-token" },
      }),
      { status: 200 },
    );
  });
  const app = await createApp(service);
  try {
    const csrf = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": csrf };
    const login = await app.inject({
      ...options,
      url: "/api/kite/login?return_page=weekly",
    });
    assert.equal(login.statusCode, 200);
    const url = new URL(login.json().url);
    const params = new URLSearchParams(
      url.searchParams.get("redirect_params")!,
    );
    assert.equal(params.get("varshan_return_page"), "weekly");
    const state = params.get("varshan_kite_state");
    assert.ok(state && state.length >= 32);
    const callback = { request_token: "fixture-request-token", state };
    const started = await app.inject({
      headers,
      method: "POST",
      url: "/api/kite/callback",
      payload: callback,
    });
    assert.equal(started.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    const job = (
      await app.inject({ ...options, url: `/api/jobs/${started.json().id}` })
    ).json();
    assert.equal(job.status, "completed");
    assert.deepEqual(job.result, { connected: true, return_page: "weekly" });
    const repeat = await app.inject({
      headers,
      method: "POST",
      url: "/api/kite/callback",
      payload: callback,
    });
    assert.equal(repeat.statusCode, 400);
    assert.equal(exchanges, 1);
    assert.equal(
      (
        await app.inject({
          ...options,
          url: "/api/kite/login?return_page=https://evil.example",
        })
      ).statusCode,
      422,
    );
    const next = new URL(
      (
        await app.inject({
          ...options,
          url: "/api/kite/login?return_page=benchmark",
        })
      ).json().url,
    );
    const nextState = new URLSearchParams(
      next.searchParams.get("redirect_params")!,
    ).get("varshan_kite_state");
    const now = Date.now();
    mock.method(Date, "now", () => now + 11 * 60_000);
    assert.equal(
      (
        await app.inject({
          headers,
          method: "POST",
          url: "/api/kite/callback",
          payload: { request_token: "fixture", state: nextState },
        })
      ).statusCode,
      400,
    );
    assert.equal(exchanges, 1);
    for (const theme of [
      "obsidian",
      "aurora",
      "sandstone",
      "dark",
      "forest-dark",
    ]) {
      assert.equal(
        (
          await app.inject({
            headers,
            method: "POST",
            url: "/api/preferences",
            payload: { theme },
          })
        ).statusCode,
        200,
      );
      assert.equal(service.preferences().theme, theme);
    }
  } finally {
    await app.close();
    mock.restoreAll();
  }
});

test("background automation survives browser disconnect, binds its account and retains its original expiry", async () => {
  const { service, saved } = isolatedService();
  saved.set(rolesFile, { long_term: "LONG", trading: "TRADE" });
  saved.set(
    rolesFile.replace(
      "account_roles.json",
      `live_trading_settings_${scope("TRADE")}.json`,
    ),
    { version: 1, account_number: "TRADE", budget: 1000, reserve_pct: 10 },
  );
  const notices: string[] = [];
  service.setNotifier((_id, title) => notices.push(title));
  try {
    service.touch("desktop", true);
    await assert.rejects(
      service.setAuto(true, "desktop", false, true),
      /Confirm/,
    );
    await service.setAuto(true, "desktop", true, true);
    service.disconnect("desktop");
    assert.equal(service.liveView().auto.enabled, true);
    assert.equal(service.liveView().auto.background, true);
    (service as any).consent({ automatic: true });
    saved.set(rolesFile, { long_term: "LONG", trading: "OTHER" });
    assert.throws(
      () => (service as any).consent({ automatic: true }),
      /account changed/,
    );
    saved.set(rolesFile, { long_term: "LONG", trading: "TRADE" });
    (service as any).auto.expires_at = Date.now() - 1;
    assert.throws(
      () => (service as any).consent({ automatic: true }),
      /expired/,
    );
    await service.setAuto(false, "", false, true);
    assert.equal(service.liveView().auto.enabled, false);
    assert.deepEqual(notices, [
      "Automatic trading started",
      "Automatic trading paused",
    ]);
  } finally {
    await service.close();
    mock.restoreAll();
  }
});

test("US shortlist previews accept one symbol and account scope, reject client order amounts, and keep legacy rebalance previews", async () => {
  const { service } = isolatedService(),
    app = await createApp(service);
  const calls: unknown[] = [];
  mock.method(service, "previewLive", async (...args: unknown[]) => {
    calls.push(args);
    return {};
  });
  try {
    const token = (
      await app.inject({ ...options, url: "/api/bootstrap" })
    ).json().token;
    const headers = { ...options.headers, "x-varshan-token": token };
    const url = "/api/live/preview";
    assert.equal(
      (
        await app.inject({
          ...options,
          url,
          method: "POST",
          payload: { symbol: "BBB" },
        })
      ).statusCode,
      403,
    );
    for (const payload of [
      { symbol: "BBB", dollar_amount: 999999 },
      { symbol: "BBB", side: "sell" },
      { symbol: "bad/symbol" },
      { symbol: "BBB", expected_scope: "wrong" },
    ])
      assert.equal(
        (await app.inject({ url, headers, method: "POST", payload }))
          .statusCode,
        422,
      );
    assert.equal(calls.length, 0);
    const chosen = await app.inject({
      url,
      headers,
      method: "POST",
      payload: { symbol: "BBB", expected_scope: "a".repeat(20) },
    });
    assert.equal(chosen.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["BBB", "a".repeat(20)]]);
    assert.equal(
      (await app.inject({ url, headers, method: "POST", payload: {} }))
        .statusCode,
      200,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls[1], [undefined, undefined]);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});

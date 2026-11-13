import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { gemsPlan, reviewCurrent } from "../src/brokers/gems-plan.js";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";
import { createApp } from "../src/app.js";

const now = Date.parse("2026-11-11T22:00:00Z");
const rows = (): Row[] =>
  Array.from({ length: 12 }, (_, i) => ({
    symbol: "GEM" + i,
    sector: "Sector" + Math.floor(i / 2),
    price: 101,
    price_date: "2026-11-11",
    gems_version: 2,
    gems_candidate: true,
    financial_currency: "USD",
    price_currency: "USD",
    scanned_at: new Date(now).toISOString(),
  }));
const review = (): Row => ({
  policy_notes: "Reviewed current policy exposure and regulatory risks.",
  management_notes:
    "Reviewed governance, returns and capital allocation history.",
  vision_notes: "Reviewed the five-year growth plan and execution risks.",
  source_urls: ["https://www.sec.gov/edgar/search/"],
  acknowledged: true,
  reviewed_at: new Date(now).toISOString(),
});
test("Gems model keeps eight slots, reserve, sector caps and rounded staged amounts", () => {
  const plan = gemsPlan(rows(), 10000, 10, {}, now);
  assert.equal(plan.picks.length, 8);
  assert.equal(plan.proposed_investment_usd, 9000);
  assert.equal(plan.target_cash_usd, 1000);
  assert.equal(plan.ready_initial_usd, 0);
  assert.equal(plan.picks[0].target_usd, 1125);
  assert.equal(plan.picks[0].initial_usd, 450);
  assert.equal(plan.picks[0].after_30_days_usd, 337.5);
  assert.ok(plan.picks[0].suggested_shares * 101 <= 1125);
  const concentrated = gemsPlan(
    rows().map((r) => ({ ...r, sector: "Technology" })),
    10000,
    10,
    {},
    now,
  );
  assert.equal(concentrated.picks.length, 2);
  assert.equal(concentrated.target_cash_usd, 7750);
  assert.equal(
    gemsPlan(rows().slice(0, 1), 10000, 10, {}, now).target_cash_usd,
    8875,
  );
  assert.equal(gemsPlan(rows(), 10000, 100, {}, now).target_cash_usd, 10000);
  const rounded = gemsPlan(rows(), 333.33, 10, {}, now);
  for (const pick of rounded.picks)
    assert.ok(
      Math.abs(
        pick.initial_usd +
          pick.after_30_days_usd +
          pick.after_60_days_usd -
          pick.target_usd,
      ) < 1e-8,
    );
  assert.ok(
    Math.abs(
      rounded.proposed_investment_usd + rounded.target_cash_usd - 333.33,
    ) < 1e-8,
  );
});
test("only complete, unexpired reviews unlock research quantities, with a stable saved schedule", () => {
  const r = review(),
    plan = gemsPlan(rows(), 10000, 10, { GEM0: r }, now + 60000, now);
  assert.equal(plan.ready_initial_usd, 450);
  assert.match(plan.picks[0].qualitative_status, /investor attestation/);
  assert.equal(
    plan.schedule[1].earliest,
    new Date(now + 30 * 86400000).toISOString(),
  );
  for (const patch of [
    { acknowledged: false },
    { management_notes: "" },
    { source_urls: [] },
    { source_urls: ["javascript:alert(1)"] },
    { reviewed_at: "invalid" },
    { reviewed_at: new Date(now + 1).toISOString() },
  ])
    assert.equal(reviewCurrent({ ...r, ...patch }, now), false);
  assert.equal(reviewCurrent(r, now + 90 * 86400000), false);
  assert.equal(
    gemsPlan(
      rows(),
      10000,
      10,
      {
        GEM0: {
          ...r,
          reviewed_at: new Date(now - 90 * 86400000).toISOString(),
        },
      },
      now,
    ).ready_initial_usd,
    0,
  );
});
test("stale, rejected, duplicate and incomplete candidate evidence cannot create targets", () => {
  assert.equal(gemsPlan(rows(), 10000, 10, {}, now + 86400000).picks.length, 0);
  for (const patch of [
    { gems_candidate: false },
    { gems_version: null },
    { price: NaN },
    { price: 0 },
    { sector: null },
    { price_currency: "INR" },
    { scanned_at: "invalid" },
  ])
    assert.equal(
      gemsPlan([{ ...rows()[0], ...patch }], 10000, 10, {}, now).picks.length,
      0,
    );
  assert.equal(
    gemsPlan([rows()[0], rows()[0]], 10000, 10, {}, now).picks.length,
    1,
  );
  assert.equal(gemsPlan([], 10000, 10, {}, now).picks.length, 0);
  assert.equal(
    gemsPlan(
      [rows()[0], { ...rows()[1], scanned_at: "invalid" }],
      10000,
      10,
      {},
      now,
    ).picks.length,
    1,
  );
  assert.throws(() => gemsPlan(rows(), -1, 10, {}, now));
  assert.throws(() => gemsPlan(rows(), 10000, 101, {}, now));
});
test("saved Gems plans remain account-bound and the review API rejects tampering", async () => {
  mock.timers.enable({ apis: ["Date"], now });
  const saved = new Map<string, Row>();
  saved.set(rolesFile, { long_term: "INVEST1", trading: "TRADE" });
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    saved.set(path, structuredClone(value)),
  );
  mock.method(store, "csv", () => []);
  const service = new Service(false, {
    comparisons: {},
    batch: null,
    india_draft: null,
  });
  const reviewCalls: Row[] = [];
  mock.method(service, "saveGemsReview", (input: Row) => {
    reviewCalls.push(input);
    return {};
  });
  const app = await createApp(service);
  try {
    const headers = { host: "127.0.0.1:8000" },
      token = (await app.inject({ url: "/api/bootstrap", headers })).json()
        .token;
    const auth = { ...headers, "x-varshan-token": token };
    assert.equal(
      (await app.inject({ url: "/api/us/gems/plan", headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/us/gems/plan",
          headers,
          method: "POST",
          payload: { budget: 10000, reserve_pct: 10 },
        })
      ).statusCode,
      403,
    );
    for (const payload of [
      { budget: -1, reserve_pct: 10 },
      { budget: 10000, reserve_pct: 101 },
      { budget: 10000, reserve_pct: 10, place_orders: true },
    ])
      assert.equal(
        (
          await app.inject({
            url: "/api/us/gems/plan",
            headers: auth,
            method: "POST",
            payload,
          })
        ).statusCode,
        422,
      );
    const payload: Row = { symbol: "GEM0", ...review() };
    delete payload.reviewed_at;
    assert.equal(
      (
        await app.inject({
          url: "/api/us/gems/reviews",
          headers: auth,
          method: "POST",
          payload: { ...payload, acknowledged: false },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/us/gems/reviews",
          headers: auth,
          method: "POST",
          payload: { ...payload, source_urls: ["http://example.com"] },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/us/gems/reviews",
          headers: auth,
          method: "POST",
          payload: { ...payload, reviewed_at: new Date(now).toISOString() },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/us/gems/reviews",
          headers: auth,
          method: "POST",
          payload,
        })
      ).statusCode,
      200,
    );
    assert.equal(reviewCalls.length, 1);
    assert.equal(reviewCalls[0].reviewed_at, undefined);
    service.saveUsGemsPlan(5000, 20);
    const one = service.usGemsPlan();
    assert.equal(one.budget, 5000);
    saved.set(rolesFile, { long_term: "INVEST2", trading: "TRADE" });
    assert.equal(service.usGemsPlan().saved, false);
    assert.equal(service.usGemsPlan().budget, 10000);
    saved.set(rolesFile, { long_term: "INVEST1", trading: "TRADE" });
    assert.equal(service.usGemsPlan().budget, 5000);
  } finally {
    await app.close();
    mock.restoreAll();
    mock.timers.reset();
  }
});

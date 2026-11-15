import test from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import { nasdaqConstituents } from "../src/analysis.js";

test("Nasdaq constituents skip headers and unrelated tables without losing the first stock", () => {
  const html = `<table><tr><td>WRONG</td></tr></table>
    <table class="wikitable sortable" id="constituents">
    <tbody><tr><th>Ticker</th><th>Company</th></tr>
    <tr><td>ADBE</td><td>Adobe</td></tr>
    <tr><td><a>AAPL</a></td><td>Apple</td></tr>
    <tr><td>BRK.B</td><td>Example share class</td></tr>
    <tr><td>AAPL</td><td>Duplicate</td></tr></tbody></table>`;
  assert.deepEqual(nasdaqConstituents(html), ["ADBE", "AAPL", "BRK-B"]);
});

test("Nasdaq constituents fail closed when the table is absent or empty", () => {
  assert.throws(
    () => nasdaqConstituents("<table></table>"),
    /constituent table/,
  );
  assert.throws(
    () =>
      nasdaqConstituents(
        `<table id='constituents'><tr><th>Ticker</th></tr></table>`,
      ),
    /no usable symbols/,
  );
});

test("India automatic trading loads only NSE EQ Nifty 100 constituents, caches by session day and fails closed", async () => {
  const { mock } = await import("node:test");
  const { indiaTradingUniverse } = await import("../src/analysis.js");
  mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-11T05:00:00Z"),
  });
  const cache = new Map<string, Row>();
  mock.method(store, "json", (path: string, fallback: Row) =>
    structuredClone(cache.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) =>
    cache.set(path, structuredClone(value)),
  );
  let calls = 0,
    unavailable = false,
    malformed = false;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    assert.equal(
      String(input),
      "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv",
    );
    if (unavailable) return new Response("unavailable", { status: 503 });
    return new Response(
      malformed
        ? "Symbol,Series\nONE,EQ\n"
        : "Symbol,Series\n" +
            Array.from({ length: 100 }, (_, i) => `STOCK${i},EQ`).join("\n") +
            "\nSTOCK0,EQ\nNOT-EQUITY,BE\nINVALID/SYMBOL,EQ\n",
    );
  });
  try {
    const symbols = await indiaTradingUniverse();
    assert.equal(symbols.length, 100);
    symbols.push("TAMPERED");
    assert.equal((await indiaTradingUniverse()).length, 100);
    assert.equal(calls, 1);
    mock.timers.tick(86400000);
    unavailable = true;
    await assert.rejects(
      indiaTradingUniverse(),
      /Could not load the Nifty 100/,
    );
    malformed = true;
    unavailable = false;
    await assert.rejects(indiaTradingUniverse(), /incomplete/);
    malformed = false;
    assert.equal((await indiaTradingUniverse()).length, 100);
    assert.equal(calls, 4);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("each India index has an independent durable daily universe and stale caches cannot authorize entries", async () => {
  const { mock } = await import("node:test");
  const { indiaTradingUniverse, indiaIndexCacheFile } =
    await import("../src/analysis.js");
  const { indiaTradingIndices } =
    await import("../src/trading/india-indices.js");
  mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-12T05:00:00Z"),
  });
  let saved: Row = {};
  mock.method(store, "json", (_path: string, fallback: Row) =>
    structuredClone(saved ?? fallback),
  );
  mock.method(store, "save", (path: string, value: Row) => {
    assert.equal(path, indiaIndexCacheFile);
    saved = structuredClone(value);
  });
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const file = new URL(String(input)).pathname.split("/").at(-1);
    const spec = Object.values(indiaTradingIndices).find(
      (s) => s.file === file,
    )!;
    assert.ok(spec);
    calls.push(file!);
    const count = Math.round((spec.min + spec.max) / 2);
    return new Response(
      "Symbol,Series\n" +
        Array.from({ length: count }, (_, i) => `STOCK${i},EQ`).join("\n"),
    );
  });
  try {
    for (const index of Object.keys(
      indiaTradingIndices,
    ) as (keyof typeof indiaTradingIndices)[]) {
      const symbols = await indiaTradingUniverse(index);
      assert.ok(symbols.length >= indiaTradingIndices[index].min);
      assert.deepEqual(await indiaTradingUniverse(index), symbols);
    }
    assert.equal(calls.length, 7);
    assert.equal(Object.keys(saved).length, 7);
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    assert.ok(
      (await indiaTradingUniverse("Nifty 50")).length > 0,
      "same-day cached constituents survive a download outage",
    );
    mock.timers.tick(86400000);
    await assert.rejects(indiaTradingUniverse("Nifty 50"), /offline/);
    saved["Nifty IT"] = { day: "2026-11-13", symbols: ["TAMPERED"] };
    await assert.rejects(indiaTradingUniverse("Nifty IT"), /offline/);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});

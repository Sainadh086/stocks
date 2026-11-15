import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { store, Storage, MAGIC, type Row } from "../src/shared/storage.js";
import { IndiaTrading, indiaTradingFile } from "../src/trading/india.js";
import { credentialsFile } from "../src/brokers/india.js";
import { investmentScope } from "../src/brokers/india-selection.js";

const settings = {
  budget: 25000,
  reserve_pct: 15,
  selection_mode: "automatic" as const,
  index: "Nifty 50" as const,
  symbols: [],
};
let directory = "";
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});
function setup() {
  mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-14T06:00:00Z"),
  });
  directory = mkdtempSync(join(tmpdir(), "india-settings-"));
  const storage = new Storage(directory, () => Buffer.alloc(32, 23));
  const path = (file: string) => join(directory, basename(file));
  mock.method(store, "json", <T>(file: string, fallback: T): T =>
    storage.json(path(file), fallback),
  );
  mock.method(store, "save", (file: string, data: unknown) =>
    storage.save(path(file), data),
  );
  store.save(credentialsFile, {
    groww: { user: "FIRST123", access_token: "fixture" },
    upstox: { user: "SECOND456", access_token: "fixture" },
  });
  let reads = 0,
    orders = 0;
  const sources = {
    snapshot: async () => {
      reads++;
      throw new Error("Broker offline");
    },
    history: async () => {
      throw new Error("Market is closed");
    },
    place: async () => {
      orders++;
      throw new Error("Unexpected live order");
    },
    cancel: async () => {},
  };
  return { storage, path, sources, reads: () => reads, orders: () => orders };
}

test("budget, reserve, index and mode persist encrypted across a cold restart even when the broker is offline", async () => {
  const f = setup(),
    engine = new IndiaTrading(() => {}, f.sources);
  await engine.select("groww");
  const scope = investmentScope()!;
  const result = await engine.configure(settings, {
    broker: "groww",
    scope,
    revision: 0,
  });
  assert.equal(result.settings.budget, 25000);
  assert.equal(result.settings_revision, 1);
  assert.ok(result.settings_saved_at);
  assert.equal(
    f.reads(),
    0,
    "saving a verified account must not require an online broker",
  );
  assert.equal(f.orders(), 0);
  const bytes = readFileSync(f.path(indiaTradingFile));
  assert.ok(bytes.subarray(0, MAGIC.length).equals(MAGIC));
  assert.ok(
    !bytes.includes(Buffer.from("25000")),
    "settings must not be stored in plaintext",
  );
  const restarted = new IndiaTrading(() => {}, f.sources);
  assert.equal(restarted.view().settings.budget, 25000);
  assert.equal(restarted.view().settings.reserve_pct, 15);
  assert.equal(restarted.view().settings.index, "Nifty 50");
  assert.equal(restarted.view().scope, scope);
  await assert.rejects(restarted.refresh(), /Broker offline/);
  assert.equal(restarted.view().settings.budget, 25000);
  await restarted.select("upstox");
  assert.equal(restarted.view().configured, false);
  await restarted.configure({ ...settings, budget: 60000, index: "Nifty IT" });
  await restarted.select("groww");
  assert.equal(restarted.view().settings.budget, 25000);
  assert.equal(restarted.view().settings.index, "Nifty 50");
});

test("outdated revisions and broker/account changes cannot overwrite the confirmed amount", async () => {
  const f = setup(),
    engine = new IndiaTrading(() => {}, f.sources);
  await engine.select("groww");
  const scope = investmentScope()!;
  await engine.configure(settings, { revision: 0, scope, broker: "groww" });
  await assert.rejects(
    engine.configure(
      { ...settings, budget: 80000 },
      { revision: 0, scope, broker: "groww" },
    ),
    /another window/,
  );
  await assert.rejects(
    engine.configure(
      { ...settings, budget: 80000 },
      { revision: 1, scope: "wrong-account", broker: "groww" },
    ),
    /account changed/,
  );
  await assert.rejects(
    engine.configure(
      { ...settings, budget: 80000 },
      { revision: 1, scope, broker: "upstox" },
    ),
    /Broker selection changed/,
  );
  assert.equal(engine.view().settings.budget, 25000);
  assert.equal(new IndiaTrading().view().settings_revision, 1);
  assert.equal(f.orders(), 0);
});

test("a disk write failure cannot acknowledge or activate the new trading limits", async () => {
  const f = setup(),
    engine = new IndiaTrading(() => {}, f.sources);
  await engine.select("groww");
  await engine.configure(settings);
  mock.method(store, "save", () => {
    throw new Error("Disk full");
  });
  await assert.rejects(
    engine.configure({ ...settings, budget: 99999 }),
    /Disk full/,
  );
  assert.equal(engine.view().settings.budget, 25000);
  assert.equal(engine.view().settings_revision, 1);
  assert.equal(
    f.storage.json<Row>(f.path(indiaTradingFile), {}).accounts[
      investmentScope()!
    ].settings.budget,
    25000,
  );
  assert.equal(engine.enabled, false);
  assert.equal(f.orders(), 0);
});

test("cached account and shortlist data survive restart as display-only records while pending orders stay blocked", async () => {
  const f = setup();
  const snapshot = {
    user: "FIRST123",
    cash: 12345,
    positions: [
      {
        symbol: "INFY",
        quantity: 2,
        average_price: 1000,
        realised_pnl: 0,
        pnl: 0,
      },
    ],
    orders: [],
    quotes: {},
    updated_at: new Date().toISOString(),
  };
  const engine = new IndiaTrading(() => {}, {
    ...f.sources,
    snapshot: async () => structuredClone(snapshot),
  });
  await engine.select("groww");
  await engine.configure(settings);
  await engine.refresh();
  const scope = investmentScope()!;
  const saved = store.json<Row>(indiaTradingFile, {});
  saved.accounts[scope].last_scan = {
    asof: new Date().toISOString(),
    shortlist: [{ symbol: "INFY" }],
  };
  saved.accounts[scope].tickets = [
    {
      id: "uncertain",
      status: "unknown",
      symbol: "INFY",
      side: "buy",
      quantity: 2,
      reference: "exact-reference",
      stop: 950,
      target: 1100,
      initial_stop: 950,
    },
  ];
  saved.accounts[scope].risk = { day: "2026-11-13", halted: true };
  store.save(indiaTradingFile, saved);
  const restarted = new IndiaTrading(() => {}, f.sources);
  const view = restarted.view();
  assert.equal(view.snapshot.cached, true);
  assert.equal(view.snapshot.cash, 12345);
  assert.equal(view.signals.fresh, false);
  assert.deepEqual(view.signals.shortlist, [{ symbol: "INFY" }]);
  assert.deepEqual(view.actions, []);
  assert.equal(view.tickets[0].reference, "exact-reference");
  assert.equal(view.tickets[0].stop, 950);
  await assert.rejects(restarted.setAuto(true, true), /Reconcile pending/);
  await assert.rejects(
    restarted.configure({ ...settings, budget: 60000 }),
    /Reconcile pending/,
  );
  await restarted.tick();
  assert.equal(f.orders(), 0);
  assert.equal(restarted.view().tickets[0].status, "unknown");
});

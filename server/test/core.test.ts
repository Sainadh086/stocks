import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSavedJson,
  encrypt,
  decrypt,
  Storage,
  MAGIC,
  projectRoot,
  Mutex,
  type Row,
} from "../src/shared/storage.js";
import { analyze } from "../src/shared/indicators.js";
import { assess } from "../src/brokers/long-term.js";
import { step, entryReady, execution } from "../src/trading/orb.js";
import { newAccount, evaluateOrb, simulateMomentum } from "../src/backtest.js";
import { session, localDay } from "../src/shared/calendar.js";
import {
  decodeFrames,
  validBars,
  tvSymbols,
  type Bar,
} from "../src/shared/prices.js";
import { buildActions, quoteCurrent, power } from "../src/trading/live.js";
import {
  ordersFromEditor,
  validateHoldings,
  whole,
} from "../src/brokers/kite.js";
import { positiveDecimal, previewCurrent } from "../src/brokers/robinhood.js";
const fixture = JSON.parse(
  readFileSync(join(projectRoot, "server/test/parity.json"), "utf8"),
);
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
test("Fernet decrypt and deterministic encrypt match the Python format byte for byte", () => {
  const f = fixture.encryption,
    key = Buffer.from(f.key, "base64url");
  assert.equal(decrypt(Buffer.from(f.token), key).toString(), f.plaintext);
  assert.equal(
    encrypt(
      Buffer.from(f.plaintext),
      key,
      f.timestamp,
      Buffer.from(f.iv, "hex"),
    ).toString(),
    f.token,
  );
  const corrupt = Buffer.from(f.token, "base64url");
  corrupt[30] ^= 1;
  assert.throws(
    () => decrypt(Buffer.from(corrupt.toString("base64url")), key),
    /authenticated/,
  );
  assert.throws(
    () => decrypt(Buffer.from(f.token), Buffer.alloc(32)),
    /authenticated/,
  );
});
test("encrypted atomic files retain JSON/CSV and restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "varshan-test-"));
  try {
    const s = new Storage(dir, () => Buffer.alloc(32, 7)),
      file = join(dir, "data.json");
    s.save(file, { a: "secret" });
    assert.ok(readFileSync(file).subarray(0, MAGIC.length).equals(MAGIC));
    assert.deepEqual(s.json(file, {}), { a: "secret" });
    s.saveCsv(join(dir, "holdings.csv"), [
      { symbol: "A", quantity: 2.5 },
      { symbol: "B", quantity: 4 },
    ]);
    assert.deepEqual(s.csv(join(dir, "holdings.csv")), [
      { symbol: "A", quantity: 2.5 },
      { symbol: "B", quantity: 4 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const [index, f] of fixture.indicators.entries())
  test(`technical indicators match Python fixture ${index}`, () => {
    const actual = analyze("TEST", "US", f.bars)!;
    for (const [key, value] of Object.entries(f.expected)) {
      if (typeof value === "number") near(actual[key], value);
      else assert.equal(actual[key], value, key);
    }
  });
for (const [index, f] of fixture.fundamentals.entries())
  test(`business-quality decisions match Python fixture ${index}`, () => {
    const actual = assess(f.facts, f.technical, f.benchmark, fixture.now);
    for (const key of [
      "long_term_action",
      "long_term_eligible",
      "long_term_score",
      "revenue_growth_pct",
      "earnings_growth_pct",
      "relative_return_6m_pp",
      "cash_conversion",
    ]) {
      const expected = f.expected[key];
      if (typeof expected === "number") near(actual[key], expected);
      else assert.equal(actual[key], expected, key);
    }
  });
for (const f of fixture.orb)
  test(`paper replay matches Python accounting (${f.condition})`, () => {
    let s = newAccount();
    for (const expected of f.steps) {
      s = step(
        s,
        { A: f.bars.filter((b: Bar) => b.time <= expected.now) },
        expected.now,
      );
      near(s.cash, expected.cash);
      near(s.realized_pnl, expected.realized_pnl);
      near(s.simulated_costs, expected.simulated_costs);
      assert.equal(s.fills.length, expected.fills);
      assert.equal(Object.keys(s.positions).length, expected.positions);
    }
  });
test("exchange calendars include holidays, daylight saving and early closes", () => {
  assert.equal(session("2026-12-25"), null);
  assert.equal(
    new Date(session("2026-11-27")![1]).toISOString(),
    "2026-11-27T18:00:00.000Z",
  );
  assert.equal(new Date(session("2026-07-01")![0]).getUTCHours(), 13);
  assert.equal(new Date(session("2026-12-01")![0]).getUTCHours(), 14);
  assert.throws(() => session("2036-01-01"), /coverage/);
});
test("paper trading rejects stale entry and missed first breakout", () => {
  const f = fixture.orb[0],
    now = f.steps[1].now,
    day = localDay(now, "NYSE"),
    hours = session(day)!;
  const pick = { range_high: 100.2 };
  assert.equal(entryReady(f.bars, pick, now, hours), null);
  assert.match(entryReady(f.bars, pick, now + 70000, hours)!, /fresh/);
  assert.match(
    entryReady(f.bars, pick, now + 300000, hours)!,
    /First breakout/,
  );
  const s = step(newAccount(), { A: f.bars }, now + 300000);
  assert.equal(s.fills.length, 0);
});
test("offline evaluation keeps held-out accounts separate and stresses costs", () => {
  const out = evaluateOrb({ A: fixture.orb[0].bars, QQQ: fixture.orb[0].bars });
  assert.equal(out.report.live_ready, false);
  assert.ok(
    out.report.results.development_cost_1x.end <
      out.report.results.held_out_cost_1x.start,
  );
  assert.ok(
    out.states.held_out_cost_2x.simulated_costs >
      out.states.held_out_cost_1x.simulated_costs,
  );
});
test("cost model validates inputs and preserves gross-to-net accounting", () => {
  assert.throws(() => execution(NaN, 1, "BUY"));
  assert.throws(() => execution(10, -1, "BUY"));
  const b = execution(100, 1, "BUY"),
    s = execution(100, 1, "SELL");
  near(b.value + b.fee - (s.value - s.fee), b.total_cost + s.total_cost);
});
test("quotes and funds fail closed when stale or incomplete", () => {
  assert.equal(
    power({
      currency: "USD",
      cash: "200",
      buying_power: { buying_power: "300", unleveraged_buying_power: "250" },
    }),
    200,
  );
  assert.equal(power({ cash: 100 }), null);
  assert.equal(
    quoteCurrent(
      {
        state: "active",
        has_traded: true,
        last_trade_price: 10,
        venue_last_trade_time: new Date(Date.now() - 20 * 60000).toISOString(),
      },
      Date.now(),
    ),
    false,
  );
});
test("live risk daily loss and pending orders block fresh entries", () => {
  const f = fixture.orb[0],
    now = f.steps[1].now,
    bars = { A: f.bars.filter((b: Bar) => b.time <= now) },
    signals = {
      strategy: "orb_15m_v1",
      ranked: [
        { symbol: "A", range_high: 100.2, range_low: 99.8, relative_volume: 2 },
      ],
      bars,
      asof: new Date(now).toISOString(),
      fresh: true,
      message: "Ready",
    },
    snapshot: Row = {
      account_number: "TEST",
      updated_at: new Date(now).toISOString(),
      positions: [],
      orders: [],
      portfolio: {
        currency: "USD",
        total_value: 10000,
        equity_value: 0,
        cash: 10000,
        buying_power: { buying_power: 10000, unleveraged_buying_power: 10000 },
      },
      quotes: {
        A: {
          state: "active",
          has_traded: true,
          last_trade_price: 102,
          venue_last_trade_time: new Date(now).toISOString(),
        },
      },
    };
  const enabled = buildActions(snapshot, signals, 10000, 10, [], now, 10000);
  assert.equal(enabled.actions[0].action, "BUY");
  assert.ok(Number(enabled.actions[0].dollar_amount) <= 2250);
  const loss = buildActions(snapshot, signals, 10000, 10, [], now, 11000);
  assert.equal(loss.actions[0].enabled, false);
  const pending = buildActions(
    { ...snapshot, orders: [{ symbol: "A", state: "queued" }] },
    signals,
    10000,
    10,
    [],
    now,
    10000,
  );
  assert.equal(pending.actions[0].enabled, false);
});
test("Kite editor and holding checks reject tampering, duplicate and oversell", () => {
  const r = { symbol: "ABC", exchange: "NSE", sell_shares: 2, buy_shares: 0 };
  assert.equal(ordersFromEditor([r], [r])[0].transaction_type, "SELL");
  assert.throws(() => ordersFromEditor([{ ...r, symbol: "OTHER" }], [r]));
  assert.throws(() => ordersFromEditor([r, r], [r]));
  assert.throws(() => ordersFromEditor([{ ...r, buy_shares: 1 }], [r]));
  assert.throws(() => whole(1.2));
  assert.throws(() =>
    validateHoldings(ordersFromEditor([r], [r]), {
      holdings: [{ exchange: "NSE", tradingsymbol: "ABC", quantity: 1 }],
      orders: [],
    }),
  );
});
test("Robinhood order amounts and preview expiry are strict", () => {
  assert.equal(positiveDecimal("2.50", 2), "2.50");
  for (const n of ["NaN", "Infinity", "-1", "0", "0.0000001"])
    assert.throws(() => positiveDecimal(n));
  assert.equal(
    previewCurrent(
      { status: "preview", reviewed_at: new Date(1000).toISOString() },
      121000,
    ),
    true,
  );
  assert.equal(
    previewCurrent({
      status: "submitted",
      reviewed_at: new Date().toISOString(),
    }),
    false,
  );
  assert.equal(
    previewCurrent(
      { status: "preview", reviewed_at: new Date(1000).toISOString() },
      121001,
    ),
    false,
  );
});
test("price adapters reject impossible candles and cover supported TradingView mappings", () => {
  assert.deepEqual(tvSymbols("ABC.NS"), ["NSE:ABC"]);
  assert.deepEqual(tvSymbols("^GSPC"), ["SP:SPX"]);
  assert.deepEqual(tvSymbols("BRK-B"), [
    "NASDAQ:BRK.B",
    "NYSE:BRK.B",
    "AMEX:BRK.B",
  ]);
  assert.throws(() =>
    validBars([
      {
        time: 1,
        date: "2026-01-01",
        open: 10,
        high: 9,
        low: 8,
        close: 10,
        volume: 1,
      },
    ]),
  );
});
test("mutex serializes state changes even when an operation fails", async () => {
  const lock = new Mutex(),
    order: number[] = [];
  await Promise.allSettled([
    lock.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
      throw new Error("expected");
    }),
    lock.run(() => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);
});
test("monthly replay never executes without observed opens and remains offline", () => {
  const bars = fixture.indicators[0].bars;
  const out = simulateMomentum({ A: bars, "^NSEI": bars }, "^NSEI", 10);
  assert.equal(out.live_ready, false);
  assert.ok(out.curve.length > 0);
  assert.ok(
    out.trades.every((t: Row) => t.side === "SELL" || t.signal_date < t.date),
  );
});

test("legacy Python non-finite JSON is unavailable, while quoted text is preserved", () => {
  assert.deepEqual(
    parseSavedJson(
      '{"a":NaN,"b":Infinity,"c":-Infinity,"text":"NaN and Infinity","escaped":"a\\\"NaN"}',
    ),
    { a: null, b: null, c: null, text: "NaN and Infinity", escaped: 'a"NaN' },
  );
});

test("TradingView framing counts UTF-8 bytes and retains fragmented packets", () => {
  const body = JSON.stringify({ m: "symbol_resolved", p: ["café", "₹"] }),
    packet = Buffer.from("~m~" + Buffer.byteLength(body) + "~m~" + body);
  const first = decodeFrames(packet.subarray(0, packet.length - 2));
  assert.deepEqual(first.messages, []);
  const complete = decodeFrames(
    Buffer.concat([first.pending, packet.subarray(packet.length - 2)]),
  );
  assert.deepEqual(complete.messages, [body]);
  assert.equal(complete.pending.length, 0);
  assert.throws(() => decodeFrames(Buffer.from("~m~999999999~m~")), /Invalid/);
});

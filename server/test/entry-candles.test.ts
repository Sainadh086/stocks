import test from "node:test";
import assert from "node:assert/strict";
import { validBars, type Bar } from "../src/shared/prices.js";
import { entryReady, step } from "../src/trading/orb.js";
import { Feed } from "../src/trading/live.js";
import { newAccount } from "../src/backtest.js";
import { session, localDay } from "../src/shared/calendar.js";

test("a trailing Yahoo live quote cannot hide a valid completed breakout", () => {
  const hours = session("2026-10-12")!;
  const start = hours[0] + 1200000;
  const now = start + 30000;
  const bar = (time: number, close: number): Bar => ({
    time,
    date: localDay(time, "NYSE"),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  });
  const quotes = [
    bar(start - 600000, 99),
    bar(start - 300000, 101),
    bar(start, 102),
    { ...bar(start + 20000, 102), volume: 0 },
  ];
  const candles = validBars(quotes, 300000);
  assert.equal(entryReady(candles, { range_high: 100 }, now, hours), null);
  assert.equal(candles.at(-1)?.time, start);
  assert.match(
    entryReady(candles, { range_high: 100 }, start + 90000, hours)!,
    /fresh 5-minute/,
  );
});

test("removing live quotes preserves the missed-first-breakout restriction", () => {
  const hours = session("2026-10-12")!;
  const start = hours[0] + 1500000;
  const bars = [900000, 1200000, 1500000].map((offset): Bar => ({
    time: hours[0] + offset,
    date: "2026-10-12",
    open: 101,
    high: 102,
    low: 100,
    close: 101,
    volume: 100,
  }));
  assert.match(
    entryReady(
      validBars(bars, 300000),
      { range_high: 100 },
      start + 30000,
      hours,
    )!,
    /First breakout passed/,
  );
});

function sessionBars(): Bar[] {
  const day = "2026-10-12",
    open = session(day)![0],
    bars: Bar[] = [];
  for (let days = 1, count = 0; count < 10; days++) {
    const date = new Date(open - days * 86400000).toISOString().slice(0, 10);
    const hours = session(date);
    if (!hours) continue;
    count++;
    for (const offset of [0, 300000, 600000])
      bars.push({
        time: hours[0] + offset,
        date,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      });
  }
  for (const offset of [0, 300000, 600000])
    bars.push({
      time: open + offset,
      date: day,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 200,
    });
  bars.push({
    time: open + 900000,
    date: day,
    open: 100,
    high: 103,
    low: 100,
    close: 102,
    volume: 200,
  });
  return bars.sort((a, b) => a.time - b.time);
}

test("a fresh observed quote permits entry after a completed breakout, without inventing a candle", () => {
  const hours = session("2026-10-12")!,
    start = hours[0] + 1200000;
  const bars = sessionBars();
  const quote: Bar = {
    kind: "quote",
    time: start + 20000,
    date: "2026-10-12",
    open: 102,
    high: 102,
    low: 102,
    close: 102,
    volume: 0,
  };
  assert.equal(
    entryReady([...bars, quote], { range_high: 101 }, start + 30000, hours),
    null,
  );
  assert.match(
    entryReady(
      [...bars, { ...quote, time: start + 90000 }],
      { range_high: 101 },
      start + 90000,
      hours,
    )!,
    /fresh/,
  );
  const noBreakout = bars.map((b) => ({ ...b, close: 100 }));
  assert.match(
    entryReady(
      [...noBreakout, quote],
      { range_high: 101 },
      start + 30000,
      hours,
    )!,
    /completed close/,
  );
  const result = step(newAccount(), { A: [...bars, quote] }, start + 30000);
  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].timestamp, new Date(quote.time).toISOString());
  assert.equal(result.fills[0].reference_price, quote.open);
});

test("paper shortlist recovers when startup initially has no usable opening ranges", () => {
  const now = session("2026-10-12")![0] + 1230000;
  const first = step(newAccount(), {}, now);
  assert.equal(first.shortlist.length, 0);
  const next = step(first, { A: sessionBars() }, now);
  assert.equal(next.shortlist[0].symbol, "A");
  assert.match(next.decisions[0].reason, /fresh/);
});

test("feed refreshes shortlist and held stocks promptly after universe warmup, retaining live quotes separately", async () => {
  const now = session("2026-10-12")![0] + 1230000,
    calls: string[] = [];
  const feed = new Feed({
    now: () => now,
    universe: async () => ["A", "B", "C", "D", "E", "F"],
    history: async (symbol, period) => {
      calls.push(`${period}:${symbol}`);
      return {
        bars: sessionBars(),
        source: "fixture",
        adjustment: "none",
        latest_quote: {
          kind: "quote",
          time: now - 1000,
          date: "2026-10-12",
          open: 102,
          high: 102,
          low: 102,
          close: 102,
          volume: 0,
        },
      };
    },
  });
  const signals = await feed.refresh(["F"], now);
  assert.deepEqual(
    signals.ranked.map((p) => p.symbol),
    ["A", "B", "C", "D"],
  );
  assert.equal(signals.bars.A.at(-1)?.kind, "quote");
  assert.equal(signals.fresh, true);
  assert.equal(calls.filter((c) => c === "1d:E").length, 0);
  assert.ok(calls.includes("1d:F"));
  calls.length = 0;
  await feed.refresh([], now);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.startsWith("1d:")));
});

test("an asynchronous refresh returns fresh signals to the paper worker at completion time", async () => {
  const start = session("2026-10-12")![0] + 1230000;
  let now = start;
  const feed = new Feed({
    now: () => now,
    universe: async () => ["A"],
    history: async () => {
      now += 500;
      return {
        bars: sessionBars(),
        source: "fixture",
        adjustment: "none",
        latest_quote: {
          kind: "quote",
          time: now,
          date: "2026-10-12",
          open: 102,
          high: 102,
          low: 102,
          close: 102,
          volume: 0,
        },
      };
    },
  });
  const signals = await feed.refresh([], start);
  assert.ok(Date.parse(signals.asof!) > start);
  assert.equal(signals.fresh, true);
  const paper = step(newAccount(), signals.bars, now);
  assert.equal(paper.shortlist.length, 1);
  assert.equal(paper.fills.length, 1);
});

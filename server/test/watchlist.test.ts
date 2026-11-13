import test from "node:test";
import assert from "node:assert/strict";
import { Watchlist, WATCH_WAIT_MS } from "../src/trading/watchlist.js";
import { step, type Bars } from "../src/trading/orb.js";
import { newAccount } from "../src/backtest.js";
import { session } from "../src/shared/calendar.js";

const day = "2026-10-12",
  open = session(day)![0],
  start = open + 1230000;
const picks = "ABCDEFGH".split("").map((symbol, i) => ({
  symbol,
  range_high: 101,
  range_low: 99,
  relative_volume: 10 - i,
  baseline_sessions: 20,
}));
const symbols = (rows: any[]) => rows.map((p) => p.symbol);
function frames(now: number, breakout?: string): Bars {
  const prior = open + Math.floor((now - open) / 300000) * 300000 - 300000;
  return Object.fromEntries(
    picks.map((p) => [
      p.symbol,
      [
        {
          time: prior,
          date: day,
          open: 100,
          high: 103,
          low: 99,
          close: p.symbol === breakout ? 102 : 100,
          volume: 100,
        },
        {
          kind: "quote" as const,
          time: now - 1000,
          date: day,
          open: 102,
          high: 102,
          low: 102,
          close: 102,
          volume: 0,
        },
      ],
    ]),
  );
}

test("long-waiting candidates rotate after one minute and do not immediately cycle back", () => {
  const list = new Watchlist();
  assert.deepEqual(symbols(list.select(picks, frames(start), day, start)), [
    "A",
    "B",
    "C",
    "D",
  ]);
  assert.deepEqual(
    symbols(
      list.select(
        picks,
        frames(start + WATCH_WAIT_MS - 1),
        day,
        start + WATCH_WAIT_MS - 1,
      ),
    ),
    ["A", "B", "C", "D"],
  );
  const now = start + WATCH_WAIT_MS;
  const next = list.select(picks, frames(now), day, now);
  assert.deepEqual(symbols(next), ["E", "F", "G", "H"]);
  assert.deepEqual(
    next.map((p) => p.replaced_symbol),
    ["A", "B", "C", "D"],
  );
  assert.deepEqual(
    symbols(list.select(picks, frames(now + 15000), day, now + 15000)),
    ["E", "F", "G", "H"],
  );
});

test("a missed breakout is replaced immediately while an eligible entry is retained", () => {
  const immediate = new Watchlist();
  immediate.select(picks, frames(start), day, start);
  const early = start + 300000,
    earlyBars = frames(early);
  earlyBars.A.unshift({
    time: open + 900000,
    date: day,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 100,
  });
  assert.deepEqual(symbols(immediate.select(picks, earlyBars, day, early)), [
    "E",
    "F",
    "G",
    "H",
  ]);
  const list = new Watchlist();
  list.select(picks, frames(start), day, start);
  const now = start + 300000,
    bars = frames(now, "B");
  bars.A.unshift({
    time: open + 900000,
    date: day,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 100,
  });
  const next = list.select(picks, bars, day, now);
  assert.ok(!symbols(next).includes("A"));
  assert.ok(symbols(next).includes("B"));
});

test("expired candidates get a fresh price check before rotation so a just-ready entry is retained", () => {
  const list = new Watchlist();
  list.select(picks, frames(start), day, start);
  const now = start + 300000;
  assert.deepEqual(
    symbols(list.select(picks, frames(now), day, now, [], false)),
    ["A", "B", "C", "D"],
  );
  const selected = list.select(picks, frames(now, "A"), day, now);
  assert.deepEqual(symbols(selected), ["A", "E", "F", "G"]);
});

test("rotation keeps existing candidates when alternatives are unavailable and identifies actual replacements", () => {
  const list = new Watchlist();
  list.select(picks.slice(0, 4), frames(start), day, start);
  const now = start + WATCH_WAIT_MS;
  const unchanged = list.select(picks.slice(0, 4), frames(now), day, now);
  assert.deepEqual(symbols(unchanged), ["A", "B", "C", "D"]);
  assert.equal(unchanged[0].watch_since, new Date(start).toISOString());
  const next = list.select(picks.slice(0, 6), frames(now), day, now);
  assert.deepEqual(symbols(next), ["E", "F", "A", "B"]);
  assert.deepEqual(
    next.slice(0, 2).map((p) => p.replaced_symbol),
    ["C", "D"],
  );
});

test("held and pending symbols are monitored separately and the paper worker uses the same replacement picks", () => {
  const list = new Watchlist(),
    bars = frames(start);
  const selected = list.select(picks, bars, day, start, ["A", "B"]);
  assert.deepEqual(symbols(selected), ["C", "D", "E", "F"]);
  const paper = step(newAccount(), bars, start, selected);
  assert.deepEqual(symbols(paper.shortlist), symbols(selected));
  assert.equal(paper.fills.length, 0);
});

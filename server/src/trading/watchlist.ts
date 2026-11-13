import { session, type Exchange } from "../shared/calendar.js";
import type { Row } from "../shared/storage.js";
import { entryReady, type Bars } from "./orb.js";

export const WATCH_WAIT_MS = 60000;
export class Watchlist {
  constructor(
    private readonly checkEntry = entryReady,
    private readonly exchange: Exchange = "NYSE",
  ) {}
  private day = "";
  private current: Row[] = [];
  private cooldown = new Map<string, number>();

  select(
    candidates: Row[],
    bars: Bars,
    day: string,
    now: number,
    protectedSymbols: string[] = [],
    rotate = true,
  ): Row[] {
    if (this.day !== day) {
      this.day = day;
      this.current = [];
      this.cooldown.clear();
    }
    const hours = session(day, this.exchange);
    if (!hours || now < hours[0] + 900000 || now >= hours[1] - 300000)
      return [];
    const protectedSet = new Set(protectedSymbols);
    const checks = new Map<string, string | null>();
    const check = (p: Row) => {
      if (!checks.has(p.symbol))
        checks.set(p.symbol, this.checkEntry(bars[p.symbol], p, now, hours));
      return checks.get(p.symbol)!;
    };
    const eligible = candidates.filter(
      (p) =>
        !protectedSet.has(p.symbol) &&
        !check(p)?.startsWith("First breakout passed"),
    );
    const pool = new Map(eligible.map((p) => [p.symbol, p]));
    const ready = (p: Row) => check(p) === null;
    const kept = this.current.filter(
      (p) =>
        pool.has(p.symbol) &&
        (!rotate ||
          now - Date.parse(p.watch_since) < WATCH_WAIT_MS ||
          ready(pool.get(p.symbol)!)),
    );
    const removed = this.current.filter(
      (p) => !kept.some((k) => k.symbol === p.symbol),
    );
    const fresh = eligible
      .filter(
        (p) =>
          !kept.some((k) => k.symbol === p.symbol) &&
          !removed.some((r) => r.symbol === p.symbol) &&
          (ready(p) || (this.cooldown.get(p.symbol) ?? 0) <= now),
      )
      .sort((a, b) => Number(ready(b)) - Number(ready(a)));
    const selected: Row[] = kept.map((p) => ({
      ...pool.get(p.symbol)!,
      watch_since: p.watch_since,
      replaced_symbol: p.replaced_symbol,
    }));
    for (const pick of fresh) {
      if (selected.length >= 4) break;
      selected.push({
        ...pick,
        watch_since: new Date(now).toISOString(),
        replaced_symbol: removed[selected.length - kept.length]?.symbol,
      });
    }
    // With no alternative, keep watching rather than cycling the same stock
    // or fabricating a qualifying candidate.
    for (const old of removed) {
      if (selected.length >= 4) break;
      if (pool.has(old.symbol))
        selected.push({
          ...pool.get(old.symbol)!,
          watch_since: old.watch_since,
          replaced_symbol: old.replaced_symbol,
        });
    }
    const retired = removed.filter(
      (old) => !selected.some((p) => p.symbol === old.symbol),
    );
    let replacement = 0;
    for (const pick of selected)
      if (!this.current.some((old) => old.symbol === pick.symbol))
        pick.replaced_symbol = retired[replacement++]?.symbol;
    for (const old of retired)
      this.cooldown.set(old.symbol, now + WATCH_WAIT_MS);
    this.current = selected;
    return structuredClone(selected);
  }
}

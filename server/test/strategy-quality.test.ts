import test from "node:test";
import assert from "node:assert/strict";
import { entryQuality } from "../src/trading/quality.js";

test("identical gross 2R setups can have different US and India viability after costs", () => {
  const us = entryQuality("US", 110, 109.7, 110.6),
    india = entryQuality("India", 110, 109.7, 110.6);
  assert.equal(us.eligible, true);
  assert.equal(india.eligible, false);
  assert.ok(us.net_reward_risk >= 1);
  assert.ok(india.net_reward_risk < 1);
  assert.ok(
    india.estimated_round_trip_cost_pct > us.estimated_round_trip_cost_pct,
  );
});
test("viable larger moves pass in both markets and are invariant to nominal price scale", () => {
  for (const market of ["US", "India"] as const) {
    const a = entryQuality(market, 100, 98, 104),
      b = entryQuality(market, 1000, 980, 1040);
    assert.equal(a.eligible, true);
    assert.ok(a.stressed_reward_risk > 0);
    assert.ok(Math.abs(a.net_reward_risk - b.net_reward_risk) < 1e-10);
    assert.ok(Math.abs(a.risk_per_share * 10 - b.risk_per_share) < 1e-10);
  }
});
test("costly spreads, tight stops and top-ups near the old target cannot manufacture a good trade", () => {
  assert.equal(entryQuality("US", 100, 99.99, 100.02).eligible, false);
  assert.equal(entryQuality("US", 103, 102, 103.2).eligible, false);
  const normal = entryQuality("US", 100, 99.7, 100.6),
    wide = entryQuality("US", 100, 99.7, 100.6, {
      bid_price: 99.8,
      ask_price: 100.2,
    });
  assert.equal(normal.eligible, true);
  assert.equal(wide.eligible, false);
  assert.ok(wide.risk_per_share > normal.risk_per_share);
  for (const [price, stop, target] of [
    [NaN, 98, 104],
    [100, 100, 104],
    [100, 98, 100],
    [Infinity, 98, 104],
    [100, -1, 104],
  ])
    assert.equal(entryQuality("US", price, stop, target).eligible, false);
  assert.equal(
    entryQuality("India", 100, 98, 104, { bid_price: 102, ask_price: 100 })
      .eligible,
    false,
  );
});

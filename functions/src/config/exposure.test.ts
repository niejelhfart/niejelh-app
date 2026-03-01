import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARD_COUNT,
  maxSideLiabilityPerShard,
  ODDS_BPS_SCALE,
  americanOddsToTotalReturnBps,
  parseAmountToMinorUnits,
  projectSideLiabilityMinor,
  shardForUid,
} from "./exposure";

test("exact cap boundary is allowed by projection math", () => {
  // +100 => 2.00x total return => 20000 bps
  const multiplierBps = americanOddsToTotalReturnBps(100);
  assert.equal(multiplierBps, 20_000);
  assert.equal(multiplierBps % ODDS_BPS_SCALE, 0);

  // Exact: liability = stake * 2 - opposite(0) => cap
  const stakeMinor = Math.floor((maxSideLiabilityPerShard * ODDS_BPS_SCALE) / multiplierBps);
  const liability = projectSideLiabilityMinor(stakeMinor, 0, multiplierBps);
  const nextLiability = projectSideLiabilityMinor(stakeMinor + 1, 0, multiplierBps);

  assert.ok(liability <= maxSideLiabilityPerShard);
  assert.ok(nextLiability > maxSideLiabilityPerShard);
});

test("one minor unit over cap is rejected by projection math", () => {
  const multiplierBps = americanOddsToTotalReturnBps(100);
  const stakeAtCap = Math.floor((maxSideLiabilityPerShard * ODDS_BPS_SCALE) / multiplierBps);
  const overStake = stakeAtCap + 1;
  const liability = projectSideLiabilityMinor(overStake, 0, multiplierBps);

  assert.ok(liability > maxSideLiabilityPerShard);
});

test("amount parsing and multiplier conversion remain deterministic integers", () => {
  assert.equal(parseAmountToMinorUnits("1"), 100);
  assert.equal(parseAmountToMinorUnits("1.2"), 120);
  assert.equal(parseAmountToMinorUnits("1.23"), 123);
  assert.equal(parseAmountToMinorUnits("1.234"), NaN);

  const oddsSamples = [100, 140, -110, -200, 250];
  for (const odds of oddsSamples) {
    const bps = americanOddsToTotalReturnBps(odds);
    assert.ok(Number.isInteger(bps));
    assert.ok(bps > 0);
  }
});

test("shard function is stable and bounded", () => {
  const uid = "test-user-123";
  const a = Number(shardForUid(uid));
  const b = Number(shardForUid(uid));
  assert.equal(a, b);
  assert.ok(Number.isInteger(a));
  assert.ok(a >= 0 && a < SHARD_COUNT);
});

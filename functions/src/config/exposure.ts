export const MINOR_UNIT_SCALE = 100; // cents
export const ODDS_BPS_SCALE = 10_000; // basis points for multipliers

// All cap values are defined in minor units (cents).
export const MAX_BET_PER_USER = 10_000 * MINOR_UNIT_SCALE;
export const MAX_USER_OPEN_EXPOSURE = 50_000 * MINOR_UNIT_SCALE;
export const SHARD_COUNT = 64;
export const MAX_SIDE_LIABILITY = 5_000_000; // minor units
export const MAX_MATCH_LIABILITY = 10_000_000; // minor units
export const BUFFER_MULTIPLIER_BPS = 15_000; // 1.50x
export const maxSideLiabilityPerShard = Math.floor(MAX_SIDE_LIABILITY / SHARD_COUNT);
export const maxMatchLiabilityPerShard = Math.floor(MAX_MATCH_LIABILITY / SHARD_COUNT);

export function parseAmountToMinorUnits(input: unknown): number {
  const raw = String(input ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;

  const [wholeRaw, fracRaw = ""] = raw.split(".");
  const whole = Number(wholeRaw);
  const frac = Number((fracRaw + "00").slice(0, 2));
  if (!Number.isInteger(whole) || !Number.isInteger(frac)) return NaN;
  if (whole < 0 || frac < 0 || frac > 99) return NaN;

  return whole * MINOR_UNIT_SCALE + frac;
}

export function minorToMajor(minor: number): number {
  return minor / MINOR_UNIT_SCALE;
}

export function majorToMinor(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return parseAmountToMinorUnits(value.toFixed(2));
}

export function americanOddsToTotalReturnBps(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (!Number.isInteger(odds)) return NaN;

  if (odds > 0) {
    // (100 + odds) / 100 => bps
    return (100 + odds) * 100;
  }

  // (abs(odds) + 100) / abs(odds) => bps, floored to avoid optimistic liability.
  const absOdds = Math.abs(odds);
  return Math.floor(((absOdds + 100) * ODDS_BPS_SCALE) / absOdds);
}

export function stableHash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shardForUid(uid: string): string {
  const shard = stableHash32(uid) % SHARD_COUNT;
  return String(shard);
}

export function projectSideLiabilityMinor(
  sumStakeOnSideMinor: number,
  sumStakeOppositeSideMinor: number,
  oddsMultiplierBps: number
): number {
  if (!Number.isInteger(sumStakeOnSideMinor) || sumStakeOnSideMinor < 0) return NaN;
  if (!Number.isInteger(sumStakeOppositeSideMinor) || sumStakeOppositeSideMinor < 0) return NaN;
  if (!Number.isInteger(oddsMultiplierBps) || oddsMultiplierBps <= 0) return NaN;

  const payoutMinor = Math.floor((sumStakeOnSideMinor * oddsMultiplierBps) / ODDS_BPS_SCALE);
  return payoutMinor - sumStakeOppositeSideMinor;
}

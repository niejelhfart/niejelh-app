import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  MAX_BET_PER_USER,
  MAX_USER_OPEN_EXPOSURE,
  americanOddsToTotalReturnBps,
  majorToMinor,
  maxMatchLiabilityPerShard,
  maxSideLiabilityPerShard,
  minorToMajor,
  parseAmountToMinorUnits,
  projectSideLiabilityMinor,
  shardForUid,
} from "./config/exposure";

admin.initializeApp();

const db = getFirestore();
const nowTS = () => FieldValue.serverTimestamp();
const DEFAULT_OPENING_WALLET = 100;
const RECON_EPSILON = 0.0001;
const INVARIANT_VERSION = 1;
const MAX_TX_ATTEMPTS = 4;

const RETRYABLE_CODE_MAP: Record<string, number> = {
  ABORTED: 10,
  DEADLINE_EXCEEDED: 4,
  INTERNAL: 13,
};

function accountingStateRef(uid: string) {
  return db.doc(`users/${uid}/accounting/state`);
}

type InvariantSeverity = "critical" | "warning" | "info";

type InvariantEventPayload = {
  event: string;
  severity: InvariantSeverity;
  runId?: string;
  requestId?: string;
  uid?: string;
  matchId?: string;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  timestamp?: number;
  [key: string]: unknown;
};

function toInvariantErrorCode(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function isCriticalRuntimeErrorCode(code: string | number | null): boolean {
  if (typeof code === "number") {
    return code === 13 || code === 8 || code === 2;
  }
  if (typeof code === "string") {
    const normalized = code.toLowerCase();
    return (
      normalized === "internal" ||
      normalized === "resource-exhausted" ||
      normalized === "unknown" ||
      normalized === "internal:internal"
    );
  }
  return false;
}

async function emitInvariantEvent(payload: InvariantEventPayload): Promise<void> {
  const errorCode = toInvariantErrorCode(payload.errorCode);
  const eventRecord = {
    ...payload,
    errorCode,
    invariantVersion: INVARIANT_VERSION,
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
  };

  console.log(JSON.stringify(eventRecord));

  if (payload.severity !== "critical") return;

  const rawId = [
    String(eventRecord.event || "invariant_event"),
    String(eventRecord.runId || "no_run"),
    String(eventRecord.requestId || ""),
    String(eventRecord.uid || ""),
    String(eventRecord.matchId || ""),
    String(eventRecord.timestamp || Date.now()),
  ]
    .filter(Boolean)
    .join("_");
  const anomalyId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 500);

  await db.doc(`audit/anomalies/records/${anomalyId}`).set(
    {
      ...eventRecord,
      detectedAt: nowTS(),
      source: eventRecord.event,
    },
    { merge: true }
  );
}

async function assertAccountingVersionMonotonic(params: {
  event: string;
  currentVersion: number;
  nextVersion: number;
  uid?: string;
  matchId?: string;
  requestId?: string;
  runId?: string;
}) {
  const { event, currentVersion, nextVersion, uid, matchId, requestId, runId } = params;
  const currentIsInt = Number.isInteger(currentVersion);
  const nextIsInt = Number.isInteger(nextVersion);
  const monotonic = currentIsInt && nextIsInt && nextVersion > currentVersion;
  if (monotonic) return;

  await emitInvariantEvent({
    event,
    severity: "critical",
    uid,
    matchId,
    requestId,
    runId,
    errorCode: "VERSION_REGRESSION",
    errorMessage: `Invariant violation: non-monotonic accountingVersion (current=${currentVersion}, next=${nextVersion}).`,
  });

  throw new functions.https.HttpsError(
    "failed-precondition",
    "Invariant violation: accounting version must be monotonic."
  );
}

type DuplicateLedgerSideEffectMeta = {
  uid?: string;
  matchId?: string;
  requestId?: string;
  runId?: string;
  betId?: string;
  ledgerEntryId?: string;
  side?: "debit" | "credit";
  source?: string;
};

function duplicateLedgerSideEffectError(meta: DuplicateLedgerSideEffectMeta) {
  const err = new functions.https.HttpsError(
    "internal",
    "Duplicate ledger mutation detected."
  ) as functions.https.HttpsError & {
    duplicateLedgerSideEffect?: DuplicateLedgerSideEffectMeta;
  };
  err.duplicateLedgerSideEffect = meta;
  return err;
}

function isDuplicateLedgerSideEffectError(
  err: unknown
): err is functions.https.HttpsError & { duplicateLedgerSideEffect: DuplicateLedgerSideEffectMeta } {
  return !!(err && typeof err === "object" && "duplicateLedgerSideEffect" in err);
}

// ---------- Helpers ----------
function isAdmin(ctx: functions.https.CallableContext) {
  return !!ctx.auth?.token?.admin;
}

function calcPayout(amount: number, odds: number, didWin: boolean) {
  if (!didWin) return 0;

  // American odds total return (stake + profit)
  // -110 => amount + (amount * 100/110)
  // +150 => amount + (amount * 150/100)
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(odds) || odds === 0) return 0;

  if (odds < 0) return amount + amount * (100 / Math.abs(odds));
  return amount + amount * (odds / 100);
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedErrorCode(err: any): number | null {
  if (typeof err?.code === "number") return err.code;
  if (typeof err?.code === "string") {
    const upper = err.code.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(RETRYABLE_CODE_MAP, upper)) {
      return RETRYABLE_CODE_MAP[upper];
    }
    const maybeNum = Number(err.code);
    if (Number.isFinite(maybeNum)) return maybeNum;
  }
  return null;
}

function isRetryableContentionError(err: any): boolean {
  const code = normalizedErrorCode(err);
  if (code === 10 || code === 4) return true;
  if (code === 13) {
    const msg = String(err?.message || "").toLowerCase();
    return (
      msg.includes("lock timeout") ||
      msg.includes("transaction retry") ||
      msg.includes("transaction lock")
    );
  }
  return false;
}

// ---------- 0) Place bet callable ----------
export const placeBet = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
  }

  const uid = ctx.auth.uid;
  const matchId = String(data?.matchId || "").trim();
  const team = String(data?.team || "").trim();
  const amountMinor = parseAmountToMinorUnits(data?.amount);
  const amount = Number.isInteger(amountMinor) ? minorToMajor(amountMinor) : NaN;
  const idempotencyKey = String(data?.idempotencyKey || "").trim();

  if (!matchId) {
    throw new functions.https.HttpsError("invalid-argument", "matchId required.");
  }
  if (!team) {
    throw new functions.https.HttpsError("invalid-argument", "team required.");
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new functions.https.HttpsError("invalid-argument", "amount must be > 0.");
  }
  if (amountMinor > MAX_BET_PER_USER) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `Bet exceeds max allowed (${minorToMajor(MAX_BET_PER_USER)}).`
    );
  }
  if (!idempotencyKey) {
    throw new functions.https.HttpsError("invalid-argument", "idempotencyKey required.");
  }

  const betRef = db.collection("bets").doc();
  const betId = betRef.id;

  const startedAt = Date.now();
  try {
    const runPlaceBetTransaction = async () =>
      db.runTransaction(async (tx) => {
      const acctRef = accountingStateRef(uid);
      const matchRef = db.doc(`matches/${matchId}`);
      const shardId = shardForUid(uid);
      const shardRef = db.doc(`matches/${matchId}/exposureShards/${shardId}`);
      const userBetRef = db.doc(`users/${uid}/bets/${betId}`);
      const ledgerRef = db.doc(`users/${uid}/ledger/bet_debit_${betId}`);
      const idempotencyRef = db.doc(`users/${uid}/idempotency/${idempotencyKey}`);

      const [acctSnap, matchSnap, idempotencySnap, shardSnap, ledgerEntrySnap] = await Promise.all([
        tx.get(acctRef),
        tx.get(matchRef),
        tx.get(idempotencyRef),
        tx.get(shardRef),
        tx.get(ledgerRef),
      ]);

      if (idempotencySnap.exists) {
        const idempotent = idempotencySnap.data() || {};
        return {
          betId: String(idempotent.betId || ""),
          odds: Number(idempotent.odds || 0),
          replayed: true,
        };
      }

      if (!matchSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Match not found.");
      }

      const matchData = matchSnap.data() || {};
      const matchStatus = String(matchData.status || "");
      if (matchStatus !== "open") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Match already settled or locked."
        );
      }

      const oddsMap = matchData.odds || {};
      if (typeof oddsMap !== "object" || oddsMap === null) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Match odds not configured."
        );
      }
      if (!Object.prototype.hasOwnProperty.call(oddsMap, team)) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid team selection.");
      }

      const canonicalOdds = Number(oddsMap[team]);
      if (!Number.isFinite(canonicalOdds) || canonicalOdds === 0) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Invalid odds configuration."
        );
      }
      const canonicalOddsInt = Number.isInteger(canonicalOdds) ? canonicalOdds : NaN;
      if (!Number.isInteger(canonicalOddsInt)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Invalid odds precision configuration."
        );
      }
      const canonicalMultiplierBps = americanOddsToTotalReturnBps(canonicalOddsInt);
      if (!Number.isInteger(canonicalMultiplierBps) || canonicalMultiplierBps <= 0) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Invalid deterministic multiplier configuration."
        );
      }

      let wallet = 100;
      let accountingVersion = 0;
      let userOpenExposureMinor = 0;

      if (!acctSnap.exists) {
        tx.set(
          acctRef,
          {
            wallet: 100,
            accountingVersion: 0,
            openExposureMinor: 0,
            createdAt: nowTS(),
            updatedAt: nowTS(),
          },
          { merge: true }
        );
      } else {
        const acctData = acctSnap.data() || {};
        wallet = typeof acctData.wallet === "number" ? acctData.wallet : 100;
        accountingVersion =
          typeof acctData.accountingVersion === "number" ? acctData.accountingVersion : 0;
        userOpenExposureMinor =
          typeof acctData.openExposureMinor === "number" &&
          Number.isInteger(acctData.openExposureMinor)
            ? acctData.openExposureMinor
            : 0;

        if (
          typeof acctData.wallet !== "number" ||
          typeof acctData.accountingVersion !== "number" ||
          typeof acctData.openExposureMinor !== "number"
        ) {
          tx.set(
            acctRef,
            {
              wallet,
              accountingVersion,
              openExposureMinor: userOpenExposureMinor,
              updatedAt: nowTS(),
            },
            { merge: true }
          );
        }
      }

      if (wallet < amount) {
        throw new functions.https.HttpsError("failed-precondition", "Insufficient wallet balance.");
      }

      const projectedUserOpenExposureMinor = userOpenExposureMinor + amountMinor;
      if (projectedUserOpenExposureMinor > MAX_USER_OPEN_EXPOSURE) {
        throw new functions.https.HttpsError("failed-precondition", "User open exposure cap exceeded.");
      }

      // Shard side/match caps (transaction-local deterministic integer path).
      const shardData = shardSnap.exists ? (shardSnap.data() || {}) : {};
      const rawStakeByTeam = (shardData.stakeByTeamMinor || {}) as Record<string, unknown>;
      const rawSideLiability = (shardData.sideLiabilityMinor || {}) as Record<string, unknown>;
      const stakeByTeamMinor = new Map<string, number>();
      const sideLiabilityMinor = new Map<string, number>();
      const teamKeys = Object.keys(oddsMap);
      for (const teamKey of teamKeys) {
        const current = Number(rawStakeByTeam[teamKey] ?? 0);
        const currentLiability = Number(rawSideLiability[teamKey] ?? 0);
        stakeByTeamMinor.set(teamKey, Number.isInteger(current) && current > 0 ? current : 0);
        sideLiabilityMinor.set(
          teamKey,
          Number.isInteger(currentLiability) ? currentLiability : 0
        );
      }
      const totalStakeMinor =
        Number.isInteger(shardData.totalStakeMinor) && Number(shardData.totalStakeMinor) > 0
          ? Number(shardData.totalStakeMinor)
          : 0;

      const currentTeamStake = stakeByTeamMinor.get(team) || 0;
      const projectedTeamStake = currentTeamStake + amountMinor;
      const projectedTotalStake = totalStakeMinor + amountMinor;
      const projectedTeamLiability = projectSideLiabilityMinor(
        projectedTeamStake,
        projectedTotalStake - projectedTeamStake,
        canonicalMultiplierBps
      );
      if (!Number.isInteger(projectedTeamLiability)) {
        throw new functions.https.HttpsError("failed-precondition", "Invalid liability projection.");
      }
      if (projectedTeamLiability > maxSideLiabilityPerShard) {
        throw new functions.https.HttpsError("failed-precondition", "Shard side cap exceeded.");
      }
      if (projectedTotalStake > maxMatchLiabilityPerShard) {
        throw new functions.https.HttpsError("failed-precondition", "Shard match cap exceeded.");
      }

      const betData = {
        betId,
        ownerId: uid,
        matchId,
        team,
        odds: canonicalOddsInt,
        amount,
        amountMinor,
        status: "open",
        payout: 0,
        winner: null,
        settledAt: null,
        createdAt: nowTS(),
        updatedAt: nowTS(),
      };

      const nextAccountingVersion = accountingVersion + 1;
      await assertAccountingVersionMonotonic({
        event: "place_bet_version_regression",
        currentVersion: accountingVersion,
        nextVersion: nextAccountingVersion,
        uid,
        matchId,
        requestId: idempotencyKey,
      });

      if (ledgerEntrySnap.exists) {
        throw duplicateLedgerSideEffectError({
          uid,
          matchId,
          requestId: idempotencyKey,
          betId,
          ledgerEntryId: `bet_debit_${betId}`,
          side: "debit",
          source: "placeBet",
        });
      }

      tx.set(
        acctRef,
        {
          wallet: wallet - amount,
          accountingVersion: nextAccountingVersion,
          openExposureMinor: projectedUserOpenExposureMinor,
          updatedAt: nowTS(),
        },
        { merge: true }
      );
      tx.set(
        shardRef,
        {
          totalStakeMinor: projectedTotalStake,
          stakeByTeamMinor: {
            ...Object.fromEntries(stakeByTeamMinor),
            [team]: projectedTeamStake,
          },
          sideLiabilityMinor: {
            ...Object.fromEntries(sideLiabilityMinor),
            [team]: projectedTeamLiability,
          },
          updatedAt: nowTS(),
        },
        { merge: true }
      );

      tx.set(ledgerRef, {
        entryId: `bet_debit_${betId}`,
        ownerId: uid,
        matchId,
        betId,
        type: "bet_debit",
        amountDelta: -amount,
        amount,
        amountMinor,
        odds: canonicalOddsInt,
        team,
        createdAt: nowTS(),
        source: "placeBet",
      });

      tx.set(betRef, betData);
      tx.set(userBetRef, betData);
      tx.set(idempotencyRef, {
        idempotencyKey,
        betId,
        odds: canonicalOddsInt,
        matchId,
        team,
        amount,
        ownerId: uid,
        createdAt: nowTS(),
      });

      return { betId, odds: canonicalOddsInt, replayed: false };
    });

    let result: { betId: string; odds: number; replayed: boolean } | null = null;
    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
      try {
        result = await runPlaceBetTransaction();
        break;
      } catch (err: any) {
        const retryable = isRetryableContentionError(err);
        const exhausted = attempt >= MAX_TX_ATTEMPTS;
        if (!retryable || exhausted) {
          if (retryable && exhausted) {
            console.log(
              JSON.stringify({
                event: "place_bet_retry_exhausted",
                invariantVersion: INVARIANT_VERSION,
                uid,
                matchId,
                team,
                amount,
                attempts: attempt,
                errorCode: normalizedErrorCode(err),
                errorMessage: err?.message || String(err),
                timestamp: Date.now(),
              })
            );
            throw new functions.https.HttpsError(
              "aborted",
              "Transaction contention: max retry attempts exceeded."
            );
          }
          throw err;
        }

        const minDelay = 20 * (2 ** (attempt - 1));
        const maxDelay = minDelay * 2;
        const delayMs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
        console.log(
          JSON.stringify({
            event: "place_bet_retry",
            invariantVersion: INVARIANT_VERSION,
            uid,
            matchId,
            team,
            amount,
            attempt,
            maxAttempts: MAX_TX_ATTEMPTS,
            retryDelayMs: delayMs,
            errorCode: normalizedErrorCode(err),
            errorMessage: err?.message || String(err),
            timestamp: Date.now(),
          })
        );
        await sleepMs(delayMs);
      }
    }

    if (!result) {
      throw new functions.https.HttpsError(
        "aborted",
        "Transaction contention: max retry attempts exceeded."
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        event: "place_bet",
        invariantVersion: INVARIANT_VERSION,
        uid,
        matchId,
        team,
        amount,
        betId: String(result?.betId || ""),
        odds: Number(result?.odds || 0),
        replayed: !!result?.replayed,
        durationMs,
        timestamp: Date.now(),
      })
    );

    return { ...result, message: "Bet placed successfully." };
  } catch (err: any) {
    if (isDuplicateLedgerSideEffectError(err)) {
      const meta = err.duplicateLedgerSideEffect || {};
      await emitInvariantEvent({
        event: "DUPLICATE_LEDGER_SIDE_EFFECT",
        severity: "critical",
        uid: meta.uid,
        matchId: meta.matchId,
        requestId: meta.requestId,
        runId: meta.runId,
        errorCode: "DUPLICATE_LEDGER",
        errorMessage: "Duplicate ledger mutation detected",
        side: meta.side,
        source: meta.source,
        ledgerEntryId: meta.ledgerEntryId,
        betId: meta.betId,
      });
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    const errorCode = toInvariantErrorCode(err?.code);
    await emitInvariantEvent({
      event: "place_bet_failed",
      severity: isCriticalRuntimeErrorCode(errorCode) ? "critical" : "warning",
      uid,
      matchId,
      requestId: idempotencyKey,
      team,
      amount,
      durationMs,
      errorCode,
      errorMessage: err?.message || String(err),
      timestamp: Date.now(),
    });
    throw err;
  }
});

// ---------- 1) Mirror bet on create ----------
export const onBetCreated = functions.firestore
  .document("bets/{betId}")
  .onCreate(async (snap, ctx) => {
    const betId = ctx.params.betId;
    const bet = (snap.data() || {}) as any;

    const ownerId = bet?.ownerId;
    if (!ownerId) {
      console.log("onBetCreated: missing ownerId, betId:", betId);
      return null;
    }

    const userBetRef = db.doc(`users/${ownerId}/bets/${betId}`);

    await userBetRef.set(
      {
        ...bet,
        betId,
        mirroredAt: nowTS(),
      },
      { merge: true }
    );

    console.log("✅ Mirrored bet to user subcollection:", ownerId, betId);
    return null;
  });

// ---------- 2) Keep mirror in sync on update ----------
export const onBetUpdated = functions.firestore
  .document("bets/{betId}")
  .onUpdate(async (change, ctx) => {
    const betId = ctx.params.betId;
    const bet = (change.after.data() || {}) as any;

    const ownerId = bet?.ownerId;
    if (!ownerId) return null;

    const userBetRef = db.doc(`users/${ownerId}/bets/${betId}`);

    await userBetRef.set(
      {
        ...bet,
        betId,
        mirroredAt: nowTS(),
      },
      { merge: true }
    );

    console.log("✅ Updated mirror bet:", ownerId, betId);
    return null;
  });

// ---------- 3) Admin settle callable ----------
// This settles ALL open bets for a match in the canonical /bets collection,
// mirrors settlement fields to /users/{uid}/bets/{betId},
// and credits winners to users/{uid}.wallet
export const settleMatch = functions.https.onCall(async (data, ctx) => {
  if (!ctx.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
  }
  if (!isAdmin(ctx)) {
    throw new functions.https.HttpsError("permission-denied", "Admin only.");
  }

  const matchId = String(data?.matchId || "").trim();
  const winner = String(data?.winner || "").trim();

  if (!matchId) {
    throw new functions.https.HttpsError("invalid-argument", "matchId required.");
  }
  if (!winner) {
    throw new functions.https.HttpsError("invalid-argument", "winner required.");
  }

  const matchRef = db.doc(`matches/${matchId}`);
  const startedAt = Date.now();
  const runId = `settle_${matchId}_${Date.now()}_${ctx.auth.uid}`;
  const CHUNK_SIZE = 80;

  try {
    type SettlementLockResult =
      | {
          replayed: false;
        }
      | {
          replayed: true;
          status: string;
          winner: string | null;
          settlementRunId: string | null;
        };

    // Lock match for this settlement run; preserve strict entry guard: only "open" can start.
    const lockResult: SettlementLockResult = await db.runTransaction(async (tx) => {
      const matchSnap = await tx.get(matchRef);
      if (!matchSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Match not found.");
      }

      const matchStatus = String(matchSnap.get("status") || "");
      if (matchStatus !== "open") {
        return {
          replayed: true,
          status: matchStatus || "unknown",
          winner:
            typeof matchSnap.get("winner") === "string"
              ? String(matchSnap.get("winner"))
              : null,
          settlementRunId:
            typeof matchSnap.get("settlementRunId") === "string"
              ? String(matchSnap.get("settlementRunId"))
              : null,
        };
      }

      const probeQuery = db
        .collection("bets")
        .where("matchId", "==", matchId)
        .where("status", "==", "open")
        .limit(1);
      const probe = await tx.get(probeQuery);
      if (probe.empty) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No open bets found for this match."
        );
      }

      tx.set(
        matchRef,
        {
          status: "settling",
          settlementRunId: runId,
          settlementWinner: winner,
          settlementStartedAt: nowTS(),
          updatedAt: nowTS(),
        },
        { merge: true }
      );
      return { replayed: false };
    });

    if (lockResult.replayed) {
      const durationMs = Date.now() - startedAt;
      await emitInvariantEvent({
        event: "match_settlement_replayed",
        severity: "info",
        matchId,
        uid: ctx.auth?.uid ?? undefined,
        runId,
        errorCode: null,
        errorMessage: `Settlement replay no-op (status=${lockResult.status}).`,
        settlementStatus: lockResult.status,
        settlementRunId: lockResult.settlementRunId,
        winner: lockResult.winner,
        durationMs,
        timestamp: Date.now(),
      });

      return {
        matchId,
        replayed: true,
        status: lockResult.status,
        winner: lockResult.winner,
        settled: 0,
        chunksProcessed: 0,
        message: "Settlement already finalized or in progress; no-op replay.",
      };
    }

    type SettlementPlan = {
      betId: string;
      ownerId: string;
      team: string;
      amount: number;
      amountMinor: number;
      odds: number;
      payout: number;
      didWin: boolean;
      update: {
        status: string;
        payout: number;
        winner: string;
        settledAt: FirebaseFirestore.FieldValue;
        updatedAt: FirebaseFirestore.FieldValue;
      };
    };

    let totalSettled = 0;
    let chunksProcessed = 0;

    while (true) {
      const chunkResult = await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(matchRef);
        const lockStatus = String(lockSnap.get("status") || "");
        const lockRunId = String(lockSnap.get("settlementRunId") || "");
        if (lockStatus !== "settling" || lockRunId !== runId) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "Settlement lock lost or replaced."
          );
        }

        const openBetsQuery = db
          .collection("bets")
          .where("matchId", "==", matchId)
          .where("status", "==", "open")
          .limit(CHUNK_SIZE);
        const snap = await tx.get(openBetsQuery);
        if (snap.empty) {
          return { settled: 0, done: true };
        }

        const plans: SettlementPlan[] = [];
        const owners = new Set<string>();
        const shardIds = new Set<string>();

        for (const betDoc of snap.docs) {
          const betId = betDoc.id;
          const bet = (betDoc.data() || {}) as any;
          const ownerId = bet.ownerId;
          if (!ownerId) continue;

          const betStatus = String(bet.status || "");
          if (betStatus !== "open") continue;
          if (Number(bet.payout || 0) > 0) {
            throw new functions.https.HttpsError("failed-precondition", "Bet already settled.");
          }

          const amount = Number(bet.amount || 0);
          const amountMinor =
            typeof bet.amountMinor === "number" && Number.isInteger(bet.amountMinor)
              ? Number(bet.amountMinor)
              : Number(majorToMinor(amount) || 0);
          const betTeam = String(bet.team || "");
          const odds = Number(bet.odds || 0);
          const didWin = betTeam === winner;
          const payout = calcPayout(amount, odds, didWin);

          const update = {
            status: didWin ? "won" : "lost",
            payout,
            winner,
            settledAt: nowTS(),
            updatedAt: nowTS(),
          };

          owners.add(ownerId);
          shardIds.add(shardForUid(ownerId));
          plans.push({ betId, ownerId, team: betTeam, amount, amountMinor, odds, payout, didWin, update });
        }

        const ownerState = new Map<
          string,
          { wallet: number; accountingVersion: number; openExposureMinor: number }
        >();
        for (const ownerId of owners) {
          const acctSnap = await tx.get(accountingStateRef(ownerId));
          const acctData = acctSnap.exists ? (acctSnap.data() || {}) : {};
          ownerState.set(ownerId, {
            wallet: typeof acctData.wallet === "number" ? acctData.wallet : 0,
            accountingVersion:
              typeof acctData.accountingVersion === "number" ? acctData.accountingVersion : 0,
            openExposureMinor:
              typeof acctData.openExposureMinor === "number" &&
              Number.isInteger(acctData.openExposureMinor)
                ? acctData.openExposureMinor
                : 0,
          });
        }

        const shardState = new Map<
          string,
          {
            totalStakeMinor: number;
            stakeByTeamMinor: Record<string, number>;
            sideLiabilityMinor: Record<string, number>;
          }
        >();
        for (const shardId of shardIds) {
          const shardRef = db.doc(`matches/${matchId}/exposureShards/${shardId}`);
          const shardSnap = await tx.get(shardRef);
          const shardData = shardSnap.exists ? (shardSnap.data() || {}) : {};
          const rawStake = (shardData.stakeByTeamMinor || {}) as Record<string, unknown>;
          const rawLiability = (shardData.sideLiabilityMinor || {}) as Record<string, unknown>;
          const normalizedStake: Record<string, number> = {};
          const normalizedLiability: Record<string, number> = {};
          for (const [k, v] of Object.entries(rawStake)) {
            const n = Number(v);
            normalizedStake[k] = Number.isInteger(n) && n > 0 ? n : 0;
          }
          for (const [k, v] of Object.entries(rawLiability)) {
            const n = Number(v);
            normalizedLiability[k] = Number.isInteger(n) ? n : 0;
          }
          const totalStakeMinor =
            Number.isInteger(shardData.totalStakeMinor) && Number(shardData.totalStakeMinor) > 0
              ? Number(shardData.totalStakeMinor)
              : 0;
          shardState.set(shardId, {
            totalStakeMinor,
            stakeByTeamMinor: normalizedStake,
            sideLiabilityMinor: normalizedLiability,
          });
        }

        const settlementLedgerExistsByBetId = new Map<string, boolean>();
        for (const plan of plans) {
          if (!(plan.didWin && plan.payout > 0)) continue;
          const settlementLedgerRef = db.doc(
            `users/${plan.ownerId}/ledger/settlement_${plan.betId}`
          );
          const settlementLedgerSnap = await tx.get(settlementLedgerRef);
          settlementLedgerExistsByBetId.set(plan.betId, settlementLedgerSnap.exists);
        }

        let settled = 0;
        for (const plan of plans) {
          const settlementLedgerExists = settlementLedgerExistsByBetId.get(plan.betId) === true;
          if (plan.didWin && settlementLedgerExists) {
            throw duplicateLedgerSideEffectError({
              uid: plan.ownerId,
              matchId,
              runId,
              betId: plan.betId,
              ledgerEntryId: `settlement_${plan.betId}`,
              side: "credit",
              source: "settleMatch",
            });
          }

          tx.update(db.doc(`bets/${plan.betId}`), plan.update);
          tx.set(db.doc(`users/${plan.ownerId}/bets/${plan.betId}`), plan.update, { merge: true });

          const state = ownerState.get(plan.ownerId) || {
            wallet: 0,
            accountingVersion: 0,
            openExposureMinor: 0,
          };
          const newOpenExposureMinor = Math.max(0, state.openExposureMinor - Math.max(0, plan.amountMinor));

          if (plan.didWin && plan.payout > 0) {
            const newWallet = state.wallet + plan.payout;
            if (newWallet < 0) {
              throw new functions.https.HttpsError(
                "failed-precondition",
                "Invariant violation: negative wallet."
              );
            }

            const newVersion = state.accountingVersion + 1;
            await assertAccountingVersionMonotonic({
              event: "match_settlement_version_regression",
              currentVersion: state.accountingVersion,
              nextVersion: newVersion,
              uid: plan.ownerId,
              matchId,
              runId,
            });
            ownerState.set(plan.ownerId, {
              wallet: newWallet,
              accountingVersion: newVersion,
              openExposureMinor: newOpenExposureMinor,
            });

            tx.set(
              accountingStateRef(plan.ownerId),
              {
                wallet: newWallet,
                accountingVersion: newVersion,
                openExposureMinor: newOpenExposureMinor,
                updatedAt: nowTS(),
              },
              { merge: true }
            );

            const settlementLedgerRef = db.doc(`users/${plan.ownerId}/ledger/settlement_${plan.betId}`);
            tx.set(
              settlementLedgerRef,
              {
                entryId: `settlement_${plan.betId}`,
                ownerId: plan.ownerId,
                matchId,
                betId: plan.betId,
                type: "settlement_credit",
                amountDelta: plan.payout,
                amount: plan.amount,
                odds: plan.odds,
                winner,
                createdAt: nowTS(),
                source: "settleMatch",
              },
              { merge: true }
            );
          } else {
            ownerState.set(plan.ownerId, {
              wallet: state.wallet,
              accountingVersion: state.accountingVersion,
              openExposureMinor: newOpenExposureMinor,
            });
            tx.set(
              accountingStateRef(plan.ownerId),
              {
                openExposureMinor: newOpenExposureMinor,
                updatedAt: nowTS(),
              },
              { merge: true }
            );
          }

          const shardId = shardForUid(plan.ownerId);
          const currentShard = shardState.get(shardId) || {
            totalStakeMinor: 0,
            stakeByTeamMinor: {},
            sideLiabilityMinor: {},
          };
          const currentTeamStake = Number(currentShard.stakeByTeamMinor[plan.team] || 0);
          const newTeamStake = Math.max(0, currentTeamStake - Math.max(0, plan.amountMinor));
          const newTotalStake = Math.max(0, currentShard.totalStakeMinor - Math.max(0, plan.amountMinor));
          const multiplierBps = americanOddsToTotalReturnBps(Number(plan.odds || 0));
          const newTeamLiability = Number.isInteger(multiplierBps) && multiplierBps > 0
            ? projectSideLiabilityMinor(newTeamStake, Math.max(0, newTotalStake - newTeamStake), multiplierBps)
            : 0;
          const nextStakeByTeam = { ...currentShard.stakeByTeamMinor, [plan.team]: newTeamStake };
          const nextLiabilityByTeam = {
            ...currentShard.sideLiabilityMinor,
            [plan.team]: Number.isInteger(newTeamLiability) ? newTeamLiability : 0,
          };
          shardState.set(shardId, {
            totalStakeMinor: newTotalStake,
            stakeByTeamMinor: nextStakeByTeam,
            sideLiabilityMinor: nextLiabilityByTeam,
          });
          tx.set(
            db.doc(`matches/${matchId}/exposureShards/${shardId}`),
            {
              totalStakeMinor: newTotalStake,
              stakeByTeamMinor: nextStakeByTeam,
              sideLiabilityMinor: nextLiabilityByTeam,
              updatedAt: nowTS(),
            },
            { merge: true }
          );

          settled++;
        }

        return { settled, done: false };
      });

      totalSettled += Number(chunkResult.settled || 0);
      chunksProcessed++;
      if (chunkResult.done) break;
    }

    await db.runTransaction(async (tx) => {
      const finalSnap = await tx.get(matchRef);
      const finalStatus = String(finalSnap.get("status") || "");
      const finalRunId = String(finalSnap.get("settlementRunId") || "");
      if (finalStatus !== "settling" || finalRunId !== runId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Settlement finalize lock mismatch."
        );
      }

      tx.set(
        matchRef,
        {
          matchId,
          status: "settled",
          winner,
          settledAt: nowTS(),
          updatedAt: nowTS(),
          settlementRunId: FieldValue.delete(),
          settlementWinner: FieldValue.delete(),
          settlementStartedAt: FieldValue.delete(),
        },
        { merge: true }
      );
    });

    const result = {
      settled: totalSettled,
      chunksProcessed,
      message: `Settled ${totalSettled} bet(s) in ${chunksProcessed} chunk(s).`,
    };

    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        event: "match_settlement",
        invariantVersion: INVARIANT_VERSION,
        matchId,
        adminUid: ctx.auth?.uid ?? null,
        settledCount: Number(result?.settled || 0),
        chunksProcessed: Number(result?.chunksProcessed || 0),
        durationMs,
        timestamp: Date.now(),
      })
    );

    return result;
  } catch (err: any) {
    if (isDuplicateLedgerSideEffectError(err)) {
      const meta = err.duplicateLedgerSideEffect || {};
      await emitInvariantEvent({
        event: "DUPLICATE_LEDGER_SIDE_EFFECT",
        severity: "critical",
        uid: meta.uid,
        matchId: meta.matchId,
        requestId: meta.requestId,
        runId: meta.runId,
        errorCode: "DUPLICATE_LEDGER",
        errorMessage: "Duplicate ledger mutation detected",
        side: meta.side,
        source: meta.source,
        ledgerEntryId: meta.ledgerEntryId,
        betId: meta.betId,
      });
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    const errorCode = toInvariantErrorCode(err?.code);
    await emitInvariantEvent({
      event: "match_settlement_failed",
      severity: isCriticalRuntimeErrorCode(errorCode) ? "critical" : "warning",
      matchId,
      uid: ctx.auth?.uid ?? undefined,
      runId,
      durationMs,
      errorCode,
      errorMessage: err?.message || String(err),
      timestamp: Date.now(),
    });
    throw err;
  }
});

// ---------- 4) Scheduled reconciliation ----------
export const reconcileLedgerScheduled = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (context) => {
    let checked = 0;
    let mismatches = 0;
    let invalidUsers = 0;
    const runId = String(context.eventId || Date.now());
    const startedAt = Date.now();

    let lastUserDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    const pageSize = 300;

    while (true) {
      let q: FirebaseFirestore.Query = db
        .collection("users")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);

      if (lastUserDoc) {
        q = q.startAfter(lastUserDoc);
      }

      const usersSnap = await q.get();
      if (usersSnap.empty) break;

      for (const userDoc of usersSnap.docs) {
        const uid = userDoc.id;
        const userData = userDoc.data() || {};
        const acctSnap = await accountingStateRef(uid).get();
        const acctData = acctSnap.exists ? (acctSnap.data() || {}) : {};
        const wallet = Number(
          acctSnap.exists ? acctData.wallet : userData.wallet
        );
        const accountingVersion = Number(
          acctSnap.exists ? acctData.accountingVersion : userData.balanceVersion || 0
        );

        const ledgerSnap = await db.collection(`users/${uid}/ledger`).get();
        const entryCount = ledgerSnap.size;
        let ledgerSum = 0;
        let invalidDeltaCount = 0;

        for (const entry of ledgerSnap.docs) {
          const delta = Number(entry.data()?.amountDelta);
          if (Number.isFinite(delta)) ledgerSum += delta;
          else invalidDeltaCount++;
        }

        const openingWallet = Number(
          Number.isFinite(userData.openingWallet) ? userData.openingWallet : DEFAULT_OPENING_WALLET
        );
        const expectedWallet = openingWallet + ledgerSum;
        const drift = wallet - expectedWallet;
        const versionDrift = accountingVersion - entryCount;

        const invalidWallet = !Number.isFinite(wallet);
        if (invalidWallet || invalidDeltaCount > 0) {
          invalidUsers++;
        }

        if (invalidWallet || invalidDeltaCount > 0 || Math.abs(drift) > RECON_EPSILON) {
          mismatches++;
          const anomalyPayload = {
            type: "LEDGER_MISMATCH",
            source: "reconcileLedgerScheduled",
            invariantVersion: INVARIANT_VERSION,
            wallet,
            expectedWallet,
            ledgerSum,
            openingWallet,
            drift,
            accountingVersion,
            versionDrift,
            entryCount,
            invalidDeltaCount,
            checkedAt: Date.now(),
          };

          await emitInvariantEvent({
            event: "LEDGER_MISMATCH",
            severity: "critical",
            runId,
            uid,
            errorCode: "LEDGER_MISMATCH",
            errorMessage: "Wallet and ledger parity drift exceeded epsilon or invalid data detected.",
            ...anomalyPayload,
          });
        }

        checked++;
      }

      lastUserDoc = usersSnap.docs[usersSnap.docs.length - 1];
      if (usersSnap.size < pageSize) break;
    }

    const durationMs = Date.now() - startedAt;
    await db.doc(`audit/anomalies/runs/${runId}`).set(
      {
        type: "LEDGER_RECON_SUMMARY",
        source: "reconcileLedgerScheduled",
        invariantVersion: INVARIANT_VERSION,
        runId,
        checked,
        mismatches,
        invalidUsers,
        epsilon: RECON_EPSILON,
        defaultOpeningWallet: DEFAULT_OPENING_WALLET,
        durationMs,
        checkedAt: Date.now(),
        createdAt: nowTS(),
      },
      { merge: true }
    );

    console.log(
      "LEDGER_RECON_SUMMARY",
      JSON.stringify({
        type: "LEDGER_RECON_SUMMARY",
        source: "reconcileLedgerScheduled",
        invariantVersion: INVARIANT_VERSION,
        runId,
        checked,
        mismatches,
        invalidUsers,
        epsilon: RECON_EPSILON,
        defaultOpeningWallet: DEFAULT_OPENING_WALLET,
        durationMs,
        checkedAt: Date.now(),
      })
    );

    return null;
  });

/**
 * Keep your admin endpoint (don’t delete it).
 * This export expects you to have functions/src/makeAdmin.ts
 */
export { makeAdmin } from "./makeAdmin";

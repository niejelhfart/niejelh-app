import fs from "node:fs/promises";
import path from "node:path";
import admin from "firebase-admin";

const DEFAULTS = {
  target: "emulator",
  projectId: process.env.GCLOUD_PROJECT || "fusionapp-13e36",
  apiKey: process.env.API_KEY || process.env.FIREBASE_API_KEY || "",
  usersFile: "",
  noSignup: false,
  seed: "fusion-n2-flood",
  maxInflight: 100,
  users: 100,
  phase1BetsPerUser: 10,
  phase2LogicalBets: 300,
  phase2BurstMin: 3,
  phase2BurstMax: 5,
  phase3SeedBets: 200,
  phase3SettleCalls: 5,
  phase4LogicalBets: 200,
  minBet: 1,
  maxBet: 25,
  teamA: "TeamA",
  teamB: "TeamB",
  oddsA: -110,
  oddsB: 140,
  startingWallet: 50000,
  outSummary: "artifacts/sim-n2-summary.json",
  outLog: "artifacts/sim-n2.log",
};

const EPSILON = 0.0001;
const EMULATOR_API_KEY = "fake-api-key";
const DEFAULT_AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const DEFAULT_FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
let FUNCTIONS_BASE = "";

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    if (k === "--no-signup") {
      cfg.noSignup = true;
      continue;
    }
    const v = argv[i + 1];
    if (v == null) continue;
    if (k === "--target") cfg.target = String(v);
    if (k === "--project-id") cfg.projectId = String(v);
    if (k === "--api-key") cfg.apiKey = String(v);
    if (k === "--users-file") cfg.usersFile = String(v);
    if (k === "--users") cfg.users = Number(v);
    if (k === "--max-inflight") cfg.maxInflight = Number(v);
    if (k === "--seed") cfg.seed = String(v);
    if (k === "--out-summary") cfg.outSummary = String(v);
    if (k === "--out-log") cfg.outLog = String(v);
    i++;
  }
  cfg.runTag = seedHash(cfg.seed);
  return cfg;
}

function seedHash(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `s${(h >>> 0).toString(16)}`;
}

function mulberry32(seedNum) {
  let t = seedNum >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return;
  const n = Math.max(1, Math.min(arr.length, Number.isFinite(limit) ? Math.floor(limit) : 1));
  let next = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= arr.length) return;
      await worker(arr[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function ensureDirs(filepaths) {
  const dirs = [...new Set(filepaths.map((f) => path.dirname(f)))];
  await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
}

async function appendLog(logPath, line) {
  await fs.appendFile(logPath, `${line}\n`, "utf8");
}

function getAuthBaseAndKey(cfg) {
  const isStaging = cfg.target === "staging";
  if (isStaging) {
    if (!cfg.projectId) throw new Error("--project-id is required when --target staging");
    if (!cfg.apiKey) {
      throw new Error(
        "--api-key is required when --target staging (or set API_KEY / FIREBASE_API_KEY env var)"
      );
    }
    return {
      authBase: "https://identitytoolkit.googleapis.com",
      apiKey: cfg.apiKey,
    };
  }
  return {
    authBase: `http://${DEFAULT_AUTH_HOST}/identitytoolkit.googleapis.com`,
    apiKey: EMULATOR_API_KEY,
  };
}

async function authSignUp(email, password, cfg) {
  const { authBase, apiKey } = getAuthBaseAndKey(cfg);
  const url = `${authBase}/v1/accounts:signUp?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok && json?.error?.message !== "EMAIL_EXISTS") {
    throw new Error(`signUp failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function authSignIn(email, password, cfg) {
  const { authBase, apiKey } = getAuthBaseAndKey(cfg);
  const url = `${authBase}/v1/accounts:signInWithPassword?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`signIn failed: ${JSON.stringify(json)}`);
  return json;
}

function parseAuthErrorCode(err) {
  const msg = String(err?.message || "");
  const marker = "\"message\":\"";
  const i = msg.indexOf(marker);
  if (i === -1) return "";
  const start = i + marker.length;
  const end = msg.indexOf("\"", start);
  if (end === -1) return "";
  return msg.slice(start, end).trim();
}

async function getUserToken(email, password, cfg, opts = {}) {
  const allowSignup = opts.allowSignup !== false;
  // Small pacing to avoid Auth anti-abuse burst signatures.
  await sleep(30);

  // Sign-in first for deterministic account reuse across runs.
  try {
    return await authSignIn(email, password, cfg);
  } catch (err) {
    const code = parseAuthErrorCode(err);
    if (code !== "EMAIL_NOT_FOUND" && code !== "INVALID_LOGIN_CREDENTIALS") throw err;
    if (!allowSignup) {
      throw new Error(
        `signIn failed and signUp disabled for ${email}: ${String(code || "UNKNOWN_AUTH_ERROR")}`
      );
    }
  }

  // Create only if missing.
  await sleep(30);
  try {
    await authSignUp(email, password, cfg);
  } catch (err) {
    const code = parseAuthErrorCode(err);
    // If account already exists, proceed to sign-in retry.
    if (code !== "EMAIL_EXISTS") throw err;
  }
  await sleep(30);
  return authSignIn(email, password, cfg);
}

function classifyError(err) {
  if (!err) return { type: "null_error", code: null, message: "" };

  const msg = String(err.message || err || "");
  if (
    msg.includes("ECONNRESET") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("EPIPE")
  ) {
    return { type: "transport_connection_reset", code: null, message: msg };
  }

  if (msg.toLowerCase().includes("timeout")) {
    return { type: "transport_timeout", code: null, message: msg };
  }

  // Firebase callable/generic coded errors.
  if (typeof err.code === "string") {
    return {
      type: "callable",
      code: String(err.code).toLowerCase(),
      message: msg,
    };
  }

  // Message format from callCallable: "<fn>:<STATUS>:<message>"
  const parts = msg.split(":");
  if (parts.length >= 3) {
    const status = String(parts[1] || "").trim();
    if (status) {
      return {
        type: "callable",
        code: status.toLowerCase(),
        message: msg,
      };
    }
  }

  // gRPC-like wrapped errors.
  if (err.details || err.metadata) {
    return {
      type: "grpc",
      code: typeof err.code === "number" ? String(err.code) : null,
      message: String(err.details || msg),
    };
  }

  return { type: "unclassified", code: null, message: msg || String(err) };
}

async function callCallable(name, idToken, data, opts = {}) {
  const parsedTimeout = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 15000;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(`timeout_${timeoutMs}`), timeoutMs);
  }
  const startedAt = Date.now();
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data }),
      signal: controller ? controller.signal : undefined,
    });
    const json = await res.json();
    if (!res.ok || json?.error) {
      const err = json?.error || {};
      const msg = err?.message || JSON.stringify(json);
      const status = err?.status || `http_${res.status}`;
      throw new Error(`${name}:${status}:${msg}`);
    }
    return { ok: true, durationMs: Date.now() - startedAt, data: json?.result ?? json };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - startedAt, error: e };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getUserState(db, uid) {
  const userSnap = await db.doc(`users/${uid}`).get();
  const acctSnap = await db.doc(`users/${uid}/accounting/state`).get();
  const wallet = Number(acctSnap.data()?.wallet ?? userSnap.data()?.wallet ?? 0);
  const balanceVersion = Number(
    acctSnap.data()?.accountingVersion ?? userSnap.data()?.balanceVersion ?? 0
  );
  const ledgerSnap = await db.collection(`users/${uid}/ledger`).get();
  let ledgerSum = 0;
  const ledgerDocs = [];
  for (const d of ledgerSnap.docs) {
    const data = d.data() || {};
    const delta = Number(data.amountDelta || 0);
    if (Number.isFinite(delta)) ledgerSum += delta;
    ledgerDocs.push({ id: d.id, ...data });
  }
  return { wallet, balanceVersion, ledgerSum, ledgerDocs };
}

function p95(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function seedOpenMatch(db, matchId, cfg) {
  await db.doc(`matches/${matchId}`).set(
    {
      matchId,
      status: "open",
      odds: { [cfg.teamA]: cfg.oddsA, [cfg.teamB]: cfg.oddsB },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const isStaging = cfg.target === "staging";
  if (cfg.target !== "emulator" && cfg.target !== "staging") {
    throw new Error("--target must be emulator or staging");
  }
  if (!Number.isFinite(cfg.maxInflight) || cfg.maxInflight < 1) {
    throw new Error("--max-inflight must be a positive number");
  }

  if (isStaging) {
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    delete process.env.FIRESTORE_EMULATOR_HOST;
  } else {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = DEFAULT_AUTH_HOST;
    process.env.FIRESTORE_EMULATOR_HOST = DEFAULT_FIRESTORE_HOST;
  }
  if (cfg.noSignup && !cfg.usersFile) {
    throw new Error("--no-signup requires --users-file with pre-provisioned credentials");
  }

  process.env.GCLOUD_PROJECT = cfg.projectId;
  process.env.GOOGLE_CLOUD_PROJECT = cfg.projectId;

  FUNCTIONS_BASE =
    process.env.FUNCTIONS_BASE_URL ||
    `http://127.0.0.1:5001/${cfg.projectId}/us-central1`;

  if (isStaging && !process.env.FUNCTIONS_BASE_URL) {
    throw new Error("FUNCTIONS_BASE_URL is required when --target staging");
  }

  const rand = mulberry32(Number.parseInt(cfg.runTag.slice(1), 16));
  await ensureDirs([cfg.outSummary, cfg.outLog]);
  await fs.writeFile(cfg.outLog, "", "utf8");
  await appendLog(cfg.outLog, `[n2] config: ${JSON.stringify(cfg)}`);

  if (!admin.apps.length) admin.initializeApp({ projectId: cfg.projectId });
  const db = admin.firestore();

  const plannedUsers = [];
  if (cfg.usersFile) {
    const raw = await fs.readFile(cfg.usersFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("--users-file must contain a non-empty JSON array");
    }
    for (const item of parsed.slice(0, cfg.users)) {
      const email = String(item?.email || "").trim();
      const password = String(item?.password || "FusionSim!123");
      if (!email) throw new Error("users-file entry missing email");
      plannedUsers.push({ email, password });
    }
    if (plannedUsers.length < cfg.users) {
      throw new Error(
        `users-file has ${plannedUsers.length} users but cfg.users=${cfg.users}`
      );
    }
  } else {
    for (let i = 0; i < cfg.users; i++) {
      plannedUsers.push({
        email: `sim_n2_user_${cfg.runTag}_${i}@fusion.local`,
        password: "FusionSim!123",
      });
    }
  }

  // Reuse the first participant as admin to avoid creating an extra account.
  const adminAccount = plannedUsers[0];
  const adminCred = await getUserToken(adminAccount.email, adminAccount.password, cfg, {
    allowSignup: !cfg.noSignup,
  });
  await admin.auth().setCustomUserClaims(adminCred.localId, { admin: true });
  await db.doc(`admins/${adminCred.localId}`).set(
    {
      active: true,
      role: "admin",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const adminSignedIn = await authSignIn(adminAccount.email, adminAccount.password, cfg);
  const adminToken = adminSignedIn.idToken;

  const users = [];
  for (const u of plannedUsers) {
    const cred = await getUserToken(u.email, u.password, cfg, {
      allowSignup: !cfg.noSignup,
    });
    users.push({ uid: cred.localId, idToken: cred.idToken });
    await db.doc(`users/${cred.localId}`).set(
      {
        uid: cred.localId,
        wallet: cfg.startingWallet,
        openingWallet: cfg.startingWallet,
        balanceVersion: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await db.doc(`users/${cred.localId}/accounting/state`).set(
      {
        wallet: cfg.startingWallet,
        accountingVersion: 0,
        openExposureMinor: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const before = new Map();
  for (const u of users) before.set(u.uid, await getUserState(db, u.uid));

  const durations = [];
  const errorStats = new Map();
  const errorSamples = [];
  let totalRequests = 0;
  let replayedResponses = 0;
  const allMatchIds = new Set();
  const runBetIds = new Set();
  const runIdempotency = new Map();

  function bumpErr(err) {
    const cls = classifyError(err);
    const key = cls.type === "callable" ? `callable_${String(cls.code || "unknown")}` : cls.type;
    errorStats.set(key, (errorStats.get(key) || 0) + 1);

    if (errorSamples.length < 10) {
      errorSamples.push({
        type: cls.type,
        code: cls.code || null,
        message: cls.message || null,
      });
    }
  }

  // Phase 1: deterministic concurrency flood
  const phase1 = { requests: 0, successes: 0, errors: 0, duplicateBetIds: 0 };
  const m1 = `sim-n2-${cfg.runTag}-phase1`;
  allMatchIds.add(m1);
  await seedOpenMatch(db, m1, cfg);
  const p1Tasks = [];
  for (const user of users) {
    for (let i = 0; i < cfg.phase1BetsPerUser; i++) {
      const team = rand() < 0.5 ? cfg.teamA : cfg.teamB;
      const amount = intBetween(rand, cfg.minBet, cfg.maxBet);
      const key = `n2_p1_${cfg.runTag}_${user.uid}_${i}`;
      p1Tasks.push({ user, team, amount, key });
    }
  }
  await runWithLimit(p1Tasks, cfg.maxInflight, async (t) => {
      totalRequests++;
      phase1.requests++;
      const res = await callCallable("placeBet", t.user.idToken, {
        matchId: m1,
        team: t.team,
        amount: t.amount,
        idempotencyKey: t.key,
      });
      durations.push(res.durationMs);
      if (!res.ok) {
        phase1.errors++;
        bumpErr(res.error);
        return;
      }
      phase1.successes++;
      const betId = String(res.data?.betId || "");
      if (runBetIds.has(betId)) phase1.duplicateBetIds++;
      runBetIds.add(betId);
      runIdempotency.set(t.key, betId);
      if (res.data?.replayed) replayedResponses++;
  });
  await appendLog(cfg.outLog, `[n2][phase1] ${JSON.stringify(phase1)}`);

  // Phase 2: retry amplification storm
  const phase2 = { logicalBets: cfg.phase2LogicalBets, calls: 0, errors: 0, multiDebitDetected: 0 };
  const m2 = `sim-n2-${cfg.runTag}-phase2`;
  allMatchIds.add(m2);
  await seedOpenMatch(db, m2, cfg);
  const p2Logical = [];
  for (let i = 0; i < cfg.phase2LogicalBets; i++) {
    const user = users[intBetween(rand, 0, users.length - 1)];
    const team = rand() < 0.5 ? cfg.teamA : cfg.teamB;
    const amount = intBetween(rand, cfg.minBet, cfg.maxBet);
    const burst = intBetween(rand, cfg.phase2BurstMin, cfg.phase2BurstMax);
    const key = `n2_p2_${cfg.runTag}_${i}`;
    p2Logical.push({ user, team, amount, burst, key });
  }
  const phase2OuterInflight = Math.max(
    1,
    Math.floor(cfg.maxInflight / Math.max(1, cfg.phase2BurstMax))
  );
  await runWithLimit(p2Logical, phase2OuterInflight, async (b) => {
      const betIds = new Set();
      const burstIndices = Array.from({ length: b.burst }, (_, i) => i);
      await runWithLimit(
        burstIndices,
        Math.min(cfg.maxInflight, b.burst),
        async () => {
          await sleep(intBetween(rand, 0, 250));
          totalRequests++;
          phase2.calls++;
          const res = await callCallable("placeBet", b.user.idToken, {
            matchId: m2,
            team: b.team,
            amount: b.amount,
            idempotencyKey: b.key,
          });
          durations.push(res.durationMs);
          if (!res.ok) {
            phase2.errors++;
            bumpErr(res.error);
            return;
          }
          if (res.data?.replayed) replayedResponses++;
          const betId = String(res.data?.betId || "");
          if (betId) {
            betIds.add(betId);
            runBetIds.add(betId);
            runIdempotency.set(b.key, betId);
          }
        }
      );
      if (betIds.size > 1) phase2.multiDebitDetected++;
  });
  await appendLog(cfg.outLog, `[n2][phase2] ${JSON.stringify(phase2)}`);

  // Phase 3: settlement race condition
  const phase3 = { seedBets: cfg.phase3SeedBets, settleCalls: cfg.phase3SettleCalls, settleSuccess: 0, settleConflicts: 0, settleOtherErrors: 0 };
  const m3 = `sim-n2-${cfg.runTag}-phase3`;
  allMatchIds.add(m3);
  await seedOpenMatch(db, m3, cfg);
  for (let i = 0; i < cfg.phase3SeedBets; i++) {
    const user = users[intBetween(rand, 0, users.length - 1)];
    const team = rand() < 0.5 ? cfg.teamA : cfg.teamB;
    const amount = intBetween(rand, cfg.minBet, cfg.maxBet);
    const key = `n2_p3_${cfg.runTag}_${i}`;
    totalRequests++;
    const res = await callCallable("placeBet", user.idToken, {
      matchId: m3,
      team,
      amount,
      idempotencyKey: key,
    });
    durations.push(res.durationMs);
    if (res.ok) {
      if (res.data?.replayed) replayedResponses++;
      const betId = String(res.data?.betId || "");
      runBetIds.add(betId);
      runIdempotency.set(key, betId);
    } else {
      bumpErr(res.error);
    }
  }
  const winner3 = rand() < 0.5 ? cfg.teamA : cfg.teamB;
  const phase3SettleAttempts = Array.from({ length: cfg.phase3SettleCalls }, (_, i) => i);
  await runWithLimit(
    phase3SettleAttempts,
    Math.min(cfg.maxInflight, cfg.phase3SettleCalls),
    async () => {
      await sleep(intBetween(rand, 0, 120));
      totalRequests++;
      const res = await callCallable("settleMatch", adminToken, { matchId: m3, winner: winner3 });
      durations.push(res.durationMs);
      if (res.ok) {
        phase3.settleSuccess++;
      } else {
        const cls = classifyError(res.error);
        const code = String(cls.code || "").toLowerCase();
        if (cls.type === "callable" && code === "failed_precondition") {
          phase3.settleConflicts++;
        } else {
          phase3.settleOtherErrors++;
          bumpErr(res.error);
        }
      }
    }
  );
  await appendLog(cfg.outLog, `[n2][phase3] ${JSON.stringify(phase3)}`);

  // Phase 4: partial failure injection (client-side timeouts + retry)
  const phase4 = { logicalBets: cfg.phase4LogicalBets, firstCallAbortedOrFailed: 0, retrySuccess: 0, retryFailed: 0 };
  const m4 = `sim-n2-${cfg.runTag}-phase4`;
  allMatchIds.add(m4);
  await seedOpenMatch(db, m4, cfg);
  const phase4Items = Array.from({ length: cfg.phase4LogicalBets }, (_, i) => i);
  await runWithLimit(phase4Items, cfg.maxInflight, async (_, i) => {
      const user = users[intBetween(rand, 0, users.length - 1)];
      const team = rand() < 0.5 ? cfg.teamA : cfg.teamB;
      const amount = intBetween(rand, cfg.minBet, cfg.maxBet);
      const key = `n2_p4_${cfg.runTag}_${i}`;

      totalRequests++;
      const timeoutMs = intBetween(rand, 5, 30);
      const first = await callCallable(
        "placeBet",
        user.idToken,
        { matchId: m4, team, amount, idempotencyKey: key },
        { timeoutMs }
      );
      durations.push(first.durationMs);
      if (!first.ok) {
        phase4.firstCallAbortedOrFailed++;
      } else if (first.data?.replayed) {
        replayedResponses++;
      }

      await sleep(intBetween(rand, 25, 120));
      totalRequests++;
      const second = await callCallable("placeBet", user.idToken, {
        matchId: m4,
        team,
        amount,
        idempotencyKey: key,
      });
      durations.push(second.durationMs);
      if (second.ok) {
        phase4.retrySuccess++;
        if (second.data?.replayed) replayedResponses++;
        const betId = String(second.data?.betId || "");
        runBetIds.add(betId);
        runIdempotency.set(key, betId);
      } else {
        phase4.retryFailed++;
        bumpErr(second.error);
      }
  });
  await appendLog(cfg.outLog, `[n2][phase4] ${JSON.stringify(phase4)}`);

  // Settle all open stress matches (except phase3 already raced) to validate credits.
  const settleTail = { settled: 0, errors: 0 };
  for (const matchId of [m1, m2, m4]) {
    const winner = rand() < 0.5 ? cfg.teamA : cfg.teamB;
    totalRequests++;
    const res = await callCallable("settleMatch", adminToken, { matchId, winner });
    durations.push(res.durationMs);
    if (res.ok) settleTail.settled++;
    else {
      settleTail.errors++;
      bumpErr(res.error);
    }
  }

  const after = new Map();
  for (const u of users) after.set(u.uid, await getUserState(db, u.uid));

  let walletBeforeTotal = 0;
  let walletAfterTotal = 0;
  let ledgerDeltaTotal = 0;
  let mismatchCount = 0;
  let nonMonotonicBalanceVersion = 0;
  const mismatches = [];

  // Integrity checks from participants
  for (const u of users) {
    const b = before.get(u.uid);
    const a = after.get(u.uid);
    walletBeforeTotal += b.wallet;
    walletAfterTotal += a.wallet;
    const walletDiff = a.wallet - b.wallet;
    const ledgerDiff = a.ledgerSum - b.ledgerSum;
    ledgerDeltaTotal += ledgerDiff;
    if (a.balanceVersion < b.balanceVersion) nonMonotonicBalanceVersion++;
    if (Math.abs(walletDiff - ledgerDiff) > EPSILON) {
      mismatchCount++;
      mismatches.push({ uid: u.uid, walletDiff, ledgerDiff, b: b.wallet, a: a.wallet });
    }
  }

  // Orphan checks scoped to run matchIds.
  let orphanBets = 0;
  let orphanLedgerEntries = 0;
  const debitByBet = new Map();
  const creditByBet = new Map();

  for (const u of users) {
    const state = after.get(u.uid);
    for (const entry of state.ledgerDocs) {
      if (!allMatchIds.has(String(entry.matchId || ""))) continue;
      const betId = String(entry.betId || "");
      if (!betId) continue;
      const type = String(entry.type || "");
      if (type === "bet_debit") debitByBet.set(betId, (debitByBet.get(betId) || 0) + 1);
      if (type === "settlement_credit") creditByBet.set(betId, (creditByBet.get(betId) || 0) + 1);
      const betSnap = await db.doc(`bets/${betId}`).get();
      if (!betSnap.exists) orphanLedgerEntries++;
    }
  }

  for (const betId of runBetIds) {
    const betSnap = await db.doc(`bets/${betId}`).get();
    if (!betSnap.exists) {
      orphanBets++;
      continue;
    }
    const ownerId = String(betSnap.get("ownerId") || "");
    const debitSnap = await db.doc(`users/${ownerId}/ledger/bet_debit_${betId}`).get();
    if (!debitSnap.exists) orphanBets++;
  }

  let duplicateDebits = 0;
  let duplicateCredits = 0;
  for (const c of debitByBet.values()) if (c > 1) duplicateDebits++;
  for (const c of creditByBet.values()) if (c > 1) duplicateCredits++;

  const statusBreakdown = Object.fromEntries([...errorStats.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const topErrorClasses = [...errorStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ key, count }));
  const avgDurationMs = durations.length
    ? durations.reduce((s, n) => s + n, 0) / durations.length
    : 0;

  const summary = {
    seed: cfg.seed,
    runTag: cfg.runTag,
    projectId: cfg.projectId,
    phases: { phase1, phase2, phase3, phase4, settleTail },
    telemetry: {
      totalRequests,
      averageDurationMs: avgDurationMs,
      p95DurationMs: p95(durations),
      maxContentionRetryDepth: null,
      transactionRetries: null,
      replayRate: totalRequests > 0 ? replayedResponses / totalRequests : 0,
      settlementConflictCount: phase3.settleConflicts,
      errorStatusBreakdown: statusBreakdown,
      topErrorClasses,
    },
    invariants: {
      noDoubleDebits: duplicateDebits === 0,
      noDoubleCredits: duplicateCredits === 0,
      walletLedgerParity: mismatchCount === 0,
      balanceVersionMonotonic: nonMonotonicBalanceVersion === 0,
      noOrphanBets: orphanBets === 0,
      noOrphanLedgerEntries: orphanLedgerEntries === 0,
      mismatchCount,
      epsilon: EPSILON,
      duplicateDebits,
      duplicateCredits,
      nonMonotonicBalanceVersion,
      orphanBets,
      orphanLedgerEntries,
    },
    wallet: {
      totalBefore: walletBeforeTotal,
      totalAfter: walletAfterTotal,
      totalDelta: walletAfterTotal - walletBeforeTotal,
    },
    ledger: {
      totalDelta: ledgerDeltaTotal,
    },
    mismatchesPreview: mismatches.slice(0, 20),
    generatedAt: new Date().toISOString(),
    errorSamples,
    goNoGo:
      mismatchCount === 0 &&
      duplicateDebits === 0 &&
      duplicateCredits === 0 &&
      orphanBets === 0 &&
      orphanLedgerEntries === 0 &&
      nonMonotonicBalanceVersion === 0,
  };

  await fs.writeFile(cfg.outSummary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await appendLog(cfg.outLog, `[n2] complete: ${JSON.stringify({ goNoGo: summary.goNoGo })}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[sim-n2] failed:", err?.message || err);
  process.exit(1);
});

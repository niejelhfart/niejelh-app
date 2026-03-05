// scripts/simulate-bets.mjs
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} from "firebase/functions";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

// ---- tiny helpers ----
function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

async function runPool({ total, concurrency, fn }) {
  let next = 0;
  let inFlight = 0;
  let done = 0;

  return new Promise((resolve, reject) => {
    const results = [];
    const errors = [];

    const pump = () => {
      while (inFlight < concurrency && next < total) {
        const i = next++;
        inFlight++;

        Promise.resolve()
          .then(() => fn(i))
          .then((r) => results.push(r))
          .catch((e) => errors.push(e))
          .finally(() => {
            inFlight--;
            done++;
            if (done === total) resolve({ results, errors });
            else pump();
          });
      }
    };

    pump();
  });
}

// ---- main ----
const args = process.argv.slice(2);
const MATCH_ID = args[0] || "sim-n2-sb483dc5-phase4";
const TOTAL = Number(args[1] || 300);        // number of bets
const CONCURRENCY = Number(args[2] || 25);   // parallelism
const USERS = Number(args[3] || 10);         // number of distinct anon users

// IMPORTANT: For emulators, projectId is what matters.
const firebaseConfig = {
  projectId: "fusionapp-13e36",
  apiKey: "fake-api-key-for-emulator",
  authDomain: "localhost",
};

console.log("=== simulate-bets ===");
console.log({ MATCH_ID, TOTAL, CONCURRENCY, USERS });

/**
 * Create N “client sessions” (separate Firebase app instances),
 * each signs in anonymously against the Auth emulator.
 */
async function createSessions(n) {
  const sessions = [];

  for (let i = 0; i < n; i++) {
    const app = initializeApp(firebaseConfig, `sim-${i}-${Date.now()}`);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const fns = getFunctions(app);

    // Wire to emulators:
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);

    // Auth (gives you a valid auth token for callable)
    await signInAnonymously(auth);

    const placeBet = httpsCallable(fns, "placeBet");

    sessions.push({ app, auth, db, fns, placeBet });
  }

  return sessions;
}

const sessions = await createSessions(USERS);

let ok = 0;
let fail = 0;
const latencies = [];
const failures = new Map(); // code/message counts

const startAll = nowMs();

const { results, errors } = await runPool({
  total: TOTAL,
  concurrency: CONCURRENCY,
  fn: async (i) => {
    const s = sessions[i % sessions.length];

    // Make it feel like real traffic
    const team = Math.random() < 0.5 ? "TeamA" : "TeamB";
    const amount = Math.max(1, Math.floor(Math.random() * 25)); // 1..24

    const t0 = nowMs();
    try {
      const res = await s.placeBet({
        matchId: MATCH_ID,
        team,
        amount,
        idempotencyKey: `sim-${i}-${Date.now()}`,
      });
      const t1 = nowMs();
      latencies.push(t1 - t0);
      ok++;
      return res?.data;
    } catch (e) {
      const t1 = nowMs();
      latencies.push(t1 - t0);
      fail++;

      const code = e?.code || "unknown";
      const msg = e?.message || String(e);
      const key = `${code} :: ${msg.split("\n")[0]}`;
      failures.set(key, (failures.get(key) || 0) + 1);

      // small backoff so emulator logs don’t get nuked
      await sleep(10);
      throw e;
    }
  },
});

const totalMs = nowMs() - startAll;
latencies.sort((a, b) => a - b);

console.log("\n=== results ===");
console.log(`Total: ${TOTAL}`);
console.log(`OK:    ${ok}`);
console.log(`Fail:  ${fail}`);
console.log(`Time:  ${totalMs}ms`);
console.log(`RPS:   ${(TOTAL / (totalMs / 1000)).toFixed(2)}`);

console.log("\n=== latency (ms) ===");
console.log(`p50: ${percentile(latencies, 0.50)}`);
console.log(`p90: ${percentile(latencies, 0.90)}`);
console.log(`p95: ${percentile(latencies, 0.95)}`);
console.log(`p99: ${percentile(latencies, 0.99)}`);
console.log(`max: ${latencies[latencies.length - 1] || 0}`);

if (failures.size) {
  console.log("\n=== top failures ===");
  const top = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [k, v] of top) console.log(`${v}x  ${k}`);
}

console.log("\nDone.");
process.exit(fail ? 1 : 0);

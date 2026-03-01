import admin from "firebase-admin";

const DEFAULT_PROJECT_ID = process.env.GCLOUD_PROJECT || "fusionapp-13e36";
const EPSILON = 0.0001;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

// Force local emulator usage so ADC is never required.
process.env.GCLOUD_PROJECT = DEFAULT_PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = DEFAULT_PROJECT_ID;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;

function parseArgs(argv) {
  const out = {
    projectId: DEFAULT_PROJECT_ID,
    expectedOpeningWallet: 100,
    userLimit: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--project-id" && val) {
      out.projectId = val;
      i++;
    } else if (key === "--opening-wallet" && val) {
      out.expectedOpeningWallet = Number(val);
      i++;
    } else if (key === "--user-limit" && val) {
      out.userLimit = Number(val);
      i++;
    }
  }
  return out;
}

async function sumLedger(db, uid) {
  let sum = 0;
  let count = 0;
  let invalidDeltaCount = 0;
  let lastDoc = null;

  while (true) {
    let q = db
      .collection("users")
      .doc(uid)
      .collection("ledger")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(500);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      count++;
      const delta = Number(doc.get("amountDelta"));
      if (Number.isFinite(delta)) sum += delta;
      else invalidDeltaCount++;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  return { sum, count, invalidDeltaCount };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  admin.initializeApp({ projectId: cfg.projectId });
  const db = admin.firestore();

  let checkedUsers = 0;
  let mismatches = 0;
  let invalidUsers = 0;
  const rows = [];

  let lastUser = null;
  const pageSize = 300;

  while (true) {
    let q = db
      .collection("users")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);

    if (lastUser) q = q.startAfter(lastUser);

    const snap = await q.get();
    if (snap.empty) break;

    for (const userDoc of snap.docs) {
      const uid = userDoc.id;
      const acctDoc = await db.doc(`users/${uid}/accounting/state`).get();
      const wallet = Number(acctDoc.exists ? acctDoc.get("wallet") : userDoc.get("wallet"));
      const accountingVersion = Number(
        acctDoc.exists ? acctDoc.get("accountingVersion") : userDoc.get("balanceVersion")
      );
      const { sum, count, invalidDeltaCount } = await sumLedger(db, uid);

      const inferredOpening = wallet - sum;
      const openingDrift = Math.abs(inferredOpening - cfg.expectedOpeningWallet);
      const versionDrift = Math.abs(accountingVersion - count);
      const invalidWallet = !Number.isFinite(wallet);
      const invalidVersion = !Number.isFinite(accountingVersion);

      checkedUsers++;

      const hasMismatch =
        invalidWallet ||
        invalidVersion ||
        invalidDeltaCount > 0 ||
        openingDrift > EPSILON ||
        versionDrift > 0;

      if (hasMismatch) {
        mismatches++;
        rows.push({
          uid,
          wallet,
          accountingVersion,
          ledgerDeltaSum: sum,
          ledgerCount: count,
          inferredOpening,
          openingDrift,
          versionDrift,
          invalidDeltaCount,
        });
      }

      if (invalidWallet || invalidVersion) invalidUsers++;

      if (cfg.userLimit > 0 && checkedUsers >= cfg.userLimit) break;
    }

    if (cfg.userLimit > 0 && checkedUsers >= cfg.userLimit) break;
    lastUser = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  console.log(
    JSON.stringify(
      {
        event: "ledger_reconciliation_summary",
        projectId: cfg.projectId,
        checkedUsers,
        mismatches,
        invalidUsers,
        expectedOpeningWallet: cfg.expectedOpeningWallet,
        timestamp: Date.now(),
      },
      null,
      2
    )
  );

  if (rows.length) {
    console.log("\nMISMATCH DETAILS:");
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("reconcile-ledger failed:", err?.message || err);
  process.exit(1);
});

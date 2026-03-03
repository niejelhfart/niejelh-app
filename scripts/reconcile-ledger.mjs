import admin from "firebase-admin";

const DEFAULT_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
const DEFAULT_EMULATOR_PROJECT_ID = "fusionapp-13e36";
const DEFAULT_FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
const EPSILON = 0.0001;

function parseArgs(argv) {
  const out = {
    projectId: DEFAULT_PROJECT_ID,
    expectedOpeningWallet: 100,
    userLimit: 0,
    useEmulator: false,
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
    } else if (key === "--use-emulator") {
      out.useEmulator = true;
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
  const envEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const useEmulator = cfg.useEmulator || Boolean(envEmulatorHost);
  const firestoreEmulatorHost = envEmulatorHost || DEFAULT_FIRESTORE_EMULATOR_HOST;

  let projectId = String(cfg.projectId || "").trim();
  if (!projectId) {
    projectId = useEmulator ? DEFAULT_EMULATOR_PROJECT_ID : "";
  }
  if (!projectId) {
    throw new Error(
      "--project-id is required when running against remote Firestore (non-emulator)."
    );
  }

  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  if (useEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = firestoreEmulatorHost;
  } else {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  }

  admin.initializeApp({ projectId });
  const db = admin.firestore();
  if (useEmulator) {
    db.settings({ host: firestoreEmulatorHost, ssl: false });
  }

  console.log(
    `reconcile target: ${useEmulator ? "emulator" : "remote"}, projectId=${projectId}, openingWallet=${cfg.expectedOpeningWallet}`
  );

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
        projectId,
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

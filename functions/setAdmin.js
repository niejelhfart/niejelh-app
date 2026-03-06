/**
 * setAdmin.js
 * Run from: functions folder
 * Usage (emulator):
 *   ADMIN_TARGET=emulator node setAdmin.js
 * Usage (production, explicit opt-in):
 *   ADMIN_TARGET=production ALLOW_PROD_ADMIN_MUTATION=true node setAdmin.js
 *
 * This script is emulator-safe:
 * - Requires explicit target selection (emulator/production)
 * - Targets both Auth + Firestore emulators when ADMIN_TARGET=emulator
 * - Finds user by email; if missing, creates them
 * - Sets custom claims
 */

const admin = require("firebase-admin");

const TARGET = String(process.env.ADMIN_TARGET || "").trim().toLowerCase();
if (TARGET !== "emulator" && TARGET !== "production") {
  console.error(
    "❌ Missing/invalid ADMIN_TARGET. Use ADMIN_TARGET=emulator or ADMIN_TARGET=production."
  );
  process.exit(1);
}

if (TARGET === "emulator") {
  process.env.FIREBASE_AUTH_EMULATOR_HOST =
    process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  process.env.FIRESTORE_EMULATOR_HOST =
    process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
} else if (process.env.ALLOW_PROD_ADMIN_MUTATION !== "true") {
  console.error(
    "❌ Refusing production mutation. Set ALLOW_PROD_ADMIN_MUTATION=true to continue."
  );
  process.exit(1);
}

// Your emulator project id MUST match what the emulator is running as
// Use the same value you start with: --project fusionapp-13e36
const PROJECT_ID = process.env.GCLOUD_PROJECT || "fusionapp-13e36";

// Change these to whatever you want
const ADMIN_EMAIL = "Niejelh@gmail.com";
const ADMIN_PASSWORD = "123456"; // only used if the user must be created

admin.initializeApp({
  projectId: PROJECT_ID,
});

async function main() {
  try {
    let user;

    // 1) Get or create user in Auth Emulator
    try {
      user = await admin.auth().getUserByEmail(ADMIN_EMAIL);
      console.log("Found user:", user.uid, ADMIN_EMAIL);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        user = await admin.auth().createUser({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          emailVerified: true,
          displayName: "Niejel (Admin)",
        });
        console.log("Created user:", user.uid, ADMIN_EMAIL);
      } else {
        throw err;
      }
    }

    // 2) Set custom claims
    await admin.auth().setCustomUserClaims(user.uid, {
      admin: true,
      role: "super_admin",
    });
    await admin
      .firestore()
      .collection("admins")
      .doc(user.uid)
      .set(
        {
          active: true,
          role: "super_admin",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    console.log("✅ Admin claims set successfully");
    console.log("Target:", TARGET);
    console.log("UID:", user.uid);
    console.log("Email:", ADMIN_EMAIL);

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to set admin claim");
    console.error(err);
    process.exit(1);
  }
}

main();

/**
 * setAdmin.js
 * Run from: functions folder
 * Usage: node setAdmin.js
 *
 * This script is emulator-safe:
 * - Targets the Auth Emulator
 * - Finds user by email; if missing, creates them
 * - Sets custom claims
 */

const admin = require("firebase-admin");

// IMPORTANT: point Admin SDK to Auth Emulator BEFORE initializeApp
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

// Your emulator project id MUST match what the emulator is running as
// Use the same value you start with: --project fusionapp-13e36
const PROJECT_ID = "fusionapp-13e36";

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

    console.log("✅ Admin claims set successfully");
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
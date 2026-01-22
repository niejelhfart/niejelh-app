import * as admin from "firebase-admin";
export { syncAdminClaims } from "./syncAdminClaims";

// MUST be before initializeApp
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.GCLOUD_PROJECT = "fusionapp-13e36";

admin.initializeApp({
  projectId: "fusionapp-13e36",
});

async function makeAdmin() {
  const email = "niejelh@gmail.com"; // 👈 NEVER changes

  const user = await admin.auth().getUserByEmail(email);

  await admin.auth().setCustomUserClaims(user.uid, {
    admin: true,
  });

  console.log(`✅ Admin claim set for ${email} (${user.uid})`);
  process.exit(0);
}

makeAdmin().catch((err) => {
  console.error("❌ Failed to set admin claim:", err);
  process.exit(1);
});
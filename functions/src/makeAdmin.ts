import * as admin from "firebase-admin";

/**
 * Sets admin custom claims for a user.
 *
 * Usage:
 * FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 GCLOUD_PROJECT=fusionapp-13e36 node lib/makeAdmin.js <email>
 *
 * Safety:
 * - Requires explicit email argument.
 * - Requires explicit project id (GCLOUD_PROJECT or FIREBASE_PROJECT_ID).
 * - Refuses production mutations unless ALLOW_PROD_ADMIN_MUTATION=true.
 */
export async function makeAdmin() {
  const email = String(process.argv[2] || "").trim();
  if (!email) {
    throw new Error("Missing email argument. Usage: node lib/makeAdmin.js <email>");
  }

  const projectId = String(
    process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || ""
  ).trim();
  if (!projectId) {
    throw new Error("Missing project id. Set GCLOUD_PROJECT or FIREBASE_PROJECT_ID.");
  }

  const authEmulatorHost = String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim();
  const allowProduction = process.env.ALLOW_PROD_ADMIN_MUTATION === "true";
  if (!authEmulatorHost && !allowProduction) {
    throw new Error(
      "Refusing to mutate admin claims without emulator target. Set FIREBASE_AUTH_EMULATOR_HOST or explicitly set ALLOW_PROD_ADMIN_MUTATION=true."
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({ projectId });
  }

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, {
      admin: true,
    });
    const target = authEmulatorHost ? `emulator:${authEmulatorHost}` : "production";
    console.log(`✅ Admin claim set for ${email} (${user.uid}) on ${projectId} (${target})`);
  } catch (err) {
    console.error(`❌ Failed to set admin claim for ${email}:`, err);
    process.exit(1);
  }
}

if (require.main === module) {
  makeAdmin().catch(console.error);
}

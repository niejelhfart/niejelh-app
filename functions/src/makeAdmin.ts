import * as admin from "firebase-admin";

/**
 * Sets admin custom claims for a user.
 * 
 * Usage:
 * NODE_ENV=development node lib/makeAdmin.js <email>
 */
export async function makeAdmin() {
  const email = process.argv[2] || "niejelh@gmail.com";

  if (!admin.apps.length) {
    admin.initializeApp();
  }

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, {
      admin: true,
    });
    console.log(`✅ Admin claim set for ${email} (${user.uid})`);
  } catch (err) {
    console.error(`❌ Failed to set admin claim for ${email}:`, err);
    process.exit(1);
  }
}

if (require.main === module) {
  makeAdmin().catch(console.error);
}

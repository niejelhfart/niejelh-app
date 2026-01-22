const admin = require("firebase-admin");

// Use emulator credentials automatically
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

admin.initializeApp({
  projectId: "fusion-app" // must match your emulator project
});

async function setAdmin() {
  try {
    const user = await admin
      .auth()
      .getUserByEmail("Niejelh@gmail.com");

    await admin.auth().setCustomUserClaims(user.uid, {
      admin: true
    });

    console.log("✅ Admin claim set successfully for:", user.uid);
  } catch (err) {
    console.error("❌ Failed to set admin claim:", err);
  }
}

setAdmin();
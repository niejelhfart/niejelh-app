import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const syncAdminClaims = functions.auth.user().onCreate(
  async (user) => {
    const adminDoc = await admin
      .firestore()
      .collection("admins")
      .doc(user.uid)
      .get();

    if (!adminDoc.exists) {
      console.log("User is not admin:", user.uid);
      return;
    }

    const data = adminDoc.data();

    if (data?.active === true) {
      await admin.auth().setCustomUserClaims(user.uid, {
        admin: true,
        role: data.role || "admin",
      });

      console.log("Admin claims set for:", user.uid);
    }
  }
);
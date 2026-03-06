import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const ADMINS_COLLECTION = "admins";

type AdminDoc = {
  active?: boolean;
  role?: string;
};

async function upsertAdminClaims(uid: string, adminDoc: AdminDoc | null): Promise<void> {
  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().getUser(uid);
  } catch (err: any) {
    if (String(err?.code || "") === "auth/user-not-found") {
      console.log("syncAdminClaims: user not found, skipping:", uid);
      return;
    }
    throw err;
  }

  const existingClaims = { ...(userRecord.customClaims || {}) };
  const shouldBeAdmin = adminDoc?.active === true;
  if (shouldBeAdmin) {
    existingClaims.admin = true;
    existingClaims.role = String(adminDoc?.role || "admin");
  } else {
    delete existingClaims.admin;
    delete existingClaims.role;
  }

  await admin.auth().setCustomUserClaims(
    uid,
    Object.keys(existingClaims).length > 0 ? existingClaims : null
  );

  console.log(
    shouldBeAdmin ? `Admin claims set for: ${uid}` : `Admin claims revoked for: ${uid}`
  );
}

export const syncAdminClaims = functions.auth.user().onCreate(async (user) => {
  const adminDoc = await admin
    .firestore()
    .collection(ADMINS_COLLECTION)
    .doc(user.uid)
    .get();

  if (!adminDoc.exists) {
    console.log("User is not admin:", user.uid);
    return;
  }

  await upsertAdminClaims(user.uid, (adminDoc.data() || {}) as AdminDoc);
});

export const syncAdminClaimsOnAdminWrite = functions.firestore
  .document(`${ADMINS_COLLECTION}/{uid}`)
  .onWrite(async (change, context) => {
    const uid = String(context.params.uid || "").trim();
    if (!uid) return;

    const adminDoc = change.after.exists ? ((change.after.data() || {}) as AdminDoc) : null;
    await upsertAdminClaims(uid, adminDoc);
  });

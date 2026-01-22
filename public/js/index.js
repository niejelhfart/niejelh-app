const { onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
;
const db = getFirestore();

/**
 * Create Point Purchase (C3 secure version)
 * Uses request.auth.uid (user MUST be logged in)
 */
exports.createPointPurchase = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("User not authenticated");

  const { packId } = request.data;
  if (!packId) throw new Error("Missing packId");

  // Load pack
  const packRef = db.collection("pointPacks").doc(packId);
  const packSnap = await packRef.get();

  if (!packSnap.exists) throw new Error("Pack does not exist");

  const pack = packSnap.data();

  // OPTIONAL: add Stripe verification later
  // For now we simulate success
  const walletRef = db.collection("wallets").doc(uid);

  await walletRef.set(
    {
      points: FieldValue.increment(pack.points),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    addedPoints: pack.points,
  };
});

/**
 * Place a bet
 */
exports.placeBet = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("User not authenticated");

  const { amount } = request.data;
  if (!amount) throw new Error("Missing amount");

  const walletRef = db.collection("wallets").doc(uid);
  const walletSnap = await walletRef.get();

  if (!walletSnap.exists || walletSnap.data().points < amount) {
    throw new Error("Not enough points");
  }

  await walletRef.update({
    points: FieldValue.increment(-amount),
  });

  return {
    success: true,
    message: "Bet placed",
    pointsRemaining: walletSnap.data().points - amount,
  };
});

/**
 * Settle Bet
 */
exports.settleBet = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("User not authenticated");

  const { didWin, reward } = request.data;

  const walletRef = db.collection("wallets").doc(uid);

  if (didWin) {
    await walletRef.update({
      points: FieldValue.increment(reward),
    });

    return { success: true, message: "User won!", reward };
  }

  return { success: true, message: "User lost." };
});
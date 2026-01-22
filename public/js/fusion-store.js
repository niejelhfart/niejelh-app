import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  connectFirestoreEmulator,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* 🔑 Firebase config */
const firebaseConfig = {
  apiKey: "AIzaSyDQvCPzjId2H89KIQXFCw6sJjetm6HCmg",
  authDomain: "fusionapp-13e36.firebaseapp.com",
  projectId: "fusionapp-13e36",
};

/* 🔥 Init */
const auth = getAuth(app);
const db = getFirestore(app);

/* 🔥 Emulators */
connectAuthEmulator(auth, "http://127.0.0.1:9099");
connectFirestoreEmulator(db, "127.0.0.1", 8080);

/* UI */
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authStatus = document.getElementById("authStatus");

/* ===============================
   SIGN IN
================================ */
signInBtn.addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
});

/* ===============================
   SIGN OUT
================================ */
signOutBtn.addEventListener("click", async () => {
  await signOut(auth);
});

/* ===============================
   AUTH STATE + USER + WALLET
================================ */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authStatus.textContent = "Not signed in";
    signInBtn.style.display = "block";
    signOutBtn.style.display = "none";
    return;
  }

  authStatus.textContent = `Signed in as ${user.email}`;
  signInBtn.style.display = "none";
  signOutBtn.style.display = "block";

  /* -------------------------------
     USERS COLLECTION
  -------------------------------- */
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || "Fusion User",
      provider: user.providerData[0]?.providerId || "unknown",
      createdAt: serverTimestamp()
    });
  }

  /* -------------------------------
     WALLETS COLLECTION
  -------------------------------- */
  const walletRef = doc(db, "wallets", user.uid);
  const walletSnap = await getDoc(walletRef);

  if (!walletSnap.exists()) {
    console.log("Creating wallet");

    await setDoc(walletRef, {
      userId: user.uid,
      balance: 1000,        // 🧪 test credits
      lockedBalance: 0,
      currency: "USD",
      createdAt: serverTimestamp()
    });
  }
});
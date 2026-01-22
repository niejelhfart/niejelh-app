/************************************************
 * Firebase SDK imports
 ************************************************/
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/************************************************
 * Firebase configuration
 ************************************************/
const firebaseConfig = {
  apiKey: "AIzaSyDQoVCPzjId2H89KIQXFCw6sJjetm6HCmg",
  authDomain: "fusionapp-13e36.firebaseapp.com",
  projectId: "fusionapp-13e36",
  storageBucket: "fusionapp-13e36.firebasestorage.app",
  messagingSenderId: "1028532749298",
  appId: "1:1028532749298:web:97eda140b714edd4d1616b"
};

/************************************************
 * Initialize Firebase
 ************************************************/
const auth = getAuth(app);
const db = getFirestore(app);

// 🔥 Emulators
db.useEmulator("127.0.0.1", 8080);

window.isAdmin = false;

/************************************************
 * Auth + Admin Claim Resolution
 ************************************************/
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    console.warn("⚠️ No user signed in");
    return;
  }

  try {
    const tokenResult = await user.getIdTokenResult(true);
    window.isAdmin = tokenResult.claims.admin === true;

    console.log("👤 UID:", user.uid);
    console.log("🔐 Claims:", tokenResult.claims);
    console.log(window.isAdmin ? "✅ Admin" : "⛔ Not admin");

    await loadFeatureToggles();

  } catch (err) {
    console.error("❌ Auth resolution failed:", err);
  }
});

/************************************************
 * Firestore Feature Toggles
 ************************************************/
async function loadFeatureToggles() {
  try {
    const ref = doc(db, "admin", "settings");
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      console.warn("⚠️ admin/settings missing");
      return;
    }

    const { betsopen, maintenance } = snap.data();
    console.log("🎛 Settings:", { betsopen, maintenance });

    // 🚧 Maintenance mode (blocks everyone)
    if (maintenance === true) {
      document.body.innerHTML = `
        <h1>🚧 Maintenance Mode</h1>
        <p>Fusion is temporarily offline.</p>
      `;
      return;
    }

    // 🎲 Betting toggle
    if (betsopen === true) {
      document.body.insertAdjacentHTML(
        "beforeend",
        "<p>🎲 Betting is LIVE</p>"
      );
    } else {
      document.body.insertAdjacentHTML(
        "beforeend",
        "<p>⛔ Betting is currently closed</p>"
      );
    }

    // 🧑‍💼 Admin quick link (only for admins)
    if (window.isAdmin) {
      const btn = document.createElement("button");
      btn.innerText = "Admin Panel";
      btn.onclick = () => (window.location.href = "/admin.html");
      document.body.appendChild(btn);
    }

  } catch (err) {
    console.error("❌ Failed to load settings:", err);
  }
}
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// 🔥 Firebase configuration (from your screenshot)
const firebaseConfig = {
  apiKey: "AIzaSyDQoVCPzjId2H89KIQXFCw6sJjetm6HCmg",
  authDomain: "fusionapp-13e36.firebaseapp.com",
  projectId: "fusionapp-13e36",
  storageBucket: "fusionapp-13e36.firebasestorage.app",
  messagingSenderId: "1028532749298",
  appId: "1:1028532749298:web:97eda140b714edd4d1616b"
};

// ✅ Initialize Firebase ONCE
export const app = initializeApp(firebaseConfig);

// ✅ Services
export const auth = getAuth(app);
export const db = getFirestore(app);

// 🧪 Emulator connections (local only)
connectAuthEmulator(auth, "http://127.0.0.1:9099");
connectFirestoreEmulator(db, "127.0.0.1", 8080);

console.log("🔥 Firebase initialized (Fusion)");
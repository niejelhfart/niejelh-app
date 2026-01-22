import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const status = document.getElementById("status");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/index.html";
    return;
  }

  // FORCE refresh token so claims load
  const tokenResult = await user.getIdTokenResult(true);

  if (!tokenResult.claims.admin) {
    console.warn("❌ Not admin");
    window.location.href = "/index.html";
    return;
  }

  console.log("✅ Admin verified");
  status.textContent = "Admin access granted";
});
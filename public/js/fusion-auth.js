import { auth } from "./firebase-init.js";
import { signInWithEmailAndPassword } from
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

document.getElementById("signInBtn").addEventListener("click", async () => {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    console.log("✅ Signed in");
    window.location.href = "/admin.html";
  } catch (err) {
    console.error("❌ Sign-in failed", err.message);
  }
});
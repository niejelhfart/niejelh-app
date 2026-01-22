import { db } from "./firebase-init.js";
import { doc, updateDoc } from
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

async function updateToggle(field, value) {
  const ref = doc(db, "admin", "settings");
  await updateDoc(ref, { [field]: value });
  console.log(`🟢 ${field} set to`, value);
}

document.getElementById("betsToggle").addEventListener("change", e => {
  updateToggle("betsOpen", e.target.checked);
});

document.getElementById("storeToggle").addEventListener("change", e => {
  updateToggle("storeOpen", e.target.checked);
});
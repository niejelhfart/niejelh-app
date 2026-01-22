
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const auth = getAuth();
const db = getFirestore();

const betsList = document.getElementById("bets-list");

onAuthStateChanged(auth, (user) => {
  if (!user) {
    ;
    return;
  }

  const betsRef = collection(db, "bets");
  const q = query(
    betsRef,
    where("userId", "==", user.uid),
    orderBy("createdAt", "desc")
  );

  onSnapshot(q, (snapshot) => {
    betsList.innerHTML = "";

    if (snapshot.empty) {
      betsList.innerHTML = `<div class="empty">No bets placed yet</div>`;
      return;
    }

    snapshot.forEach((doc) => {
      const bet = doc.data();

      const statusClass =
        bet.status === "won" ? "won" :
        bet.status === "lost" ? "lost" :
        "open";

      const betEl = document.createElement("div");
      betEl.className = "bet";

      betEl.innerHTML = `
        <strong>${bet.match}</strong>
        Pick: ${bet.pick}<br/>
        Amount: $${bet.amount}<br/>
        <div class="status ${statusClass}">
          Status: ${bet.status.toUpperCase()}
        </div>
      `;

      betsList.appendChild(betEl);
    });
  });
});
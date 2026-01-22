import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const auth = getAuth();
const db = getFirestore();

const teamSelect = document.getElementById("team");
const amountInput = document.getElementById("amount");
const placeBetBtn = document.getElementById("place-bet");

let currentUser = null;

// AUTH STATE
onAuthStateChanged(auth, (user) => {
  if (!user) {
    alert("You must be signed in to place a bet.");
   ;
  } else {
    currentUser = user;
  }
});

// PLACE BET
placeBetBtn.addEventListener("click", async () => {
  if (!currentUser) return;

  const team = teamSelect.value;
  const amount = Number(amountInput.value);

  if (!amount || amount <= 0) {
    alert("Enter a valid bet amount");
    return;
  }

  try {
    await addDoc(collection(db, "bets"), {
      ownerId: currentUser.uid,
      matchId: "steelers-vs-bengals-2026-01-12",
      team,
      odds: -110,
      amount,
      status: "open",
      createdAt: serverTimestamp()
    });

    alert("Bet placed successfully!");
    amountInput.value = "";

  } catch (err) {
    console.error(err);
    alert("Failed to place bet");
  }
});
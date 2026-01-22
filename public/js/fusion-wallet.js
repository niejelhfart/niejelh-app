// public/js/fusion-wallet.js
// ❌ DO NOT redeclare db or auth here

window.FusionWallet = {
  async refreshBalances() {
    const user = auth.currentUser;
    if (!user) return;

    const snap = await db.collection("wallets").doc(user.uid).get();
    if (!snap.exists) return;

    const wallet = snap.data();
    document.getElementById("cashBalance").textContent = `$${(wallet.cash || 0).toFixed(2)}`;
    document.getElementById("pointsBalance").textContent = `${wallet.points || 0} FP`;
  },

  async showTransactions(limit = 20) {
    const user = auth.currentUser;
    if (!user) return alert("Sign in first");

    const txns = await db
      .collection("transactions")
      .where("userId", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    txns.forEach(t => console.log(t.id, t.data()));
  }
};

auth.onAuthStateChanged(user => {
  if (user) FusionWallet.refreshBalances();
});
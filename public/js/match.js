// js/match.js
document.addEventListener('DOMContentLoaded', () => {
  const url = new URL(location.href);
  const game = url.searchParams.get('game') || 'Unknown Match';
  const pot = url.searchParams.get('pot') || '0';

  document.getElementById('matchTitle').innerText = game;
  document.getElementById('matchPot').innerText = `Pot: $${pot}`;

  const watchBtn = document.getElementById('watchMatchBtn');
  watchBtn.addEventListener('click', () => {
    const channel = document.getElementById('matchChannel').value.trim();
    const watchUrl = new URL('watch.html', location.href);
    watchUrl.searchParams.set('game', game);
    watchUrl.searchParams.set('pot', pot);
    if (channel) {
      // allow full URL or platform:id syntax
      // if user pasted full URL, store it as src param
      watchUrl.searchParams.set('src', channel);
    }
    location.href = watchUrl.toString();
  });
});
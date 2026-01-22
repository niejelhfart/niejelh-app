// js/script.js
// Data examples — extend these with your backend data later
const matches = [
  { id: 'sample1', title: 'Alpha vs Bravo', pot: 500, platform: 'youtube', channel: 'dQw4w9WgXcQ' },
  { id: 'sample2', title: 'Live Exhibition', pot: 0, platform: 'twitch', channel: 'ninja' }
];

const players = [
  { name: 'Player123', wins: 12000, viewerWinnings: 4000 },
  { name: 'ProGamer', wins: 8800, viewerWinnings: 2200 }
];

// populate matches
function renderMatches() {
  const container = document.getElementById('matchesContainer');
  container.innerHTML = '';
  matches.forEach(m => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-title">${m.title}</div>
      <div class="card-sub">Pot: $${m.pot}</div>
      <button class="btn" data-match="${m.id}">View Match</button>
    `;
    card.querySelector('button').addEventListener('click', () => {
      // navigate to match page with params (match id, pot)
      const url = new URL('match.html', location.href);
      url.searchParams.set('game', m.title);
      url.searchParams.set('pot', m.pot);
      // if example channel exists, pass it so watch page can open quickly
      if (m.channel) url.searchParams.set('src', `${m.platform}:${m.channel}`);
      location.href = url.toString();
    });
    container.appendChild(card);
  });
}

// populate players
function renderPlayers() {
  const container = document.getElementById('playersContainer');
  container.innerHTML = '';
  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-title">${p.name}</div>
      <div class="card-sub">Money won: $${p.wins.toLocaleString()}</div>
      <div class="card-sub">Winnings shared to bettors: $${p.viewerWinnings.toLocaleString()}</div>
      <button class="btn">View Profile</button>
    `;
    container.appendChild(card);
  });
}

// wiring the hero platform buttons & CTA
function wireHeroControls() {
  const platformButtons = document.querySelectorAll('.platform-btn');
  const select = document.getElementById('platformSelectIndex');
  platformButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.platform;
      select.value = p;
      select.dispatchEvent(new Event('change'));
    });
  });

  document.getElementById('ctaWatch').addEventListener('click', () => {
    const platform = select.value;
    const url = new URL('watch.html', location.href);
    if (platform && platform !== 'auto') url.searchParams.set('platform', platform);
    location.href = url.toString();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderMatches();
  renderPlayers();
  wireHeroControls();
});
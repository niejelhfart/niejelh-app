// js/watch.js (module)
const parseSrcParam = (raw) => {
  // Accepts "platform:id" or full URL (youtube, twitch, kick)
  if(!raw) return null;
  if(raw.includes(':')) {
    const [platform, id] = raw.split(':');
    return { platform, id };
  }
  // try to parse URL
  try {
    const u = new URL(raw);
    const host = u.hostname.replace('www.','');
    if(host.includes('youtube')) {
      // YouTube: look for v=
      const v = u.searchParams.get('v');
      if(v) return { platform: 'youtube', id: v };
      // maybe embed url ending with id
      const parts = u.pathname.split('/');
      return { platform: 'youtube', id: parts.pop() };
    }
    if(host.includes('twitch')) {
      const parts = u.pathname.split('/');
      return { platform: 'twitch', id: parts.pop() };
    }
    if(host.includes('kick')) {
      const parts = u.pathname.split('/');
      return { platform: 'kick', id: parts.pop() };
    }
  } catch(e){ }
  // fallback: treat raw as channel id (assume twitch)
  return { platform: 'twitch', id: raw };
};

function setStreamFrame(platform, id) {
  const frame = document.getElementById('streamFrame');
  const unsupported = document.getElementById('unsupported');
  if(!platform || !id) {
    frame.style.display = 'none';
    unsupported.style.display = 'block';
    return;
  }

  let src = '';
  if(platform === 'youtube') {
    src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
  } else if(platform === 'twitch') {
    // twitch embed requires parent param to equal your host
    const parent = location.hostname;
    src = `https://player.twitch.tv/?channel=${id}&parent=${parent}&autoplay=true&muted=false`;
  } else if(platform === 'kick') {
    // Kick embed (works if the host supports their embed)
    src = `https://player.kick.com/${id}`;
  } else {
    // raw url
    src = id;
  }

  frame.src = src;
  frame.style.display = 'block';
  unsupported.style.display = 'none';
}


// --------- Chat/viewer demo (simple, optional placeholders) ---------
// You may replace this with Firebase logic. For now it's local counters.
const state = {
  views: Math.floor(Math.random()*200)+20,
  likes: 0,
  follows: 0,
};

function bindUI() {
  document.getElementById('likeBtn').addEventListener('click', () => {
    state.likes++;
    document.getElementById('likeCount').innerText = state.likes;
  });
  document.getElementById('followBtn').addEventListener('click', () => {
    state.follows++;
    document.getElementById('followCount').innerText = state.follows;
  });
  document.getElementById('tipBtn').addEventListener('click', () => {
    alert('Tip modal — implement payment provider (Stripe, etc.)');
  });
  document.getElementById('sendBtn').addEventListener('click', () => {
    const input = document.getElementById('chatMessage');
    const val = input.value.trim();
    if(!val) return;
    const box = document.getElementById('messages');
    const div = document.createElement('div');
    div.textContent = val;
    box.appendChild(div);
    input.value = '';
    box.scrollTop = box.scrollHeight;
  });
}

function renderViewerCount() {
  document.getElementById('viewerCount').innerText = `👁 ${state.views}`;
}

// --------- Initialization: read params and load stream ----------

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  renderViewerCount();

  const url = new URL(location.href);
  // Accept either ?src=platform:id or ?type=platform&id=...
  let src = url.searchParams.get('src');
  const pType = url.searchParams.get('platform') || url.searchParams.get('type');
  const id = url.searchParams.get('id');
  const game = url.searchParams.get('game');
  const pot = url.searchParams.get('pot') || 0;
  if(game) document.getElementById('watchTitle').innerText = `${game} • Live`;
  document.getElementById('watchPot').innerText = `Pot: $${pot}`;

  if(!src && pType && id) src = `${pType}:${id}`;

  // If user didn't specify, attempt auto-detect from URL (common)
  if(!src) {
    // nothing — user must fill input or press load
  } else {
    const parsed = parseSrcParam(src);
    setStreamFrame(parsed.platform, parsed.id);
  }

  // wire load button and platform selector
  document.getElementById('loadStreamBtn').addEventListener('click', () => {
    const selected = document.getElementById('platformSelect').value;
    const raw = document.getElementById('channelInput').value.trim();
    if(!raw) {
      alert('Enter a channel id or full url (e.g. twitch.tv/Ninja or channel:abc).');
      return;
    }
    const parsed = parseSrcParam(raw.includes(':') ? raw : `${selected}:${raw}`);
    setStreamFrame(parsed.platform, parsed.id);
  });

  // quick auto-detect: if url contains youtube/watch?v= or twitch.tv
  if(!src) {
    const u = location.href;
    if(u.includes('youtube.com') && u.includes('v=')) {
      const v = new URL(u).searchParams.get('v');
      if(v) setStreamFrame('youtube', v);
    } else if(u.includes('twitch.tv')) {
      const parts = location.pathname.split('/');
      const chan = parts.pop();
      setStreamFrame('twitch', chan);
    }
  }
});
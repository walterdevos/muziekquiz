import { QuizClient } from './quiz-client.js';
import { AudioEngine } from './audio-engine.js';
import { SyncedPlayback } from './synced-playback.js';

const $ = (id) => document.getElementById(id);

const client = new QuizClient({ role: 'player' });
const audio = new AudioEngine();
const playback = new SyncedPlayback(client, audio);

const views = ['connecting', 'idle', 'loading', 'ready', 'syncing', 'countdown', 'playing', 'finished', 'error', 'reveal'];
let currentView = null;

function showView(name) {
  if (currentView === name) return;
  currentView = name;
  for (const v of views) $(`v-${v}`).classList.toggle('hidden', v !== name);
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---- join ------------------------------------------------------------------
$('btn-join').addEventListener('click', async () => {
  try {
    await playback.enable();
  } catch (err) {
    toast(`Could not start audio: ${err.message}`);
    return;
  }
  $('screen-join').classList.add('hidden');
  $('screen-live').classList.remove('hidden');
  $('controls').classList.remove('hidden');
  client.connect();
  requestAnimationFrame(tick);
});

$('btn-test').addEventListener('click', () => audio.testTone());
$('volume').addEventListener('input', (e) => audio.setVolume(e.target.value / 100));
$('btn-retry').addEventListener('click', () => {
  playback.loadError = null;
  audio.bufferTrackId = null;
  playback.apply();
});

// ---- connection status -----------------------------------------------------
function renderStatus() {
  const dot = $('conn-dot');
  const text = $('sync-text');
  if (!client.connected) {
    dot.className = 'dot';
    text.textContent = 'reconnecting…';
  } else if (!client.synced) {
    dot.className = 'dot warn';
    text.textContent = 'syncing clock…';
  } else {
    const uncertainty = Math.max(1, Math.round(client.rtt / 2));
    dot.className = uncertainty < 60 ? 'dot ok' : 'dot warn';
    text.textContent = `in sync (±${uncertainty} ms)`;
  }
}
client.addEventListener('open', renderStatus);
client.addEventListener('close', renderStatus);
client.addEventListener('sync', renderStatus);
client.addEventListener('error', (e) => toast(e.detail.message || 'Server error'));

// ---- reveal ----------------------------------------------------------------
function renderReveal(track) {
  $('r-art').src = track.artworkUrl || '';
  $('r-title').textContent = track.trackName || '';
  $('r-artist').textContent = track.artistName || '';
  $('r-album').textContent = [track.collectionName, track.releaseYear].filter(Boolean).join(' · ');
  const link = $('r-link');
  if (track.trackViewUrl) { link.href = track.trackViewUrl; link.classList.remove('hidden'); }
  else link.classList.add('hidden');
}

// ---- render loop -----------------------------------------------------------
let lastCountdown = null;
function tick() {
  const s = client.state;
  const v = playback.view();

  if (s && s.revealed && s.track && s.track.trackName) {
    renderReveal(s.track);
    showView('reveal');
  } else {
    showView(v.screen);
    if (v.screen === 'countdown') {
      const n = Math.ceil(v.remainingMs / 1000);
      if (n !== lastCountdown) {
        lastCountdown = n;
        const el = $('countdown');
        el.textContent = n;
        el.style.animation = 'none';
        void el.offsetWidth; // restart the pop animation
        el.style.animation = '';
      }
    } else if (v.screen === 'playing') {
      $('progress-bar').style.width = `${Math.min(100, (v.elapsed / v.duration) * 100)}%`;
    } else if (v.screen === 'error') {
      $('error-message').textContent = v.message;
    }
  }
  requestAnimationFrame(tick);
}

// Handy for debugging from the browser console.
window.__quiz = { client, audio, playback };

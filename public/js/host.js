import { QuizClient } from './quiz-client.js';
import { AudioEngine } from './audio-engine.js';
import { SyncedPlayback } from './synced-playback.js';

const $ = (id) => document.getElementById(id);

let client = null;
let playback = null;
const audio = new AudioEngine();
let selectedTrackId = null;
let results = [];

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4000);
}

$('player-link').textContent = `${location.origin}/`;
$('player-link').href = `${location.origin}/`;

// ---- PIN gate ----------------------------------------------------------------
function connectAsHost(pin) {
  client = new QuizClient({ role: 'host', pin });
  playback = new SyncedPlayback(client, audio);

  client.addEventListener('welcome', () => {
    sessionStorage.setItem('muziekquiz-pin', pin);
    $('pin-screen').classList.add('hidden');
    $('host-screen').classList.remove('hidden');
    $('pin-error').textContent = '';
  });
  client.addEventListener('error', (e) => {
    const { code, message } = e.detail;
    if (code === 'bad_pin') {
      sessionStorage.removeItem('muziekquiz-pin');
      client.close();
      client = null;
      $('pin-error').textContent = 'Wrong PIN, try again.';
      $('pin').value = '';
      $('pin').focus();
    } else {
      toast(message || 'Server error');
    }
  });
  client.addEventListener('state', render);
  client.addEventListener('open', renderStatus);
  client.addEventListener('close', renderStatus);
  client.addEventListener('sync', renderStatus);
  client.connect();
  requestAnimationFrame(tick);
}

$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = $('pin').value.trim();
  if (!pin) return;
  if (client) client.close();
  connectAsHost(pin);
});

const savedPin = sessionStorage.getItem('muziekquiz-pin');
if (savedPin) { $('pin').value = savedPin; connectAsHost(savedPin); }

// ---- status -----------------------------------------------------------------
function renderStatus() {
  const dot = $('conn-dot');
  const text = $('sync-text');
  if (!client || !client.connected) {
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

// ---- search -----------------------------------------------------------------
let searchTimer = null;
let searchSeq = 0;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const term = $('search').value.trim();
  if (term.length < 2) { $('search-status').textContent = 'Type at least two characters.'; return; }
  $('search-status').textContent = 'Searching…';
  searchTimer = setTimeout(() => runSearch(term), 400);
});

async function runSearch(term) {
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/search?term=${encodeURIComponent(term)}`);
    const data = await res.json();
    if (seq !== searchSeq) return; // a newer search has started
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    results = data.results;
    $('search-status').textContent = results.length ? `${results.length} results` : 'No results with a preview clip.';
    renderResults();
  } catch (err) {
    if (seq !== searchSeq) return;
    $('search-status').textContent = `Search failed: ${err.message}`;
  }
}

const localPreview = $('local-preview');
let previewingId = null;
localPreview.addEventListener('ended', () => { previewingId = null; renderResults(); });
localPreview.addEventListener('pause', () => { previewingId = null; renderResults(); });

function toggleLocalPreview(track) {
  if (previewingId === track.trackId) {
    localPreview.pause();
    previewingId = null;
  } else {
    previewingId = track.trackId;
    localPreview.src = `/preview/${track.trackId}`;
    localPreview.volume = 0.6;
    localPreview.play().catch((err) => toast(`Preview failed: ${err.message}`));
  }
  renderResults();
}

function renderResults() {
  const ul = $('results');
  ul.replaceChildren();
  for (const t of results) {
    const li = document.createElement('li');
    li.className = 'result' + (t.trackId === selectedTrackId ? ' selected' : '');
    const img = document.createElement('img');
    img.src = t.artworkUrl ? t.artworkUrl.replace('600x600bb', '120x120bb') : '';
    img.alt = '';
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.trackName;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [t.artistName, t.collectionName, t.releaseYear].filter(Boolean).join(' · ');
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btnPrev = document.createElement('button');
    btnPrev.textContent = previewingId === t.trackId ? '■' : '▶';
    btnPrev.title = 'Listen on this device only';
    btnPrev.addEventListener('click', () => toggleLocalPreview(t));
    const btnSel = document.createElement('button');
    btnSel.className = 'primary';
    btnSel.textContent = 'Select';
    btnSel.addEventListener('click', () => selectTrack(t));
    actions.append(btnPrev, btnSel);
    li.append(img, info, actions);
    ul.append(li);
  }
}

function selectTrack(t) {
  if (!client) return;
  localPreview.pause();
  selectedTrackId = t.trackId;
  renderResults();
  client.send({ type: 'prepare', trackId: t.trackId });
}

// ---- round controls ------------------------------------------------------------
$('btn-start').addEventListener('click', () => {
  client.send({ type: 'start', countdownMs: Number($('countdown-select').value) });
});
$('btn-stop').addEventListener('click', () => client.send({ type: 'stop' }));
$('btn-reveal').addEventListener('click', () => client.send({ type: 'reveal' }));
$('btn-reset').addEventListener('click', () => {
  selectedTrackId = null;
  renderResults();
  client.send({ type: 'reset' });
});

$('local-play').addEventListener('change', async (e) => {
  if (e.target.checked) {
    try { await playback.enable(); } catch (err) { toast(`Audio failed: ${err.message}`); e.target.checked = false; return; }
    $('local-volume').classList.remove('hidden');
  } else {
    playback.disable();
    $('local-volume').classList.add('hidden');
  }
});
$('volume').addEventListener('input', (e) => audio.setVolume(e.target.value / 100));

// ---- rendering ------------------------------------------------------------------
function render() {
  const s = client.state;
  if (!s) return;

  $('st-players').textContent = s.players;
  $('st-ready').textContent = s.track ? `${s.ready}/${s.players}` : '–';

  if (s.track && s.track.trackName) {
    $('no-track').classList.add('hidden');
    $('current').classList.remove('hidden');
    $('c-art').src = s.track.artworkUrl || '';
    $('c-title').textContent = s.track.trackName;
    $('c-artist').textContent = s.track.artistName;
    $('c-album').textContent = [s.track.collectionName, s.track.releaseYear].filter(Boolean).join(' · ');
    if (selectedTrackId !== s.track.trackId) { selectedTrackId = s.track.trackId; renderResults(); }
  } else {
    $('no-track').classList.remove('hidden');
    $('current').classList.add('hidden');
  }

  const hasTrack = !!s.track;
  $('btn-start').disabled = !hasTrack;
  $('btn-start').textContent = s.phase === 'started' ? '▶ Play again' : '▶ Start for everyone';
  $('btn-stop').disabled = s.phase !== 'started';
  $('btn-reveal').disabled = !hasTrack || s.revealed;
  $('btn-reveal').textContent = s.revealed ? 'Revealed' : 'Reveal answer';
  $('btn-reset').disabled = !hasTrack;
}

function tick() {
  if (client && client.state) {
    const s = client.state;
    const pill = $('phase');
    let phase = 'idle';
    let timer = '–';
    let label = 'countdown';
    if (s.track) {
      if (s.phase === 'prepared') phase = 'ready';
      else if (s.phase === 'started' && client.synced) {
        const remaining = s.startAt - client.serverNow();
        if (remaining > 0) { phase = 'countdown'; timer = (remaining / 1000).toFixed(1); }
        else {
          const elapsed = -remaining / 1000;
          const duration = audio.buffer && audio.bufferTrackId === s.track.trackId ? audio.buffer.duration : 30;
          if (elapsed < duration) { phase = 'playing'; timer = `${Math.floor(elapsed)}s`; label = 'playing'; }
          else { phase = 'finished'; timer = 'done'; label = 'clip ended'; }
        }
      }
    }
    if (s.revealed) phase = 'revealed';
    pill.textContent = phase;
    pill.dataset.phase = phase;
    $('st-timer').textContent = timer;
    $('st-timer-label').textContent = label;
  }
  requestAnimationFrame(tick);
}

'use strict';
/**
 * Muziekquiz server
 *
 *  - Serves the static player page (/) and host page (/host)
 *  - Proxies and caches iTunes Search API queries   (GET /api/search?term=...)
 *  - Proxies and caches 30 s preview clips          (GET /preview/<trackId>)
 *  - Runs the WebSocket endpoint (/ws) that carries:
 *      * clock synchronisation (ping/pong with server timestamps)
 *      * quiz state broadcasts (prepare / start / stop / reveal / reset)
 *
 * Configuration via environment variables:
 *   PORT            TCP port to listen on            (default 3000)
 *   HOST_PIN        PIN the quizmaster must enter    (default 1234)
 *   ITUNES_COUNTRY  iTunes storefront country code   (default NL)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST_PIN = process.env.HOST_PIN || '1234';
const ITUNES_COUNTRY = process.env.ITUNES_COUNTRY || 'NL';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// iTunes search (cached, results remembered by trackId for later lookups)
// ---------------------------------------------------------------------------
const SEARCH_TTL_MS = 60 * 60 * 1000;
const searchCache = new Map(); // term -> { at, results }
const tracks = new Map();      // trackId -> normalised track

function normalizeTrack(r) {
  return {
    trackId: r.trackId,
    trackName: r.trackName,
    artistName: r.artistName,
    collectionName: r.collectionName || '',
    releaseYear: r.releaseDate ? String(r.releaseDate).slice(0, 4) : '',
    artworkUrl: (r.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
    trackViewUrl: r.trackViewUrl || '',
    previewUrl: r.previewUrl,
  };
}

async function searchItunes(term) {
  const key = term.trim().toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;

  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', term);
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', '25');
  url.searchParams.set('country', ITUNES_COUNTRY);

  const res = await fetch(url, { headers: { 'User-Agent': 'muziekquiz/1.0' } });
  if (!res.ok) throw new Error(`iTunes responded with HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || [])
    .filter((r) => r.previewUrl && r.trackId)
    .map(normalizeTrack);
  for (const t of results) tracks.set(t.trackId, t);
  searchCache.set(key, { at: Date.now(), results });
  return results;
}

// ---------------------------------------------------------------------------
// Preview clip proxy. One fetch from Apple per track, served to all clients.
// ---------------------------------------------------------------------------
const PREVIEW_CACHE_MAX = 12;
const previewCache = new Map(); // trackId -> Promise<{ buf, type }>
const ALLOWED_PREVIEW_HOSTS = /(^|\.)(itunes\.apple\.com|mzstatic\.com|apple\.com)$/i;

function getPreview(trackId) {
  if (previewCache.has(trackId)) return previewCache.get(trackId);
  const track = tracks.get(trackId);
  if (!track) return Promise.reject(new Error('Unknown track. Search again.'));

  let u;
  try { u = new URL(track.previewUrl); } catch { return Promise.reject(new Error('Bad preview URL')); }
  if (u.protocol !== 'https:' || !ALLOWED_PREVIEW_HOSTS.test(u.hostname)) {
    return Promise.reject(new Error('Preview host not allowed'));
  }

  const p = (async () => {
    const res = await fetch(u, { headers: { 'User-Agent': 'muziekquiz/1.0' } });
    if (!res.ok) throw new Error(`Preview fetch failed with HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Apple labels previews audio/x-m4p; browsers are happier with the standard type.
    return { buf, type: 'audio/mp4' };
  })();
  p.catch(() => previewCache.delete(trackId));
  previewCache.set(trackId, p);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    previewCache.delete(previewCache.keys().next().value);
  }
  return p;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let file = pathname;
  if (file === '/') file = '/index.html';
  else if (file === '/host') file = '/host.html';
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (pathname === '/api/search') {
      const term = (url.searchParams.get('term') || '').trim();
      if (term.length < 2) return sendJson(res, 400, { error: 'Search term too short' });
      const results = await searchItunes(term);
      return sendJson(res, 200, { results: results.map(({ previewUrl, ...rest }) => rest) });
    }

    if (pathname.startsWith('/preview/')) {
      const trackId = Number(pathname.slice('/preview/'.length));
      if (!Number.isInteger(trackId)) return sendJson(res, 400, { error: 'Bad track id' });
      const { buf, type } = await getPreview(trackId);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(buf);
    }

    if (pathname === '/api/state') return sendJson(res, 200, publicState(false));
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, serverTime: Date.now() });

    return serveStatic(res, pathname);
  } catch (err) {
    log('HTTP error', req.url, err.message);
    return sendJson(res, 502, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Quiz state and WebSocket protocol
// ---------------------------------------------------------------------------
const quiz = {
  phase: 'idle',   // idle | prepared | started
  track: null,     // full normalised track (never sent with previewUrl)
  startAt: null,   // server time (ms since epoch) at which playback starts
  revealed: false,
  round: 0,
};

const wss = new WebSocketServer({ server, path: '/ws' });

function countConnections(role) {
  let n = 0;
  for (const ws of wss.clients) if (ws.meta && ws.meta.role === role) n++;
  return n;
}
function countReady() {
  if (!quiz.track) return 0;
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.meta && ws.meta.role === 'player' && ws.meta.readyTrackId === quiz.track.trackId) n++;
  }
  return n;
}

function publicState(forHost) {
  const s = {
    phase: quiz.phase,
    startAt: quiz.startAt,
    revealed: quiz.revealed,
    round: quiz.round,
    serverTime: Date.now(),
    players: countConnections('player'),
    hosts: countConnections('host'),
    ready: countReady(),
    track: null,
  };
  if (quiz.track) {
    if (forHost || quiz.revealed) {
      const { previewUrl, ...rest } = quiz.track;
      s.track = rest;
    } else {
      s.track = { trackId: quiz.track.trackId }; // enough to fetch /preview/<id>, nothing more
    }
  }
  return s;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastState({ hostsOnly = false } = {}) {
  let hostMsg, playerMsg;
  for (const ws of wss.clients) {
    if (!ws.meta || !ws.meta.role) continue;
    if (ws.meta.role === 'host') {
      hostMsg ??= JSON.stringify({ type: 'state', state: publicState(true) });
      if (ws.readyState === WebSocket.OPEN) ws.send(hostMsg);
    } else if (!hostsOnly) {
      playerMsg ??= JSON.stringify({ type: 'state', state: publicState(false) });
      if (ws.readyState === WebSocket.OPEN) ws.send(playerMsg);
    }
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

async function handleHostCommand(ws, msg) {
  switch (msg.type) {
    case 'prepare': {
      const track = tracks.get(Number(msg.trackId));
      if (!track) return send(ws, { type: 'error', message: 'Unknown track, please search again.' });
      try {
        await getPreview(track.trackId); // warm the cache before anyone asks for it
      } catch (err) {
        return send(ws, { type: 'error', message: `Could not fetch preview: ${err.message}` });
      }
      quiz.phase = 'prepared';
      quiz.track = track;
      quiz.startAt = null;
      quiz.revealed = false;
      quiz.round += 1;
      log(`round ${quiz.round}: prepared "${track.artistName} - ${track.trackName}"`);
      return broadcastState();
    }
    case 'start': {
      if (!quiz.track) return send(ws, { type: 'error', message: 'Select a track first.' });
      const countdownMs = clamp(Number(msg.countdownMs) || 5000, 1000, 30000);
      quiz.startAt = Date.now() + countdownMs;
      quiz.phase = 'started';
      log(`round ${quiz.round}: start in ${countdownMs} ms (at ${new Date(quiz.startAt).toISOString()})`);
      return broadcastState();
    }
    case 'stop': {
      if (!quiz.track) return;
      quiz.phase = 'prepared';
      quiz.startAt = null;
      log(`round ${quiz.round}: stopped`);
      return broadcastState();
    }
    case 'reveal': {
      if (!quiz.track) return;
      quiz.revealed = true;
      log(`round ${quiz.round}: revealed`);
      return broadcastState();
    }
    case 'reset': {
      quiz.phase = 'idle';
      quiz.track = null;
      quiz.startAt = null;
      quiz.revealed = false;
      log('reset to idle');
      return broadcastState();
    }
    default:
      return send(ws, { type: 'error', message: `Unknown command ${msg.type}` });
  }
}

wss.on('connection', (ws, req) => {
  ws.meta = { role: null, readyTrackId: null, alive: true };
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  ws.on('pong', () => { ws.meta.alive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Clock sync: answer immediately, before anything else, to keep latency minimal.
    if (msg.type === 'ping') {
      return send(ws, { type: 'pong', t0: msg.t0, t1: Date.now() });
    }

    if (msg.type === 'hello') {
      let role = 'player';
      if (msg.role === 'host') {
        if (String(msg.pin) !== HOST_PIN) {
          return send(ws, { type: 'error', code: 'bad_pin', message: 'Wrong PIN' });
        }
        role = 'host';
      }
      ws.meta.role = role;
      log(`${role} connected from ${ip}`);
      send(ws, { type: 'welcome', role, state: publicState(role === 'host') });
      return broadcastState({ hostsOnly: true });
    }

    if (!ws.meta.role) return; // must say hello first

    if (msg.type === 'ready') {
      ws.meta.readyTrackId = Number(msg.trackId);
      return broadcastState({ hostsOnly: true });
    }

    if (ws.meta.role !== 'host') {
      return send(ws, { type: 'error', message: 'Not authorised' });
    }
    await handleHostCommand(ws, msg);
  });

  ws.on('close', () => {
    if (ws.meta.role) {
      log(`${ws.meta.role} disconnected`);
      broadcastState({ hostsOnly: true });
    }
  });
});

// Drop dead connections so player counts stay honest.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.meta.alive) { ws.terminate(); continue; }
    ws.meta.alive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log(`Muziekquiz listening on http://0.0.0.0:${PORT}`);
  log(`  player page : http://localhost:${PORT}/`);
  log(`  host page   : http://localhost:${PORT}/host   (PIN: ${HOST_PIN})`);
});

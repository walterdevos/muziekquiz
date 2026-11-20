# Muziekquiz

A synchronised music quiz. The quizmaster searches a song on the **host page**,
every participant has the **player page** open at home, and when the host presses
*Start* all devices count down together and begin the 30-second preview at the
same instant.

```
┌────────────┐   WebSocket    ┌─────────────┐   WebSocket    ┌────────────┐
│  host page │ ─────────────▶ │  server.js  │ ◀────────────▶ │ player page│ × N
│  /host     │  prepare/start │  (Node.js)  │  state + sync  │  /         │
└────────────┘                └──────┬──────┘                └────────────┘
                                     │ HTTPS
                                     ▼
                         iTunes Search API + preview CDN
```

## Quick start

```bash
npm install
HOST_PIN=4321 npm start          # default PIN is 1234, default port 3000
```

* Players open `http://<host>:3000/` and tap **Join the quiz** (one tap is required
  before a browser may play sound).
* The quizmaster opens `http://<host>:3000/host`, enters the PIN, searches, presses
  **Select** on a song, then **Start for everyone**.

### Environment variables

| Variable         | Default | Purpose                                              |
|------------------|---------|------------------------------------------------------|
| `PORT`           | `3000`  | TCP port                                             |
| `HOST_PIN`       | `1234`  | PIN required to unlock the host controls             |
| `ITUNES_COUNTRY` | `NL`    | iTunes storefront used for search results            |

## Running behind a reverse proxy (recommended for the public URL)

Use HTTPS on the public URL. Browsers then connect with `wss://`, and the
WebSocket upgrade must be forwarded. Nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name quiz.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

Keep the server running with systemd, pm2, or a container. A minimal unit:

```ini
[Service]
WorkingDirectory=/var/www/html/muziekquiz
Environment=PORT=3000 HOST_PIN=4321
ExecStart=/usr/local/bin/node server.js
Restart=always
```

## How a round works

1. **Prepare.** Host selects a track. The server downloads the preview once,
   caches it, and broadcasts the round. Every player downloads the clip from
   the server (`/preview/<trackId>`), decodes it, and reports *ready*. The host
   sees "clip loaded 12/14".
2. **Start.** Host picks a countdown (3 to 10 s). The server sets
   `startAt = now + countdown` in *server time* and broadcasts it.
3. **Play.** Each player converts `startAt` to its own clock using the measured
   offset and schedules the decoded buffer on the Web Audio hardware clock.
   Players who join late jump into the clip at the correct position.
4. **Reveal / Stop / Clear.** Reveal pushes title, artist, artwork and an Apple
   Music link to all players. Stop silences everyone (Start again replays).
   Clear returns to idle.

Players never receive the title or artwork before the reveal, only the numeric
track id.

## Clock synchronisation

Every client runs a small NTP-style exchange over the same WebSocket:

```
client → { type:"ping", t0 }            t0 = performance.now()
server → { type:"pong", t0, t1 }        t1 = server Date.now()
client:   t2 = performance.now()
          rtt    = t2 − t0
          offset = t1 − (t0 + rtt/2)    so  serverTime ≈ performance.now() + offset
```

A burst of 8 pings is sent on connect and 4 more every 10 s. The sample with the
lowest round-trip time in the last minute wins, because it suffered the least
queuing delay. The uncertainty shown in the page header is `rtt / 2`.

Playback is then scheduled with `AudioContext.getOutputTimestamp()`, which maps
the audio hardware position to `performance.now()` and already accounts for the
device's output latency. If the clock estimate improves during the countdown the
start is moved accordingly. Typical spread between devices on home broadband is
well under 50 ms; the limiting factor is Bluetooth speakers and headphones,
which add their own 100 to 200 ms that the browser cannot see.

## WebSocket protocol (`/ws`)

Client → server

| Message                                   | Who    | Effect                                   |
|-------------------------------------------|--------|------------------------------------------|
| `{type:"hello", role, pin?}`              | all    | Register as `player` or `host` (PIN)     |
| `{type:"ping", t0}`                       | all    | Clock sync                               |
| `{type:"ready", trackId}`                 | player | Clip decoded and ready                   |
| `{type:"prepare", trackId}`               | host   | Choose the track for the next round      |
| `{type:"start", countdownMs}`             | host   | Schedule playback (1 000 to 30 000 ms)   |
| `{type:"stop"}`                           | host   | Silence everyone, keep the track         |
| `{type:"reveal"}`                         | host   | Show the answer on all players           |
| `{type:"reset"}`                          | host   | Back to idle                             |

Server → client

| Message                                   | Notes                                                      |
|-------------------------------------------|------------------------------------------------------------|
| `{type:"welcome", role, state}`           | After a successful hello                                   |
| `{type:"state", state}`                   | On every change                                            |
| `{type:"pong", t0, t1}`                   | Clock sync reply                                           |
| `{type:"error", code?, message}`          | `code:"bad_pin"` on a wrong PIN                            |

`state` = `{ phase: "idle"|"prepared"|"started", startAt, revealed, round,
serverTime, players, hosts, ready, track }`. Players get `track: { trackId }`
until the reveal; hosts always get the full metadata.

## HTTP endpoints

| Path                      | Purpose                                                        |
|---------------------------|----------------------------------------------------------------|
| `/`                       | Player page                                                    |
| `/host`                   | Host page                                                      |
| `/api/search?term=…`      | iTunes search, cached one hour per term                        |
| `/preview/<trackId>`      | Preview clip, fetched from Apple once and served from memory   |
| `/api/state`              | Current public state (debugging)                               |
| `/healthz`                | Liveness check                                                 |

## Project layout

```
server.js                  HTTP + WebSocket server, iTunes proxy, quiz state
public/index.html          player page
public/host.html           host page
public/js/quiz-client.js   WebSocket client + clock sync
public/js/audio-engine.js  Web Audio decoding and sample-accurate scheduling
public/js/synced-playback.js  joins state, clock and audio; preload + schedule
public/js/player.js        player UI
public/js/host.js          host UI (PIN, search, controls)
public/css/style.css
```

## Notes and limits

* Previews come from Apple's iTunes Search API. Apple's terms expect previews to
  promote content on iTunes/Apple Music, so the reveal links to the track and the
  footer credits the API. Search results are cached because the API allows
  roughly 20 requests per minute per IP.
* Quiz state lives in memory. Restarting the server clears the current round;
  connected pages reconnect automatically.
* One quiz room per server instance.
# muziekquiz
# muziekquiz
# muziekquiz

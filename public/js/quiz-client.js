/**
 * QuizClient: WebSocket connection + clock synchronisation.
 *
 * Clock sync works like a simplified NTP exchange:
 *   client sends   { type:'ping', t0 }           t0 = performance.now()
 *   server replies { type:'pong', t0, t1 }       t1 = server Date.now()
 *   client notes   t2 = performance.now()
 *   rtt    = t2 - t0
 *   offset = t1 - (t0 + rtt / 2)                  serverTime ≈ performance.now() + offset
 *
 * We keep a sliding window of samples and trust the one with the lowest
 * round-trip time, because that sample had the least queuing noise.
 *
 * Events: 'open', 'close', 'welcome', 'state', 'sync', 'error'
 */
export class QuizClient extends EventTarget {
  constructor({ role = 'player', pin = '' } = {}) {
    super();
    this.role = role;
    this.pin = pin;
    this.ws = null;
    this.state = null;
    this.offset = 0;
    this.rtt = null;
    this.synced = false;
    this.samples = [];
    this.backoff = 500;
    this._syncTimer = null;
    this._closedByUser = false;
  }

  connect() {
    this._closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = 500;
      this.send({ type: 'hello', role: this.role, pin: this.pin });
      this.syncBurst(8);
      clearInterval(this._syncTimer);
      this._syncTimer = setInterval(() => this.syncBurst(4), 10000);
      this._emit('open');
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'pong': this._onPong(msg); break;
        case 'welcome':
          this.state = msg.state;
          this._emit('welcome', msg);
          this._emit('state', msg.state);
          break;
        case 'state':
          this.state = msg.state;
          this._emit('state', msg.state);
          break;
        case 'error':
          this._emit('error', msg);
          break;
      }
    });

    ws.addEventListener('close', () => {
      clearInterval(this._syncTimer);
      this._emit('close');
      if (this._closedByUser) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    });

    ws.addEventListener('error', () => { /* close event follows */ });
  }

  close() {
    this._closedByUser = true;
    clearInterval(this._syncTimer);
    if (this.ws) this.ws.close();
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  syncBurst(n) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.send({ type: 'ping', t0: performance.now() }), i * 120);
    }
  }

  _onPong({ t0, t1 }) {
    const t2 = performance.now();
    const rtt = t2 - t0;
    const offset = t1 - (t0 + rtt / 2);
    this.samples.push({ offset, rtt, at: t2 });
    // keep the most recent minute, at most 16 samples
    this.samples = this.samples.filter((s) => t2 - s.at < 60000).slice(-16);
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = true;
    this._emit('sync', { offset: this.offset, rtt: this.rtt });
  }

  /** Current server time in ms since epoch, as estimated on this device. */
  serverNow() {
    return performance.now() + this.offset;
  }

  /** Convert a server timestamp to this device's performance.now() clock. */
  toLocal(serverMs) {
    return serverMs - this.offset;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * AudioEngine: decodes a preview clip into memory and starts it at an exact
 * moment on the audio hardware clock, so every device begins within a few
 * milliseconds of one another.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.bufferTrackId = null;
    this.source = null;
    this.volume = 0.8;
    this.playing = false;
    this.onended = null;
    this._loading = null;
  }

  /** Must be called from a user gesture (click/tap) to satisfy autoplay rules. */
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    // iOS needs a real (silent) buffer to be played once before scheduling works.
    const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = silent;
    s.connect(this.ctx.destination);
    s.start();
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  /** Download and decode /preview/<trackId>. Repeated calls for the same id share one request. */
  load(trackId) {
    if (this.bufferTrackId === trackId && this.buffer) return Promise.resolve(this.buffer);
    if (this._loading && this._loading.trackId === trackId) return this._loading.promise;
    if (!this.ctx) return Promise.reject(new Error('Audio not unlocked yet'));

    const promise = (async () => {
      const res = await fetch(`/preview/${trackId}`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`Preview download failed (HTTP ${res.status})`);
      const ab = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      this.buffer = buf;
      this.bufferTrackId = trackId;
      return buf;
    })();
    this._loading = { trackId, promise };
    promise.finally(() => { if (this._loading && this._loading.trackId === trackId) this._loading = null; });
    return promise;
  }

  /**
   * Translate a performance.now() timestamp into the AudioContext timeline.
   * getOutputTimestamp() pairs the audio output position with a performance
   * time, which already compensates for output latency on most browsers.
   */
  perfToContextTime(perfMs) {
    const ctx = this.ctx;
    let contextTime, performanceTime;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      // Only trust the pair when it is fresh and plausible; some browsers hand
      // back stale values right after resume() or while the tab is hidden.
      if (
        ts && ts.performanceTime > 0 && ts.contextTime >= 0 &&
        Math.abs(performance.now() - ts.performanceTime) < 500 &&
        Math.abs(ctx.currentTime - ts.contextTime) < 0.5
      ) {
        contextTime = ts.contextTime;
        performanceTime = ts.performanceTime;
      }
    }
    if (contextTime === undefined) {
      // Fallback: assume the clocks run in step and subtract the known output latency.
      contextTime = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
      performanceTime = performance.now();
    }
    return contextTime + (perfMs - performanceTime) / 1000;
  }

  /**
   * Start the loaded buffer so that audio is heard at local time `startPerfMs`
   * (a performance.now() value). If that moment has already passed, jump into
   * the clip at the right position so late joiners are still in sync.
   */
  playAt(startPerfMs) {
    this.stop();
    const buf = this.buffer;
    if (!buf || !this.ctx) return false;
    const ctx = this.ctx;
    const when = this.perfToContextTime(startPerfMs);
    const now = ctx.currentTime;
    const margin = 0.03; // scheduling safety margin in seconds

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    if (when >= now + margin) {
      src.start(when, 0);
    } else {
      const offset = now + margin - when;
      if (offset >= buf.duration) return false;
      src.start(now + margin, offset);
    }
    this.source = src;
    this.playing = true;
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.source = null;
        if (this.onended) this.onended();
      }
    };
    return true;
  }

  stop() {
    if (this.source) {
      const src = this.source;
      this.source = null;
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.playing = false;
  }

  /** Short beep so a participant can check that sound comes out of the right speakers. */
  testTone() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, this.ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4);
    osc.connect(g).connect(this.gain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.45);
  }
}

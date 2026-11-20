/**
 * SyncedPlayback glues QuizClient (state + clock) to AudioEngine (sound).
 *
 * It preloads the clip as soon as the host prepares a round, reports
 * readiness to the server, schedules playback at the shared start time,
 * and re-schedules if the clock estimate improves before the start.
 *
 * view() returns a plain description of what the screen should show.
 */
export class SyncedPlayback extends EventTarget {
  constructor(client, audio) {
    super();
    this.client = client;
    this.audio = audio;
    this.enabled = false;
    this.scheduledKey = null;
    this.scheduledLocalStart = null;
    this.loadingId = null;
    this.loadError = null;

    client.addEventListener('state', () => this.apply());
    client.addEventListener('sync', () => this.apply());
    audio.onended = () => this._emit();
  }

  async enable() {
    await this.audio.unlock();
    this.enabled = true;
    this.apply();
  }

  disable() {
    this.enabled = false;
    this.audio.stop();
    this.scheduledKey = null;
    this.scheduledLocalStart = null;
    this._emit();
  }

  async apply() {
    const s = this.client.state;
    if (!s) return;

    if (!s.track) {
      this.audio.stop();
      this.scheduledKey = null;
      this.loadError = null;
      return this._emit();
    }

    // Preload the clip for this round.
    if (this.enabled && this.audio.bufferTrackId !== s.track.trackId) {
      if (this.loadingId === s.track.trackId) return; // another apply() is already loading it
      this.loadingId = s.track.trackId;
      this.loadError = null;
      this._emit();
      try {
        await this.audio.load(s.track.trackId);
        this.client.send({ type: 'ready', trackId: s.track.trackId });
      } catch (err) {
        this.loadError = err.message || String(err);
        this.loadingId = null;
        return this._emit();
      }
      this.loadingId = null;
      return this.apply(); // state may have moved on while we were downloading
    }

    if (s.phase === 'prepared') {
      if (this.scheduledKey) {
        this.audio.stop();
        this.scheduledKey = null;
        this.scheduledLocalStart = null;
      }
    } else if (s.phase === 'started' && this.enabled && this.client.synced) {
      const key = `${s.round}:${s.startAt}`;
      const localStart = this.client.toLocal(s.startAt);
      if (this.scheduledKey !== key) {
        this.scheduledKey = key;
        this.scheduledLocalStart = localStart;
        this.audio.playAt(localStart);
      } else if (
        this.scheduledLocalStart !== null &&
        Math.abs(localStart - this.scheduledLocalStart) > 15 &&
        localStart - performance.now() > 250
      ) {
        // Clock estimate improved and there is still time: move the start.
        this.scheduledLocalStart = localStart;
        this.audio.playAt(localStart);
      }
    }
    this._emit();
  }

  view() {
    const s = this.client.state;
    if (!this.client.connected || !s) return { screen: 'connecting' };
    if (!s.track) return { screen: 'idle' };
    if (this.loadingId) return { screen: 'loading' };
    if (this.loadError) return { screen: 'error', message: this.loadError };
    if (s.phase === 'prepared') return { screen: 'ready' };
    if (!this.client.synced) return { screen: 'syncing' };
    const remaining = s.startAt - this.client.serverNow();
    if (remaining > 0) return { screen: 'countdown', remainingMs: remaining };
    const duration = this.audio.buffer ? this.audio.buffer.duration : 30;
    const elapsed = -remaining / 1000;
    if (elapsed < duration) return { screen: 'playing', elapsed, duration };
    return { screen: 'finished' };
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

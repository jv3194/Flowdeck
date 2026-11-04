// Music playback: queue, shuffle/repeat, spectrum analysis and OS media-key support.
import { mediaUrl } from './api.js';
import { Emitter, clamp } from './util.js';

const BARS = 72;

export class AudioEngine extends Emitter {
  constructor() {
    super();
    this.el = new Audio();
    this.el.preload = 'auto';
    this.queue = [];
    this.order = [];
    this.at = -1; // position within `order`
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.errors = 0;
    this.bins = new Uint8Array(1024);
    this.bars = new Float32Array(BARS);
    this.level = 0;
    this.coverFor = () => null;

    const el = this.el;
    el.addEventListener('play', () => this.emit('state'));
    el.addEventListener('pause', () => this.emit('state'));
    el.addEventListener('timeupdate', () => this.emit('time'));
    el.addEventListener('durationchange', () => this.emit('time'));
    el.addEventListener('volumechange', () => this.emit('volume'));
    el.addEventListener('playing', () => { this.errors = 0; });
    el.addEventListener('ended', () => this.next(true));
    el.addEventListener('error', () => this.onError());
    this.setupMediaSession();
  }

  get track() { return this.queue[this.order[this.at]] || null; }
  get playing() { return !this.el.paused && !this.el.ended; }
  get time() { return this.el.currentTime || 0; }
  get duration() {
    const d = this.el.duration;
    return Number.isFinite(d) ? d : this.track?.duration || 0;
  }

  /** Replace the queue and start at `index`. */
  load(tracks, index = 0, { autoplay = true } = {}) {
    this.queue = tracks;
    this.buildOrder(index);
    this.start(autoplay);
    this.emit('queue');
  }

  buildOrder(first) {
    const idx = this.queue.map((_, i) => i);
    if (this.shuffle) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      idx.splice(idx.indexOf(first), 1);
      idx.unshift(first);
    }
    this.order = idx;
    this.at = this.shuffle ? 0 : first;
  }

  start(autoplay = true) {
    const t = this.track;
    if (!t) return;
    this.ensureContext();
    this.el.src = mediaUrl(t.id);
    this.updateSession(t);
    this.emit('track', t);
    if (autoplay) this.play();
  }

  play() {
    this.ensureContext();
    this.ctx?.resume?.();
    return this.el.play().catch(() => {});
  }

  pause() { this.el.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') {
      this.el.currentTime = 0;
      this.play();
      return;
    }
    if (this.at + 1 < this.order.length) this.at++;
    else if (this.repeat === 'all' || !auto) {
      if (this.shuffle && auto) this.buildOrder(this.order[0]);
      this.at = 0;
    } else {
      this.el.pause();
      this.el.currentTime = 0;
      this.emit('state');
      return;
    }
    this.start(true);
  }

  prev() {
    if (this.time > 3 || this.at === 0) {
      this.el.currentTime = 0;
      return;
    }
    this.at--;
    this.start(true);
  }

  playIndex(i) {
    const at = this.order.indexOf(i);
    if (at < 0) return;
    this.at = at;
    this.start(true);
  }

  seek(sec) { if (this.duration) this.el.currentTime = clamp(sec, 0, this.duration); }
  seekBy(d) { this.seek(this.time + d); }
  setVolume(v) { this.el.volume = clamp(v, 0, 1); this.el.muted = false; }
  toggleMute() { this.el.muted = !this.el.muted; }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.queue.length) {
      const cur = this.order[this.at];
      this.buildOrder(cur);
    }
    this.emit('mode');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('mode');
  }

  onError() {
    const t = this.track;
    this.emit('error', t);
    // Skip over unplayable files, but stop if a whole run of them fails.
    if (++this.errors < 4 && this.at + 1 < this.order.length) setTimeout(() => this.next(true), 400);
  }

  // ------------------------------------------------------------- analysis

  ensureContext() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaElementSource(this.el);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.78;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  /** Refreshes `bars` (0..1, log-spaced) and `level` (smoothed bass energy). Cheap enough to call per frame. */
  sample() {
    if (!this.analyser || !this.playing) {
      this.level *= 0.9;
      for (let i = 0; i < BARS; i++) this.bars[i] *= 0.88;
      return;
    }
    this.analyser.getByteFrequencyData(this.bins);
    const lo = 2;
    const hi = 520;
    for (let i = 0; i < BARS; i++) {
      const a = Math.floor(lo * Math.pow(hi / lo, i / BARS));
      const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / BARS)));
      let sum = 0;
      for (let k = a; k < b; k++) sum += this.bins[k];
      const v = sum / (b - a) / 255;
      this.bars[i] = Math.max(v, this.bars[i] * 0.84);
    }
    let bass = 0;
    for (let k = 1; k < 14; k++) bass += this.bins[k];
    this.level = Math.max(bass / 13 / 255, this.level * 0.9);
  }

  // --------------------------------------------------------- media session

  updateSession(t) {
    if (!('mediaSession' in navigator)) return;
    const cover = this.coverFor(t);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: cover ? [{ src: new URL(cover, location.href).href, sizes: '512x512' }] : [],
    });
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => this.seek(d.seekTime));
    this.on('state', () => { navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused'; });
  }
}

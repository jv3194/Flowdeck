import { coverEl } from '../covers.js';
import { describe } from '../library.js';
import { makeSlider } from '../ui.js';
import { fmtTime, h, icon } from '../util.js';

export class NowPlayingScreen {
  constructor(app) {
    this.app = app;
    const { audio } = app;
    this.canvas = h('canvas', { class: 'viz' });
    this.ctx = this.canvas.getContext('2d');
    this.art = h('div', { class: 'np-art' });
    this.artWrap = h('div', { class: 'np-art-wrap' }, this.art);
    this.title = h('h2');
    this.sub = h('p', { class: 'sub' });
    this.cur = h('span', {}, '0:00');
    this.dur = h('span', {}, '0:00');
    this.seek = makeSlider((f, phase) => {
      this.scrubbing = phase !== 'end';
      audio.seek(f * audio.duration);
    });
    this.shuffleBtn = this.btn('shuffle', 'Shuffle', () => audio.toggleShuffle());
    this.repeatBtn = this.btn('repeat', 'Repeat', () => audio.cycleRepeat());
    this.playBtn = this.btn('play', 'Play / pause', () => audio.toggle(), 'big');
    this.volIcon = h('span', { onclick: () => audio.toggleMute() });
    this.vol = makeSlider((f) => audio.setVolume(f));
    this.volume = h('div', { class: 'volume' }, this.volIcon, this.vol.el);
    this.root = h('div', { class: 'np' },
      this.artWrap, this.title, this.sub,
      h('div', { class: 'seek' }, this.cur, this.seek.el, this.dur),
      h('div', { class: 'controls' }, this.shuffleBtn, this.btn('prev', 'Previous', () => audio.prev()), this.playBtn, this.btn('next', 'Next', () => audio.next()), this.repeatBtn));
    this.el = h('section', { class: 'screen nowplaying' }, this.canvas, this.root, this.volume);

    audio.on('track', () => this.track());
    audio.on('state', () => this.state());
    audio.on('time', () => this.time());
    audio.on('mode', () => this.modes());
    audio.on('volume', () => this.volumeChanged());
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  btn(name, label, fn, cls = '') {
    return h('button', { class: `round ${cls}`.trim(), tabindex: '-1', 'aria-label': label, title: label, onclick: fn }, icon(name));
  }

  coverEl() { return this.art; }

  enter() {
    this.active = true;
    this.track();
    this.state();
    this.modes();
    this.volumeChanged();
    this.resize();
    requestAnimationFrame(() => this.loop());
  }

  leave() { this.active = false; }

  track() {
    const t = this.app.audio.track;
    if (!t) return;
    this.title.textContent = t.title;
    this.sub.textContent = [t.artist, t.album].filter(Boolean).join('  —  ');
    const cover = this.app.trackCover(t);
    this.art.replaceChildren(coverEl('music', { cover, title: t.title, hue: this.app.trackHue(t) }));
    this.app.trackTheme(t);
    this.time();
  }

  state() {
    const playing = this.app.audio.playing;
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    this.root.classList.toggle('paused', !playing);
  }

  time() {
    const { audio } = this.app;
    if (!this.scrubbing) this.seek.set(audio.duration ? audio.time / audio.duration : 0);
    this.cur.textContent = fmtTime(audio.time);
    this.dur.textContent = fmtTime(audio.duration);
  }

  modes() {
    const { audio } = this.app;
    this.shuffleBtn.classList.toggle('on', audio.shuffle);
    this.repeatBtn.classList.toggle('on', audio.repeat !== 'off');
    this.repeatBtn.replaceChildren(icon(audio.repeat === 'one' ? 'repeat1' : 'repeat'));
  }

  volumeChanged() {
    const { el } = this.app.audio;
    this.vol.set(el.muted ? 0 : el.volume);
    this.volIcon.replaceChildren(icon(el.muted || el.volume === 0 ? 'mute' : 'volume'));
  }

  hints() {
    return [
      { pad: 'cross', key: 'Space', label: 'Play / pause' },
      { pad: 'L2 R2', key: 'N / P', label: 'Next / prev' },
      { pad: 'D-pad', key: '← →', label: 'Seek' },
      { pad: 'circle', key: 'Esc', label: 'Back' },
    ];
  }

  onAction(a, ev) {
    const { audio } = this.app;
    switch (a) {
      case 'confirm': case 'playpause': audio.toggle(); return true;
      case 'left': audio.seekBy(-5); return true;
      case 'right': audio.seekBy(5); return true;
      case 'up': audio.setVolume(audio.el.volume + 0.05); return true;
      case 'down': audio.setVolume(audio.el.volume - 0.05); return true;
      case 'next': case 'catNext': audio.next(); return true;
      case 'prev': case 'catPrev': audio.prev(); return true;
      case 'back': this.app.nav.back(); return true;
      case 'char': {
        const k = ev.key.toLowerCase();
        if (k === 'n') audio.next();
        else if (k === 'p') audio.prev();
        else if (k === 's') audio.toggleShuffle();
        else if (k === 'r') audio.cycleRepeat();
        else if (k === 'm') audio.toggleMute();
        else return false;
        return true;
      }
      default: return false;
    }
  }

  // ------------------------------------------------------------ visualizer

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = this.el.clientWidth * dpr;
    this.canvas.height = this.el.clientHeight * dpr;
    this.dpr = dpr;
  }

  loop() {
    if (!this.active) return;
    const { audio, bg } = this.app;
    audio.sample();
    bg.setEnergy(audio.level * 0.9);
    this.artWrap.style.transform = `scale(${(1 + audio.level * 0.045).toFixed(3)})`;
    this.draw();
    requestAnimationFrame(() => this.loop());
  }

  draw() {
    const { ctx, canvas, dpr } = this;
    const { bars } = this.app.audio;
    const w = canvas.width;
    const h2 = canvas.height;
    ctx.clearRect(0, 0, w, h2);
    const box = this.artWrap.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    if (!box.width) return;
    const cx = (box.left + box.width / 2 - host.left) * dpr;
    const cy = (box.top + box.height / 2 - host.top) * dpr;
    const r0 = (box.width / 2) * dpr * 1.1;
    const maxLen = r0 * 0.62;
    const N = 96;
    const hue = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hue')) || 320;
    const level = this.app.audio.level;
    // Light themes need darker, solid strokes: glowing additive colour disappears on a pale page.
    const light = document.documentElement.dataset.mode === 'light';

    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r0 * (1.02 + i * 0.5 * (0.3 + level)) + level * 22 * dpr * i, 0, 6.2832);
      ctx.strokeStyle = `hsla(${hue + 20},${light ? '80%,42%' : '100%,75%'},${(0.22 - i * 0.07) * (0.35 + level) * (light ? 1.6 : 1)})`;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const m = u < 0.5 ? u * 2 : (1 - u) * 2; // mirror so the ring is left/right symmetric
      const v = bars[Math.min(bars.length - 1, Math.floor(m * (bars.length - 1)))];
      const len = 4 * dpr + Math.pow(v, 1.15) * maxLen;
      const ang = u * 6.2832 - 1.5708;
      const x0 = cx + Math.cos(ang) * r0;
      const y0 = cy + Math.sin(ang) * r0;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
      ctx.strokeStyle = light
        ? `hsla(${hue + m * 70 - 10},85%,${48 - v * 10}%,${0.45 + v * 0.55})`
        : `hsla(${hue + m * 70 - 10},100%,${62 + v * 20}%,${0.35 + v * 0.65})`;
      ctx.lineWidth = 3.4 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }
}

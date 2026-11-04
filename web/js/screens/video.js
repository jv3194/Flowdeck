import { api, convertUrl } from '../api.js';
import { askFfmpeg, installFfmpeg, openFfmpegSheet, playerCaps } from '../convert.js';
import { fmtDelay, pickTrack, SIZE_NAMES, SIZES, SubtitleView, trackDetail, trackLabel } from '../subs.js';
import { ListSheet, makeSlider, toast } from '../ui.js';
import { clamp, fmtTime, h, icon } from '../util.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const IDLE_MS = 2600;

export class VideoScreen {
  constructor(app) {
    this.app = app;
    this.v = h('video', { playsinline: '', preload: 'auto' });
    this.title = h('h3');
    this.flash = h('div', { class: 'v-flash' });
    this.cur = h('span', { class: 'time' }, '0:00');
    this.dur = h('span', { class: 'time' }, '0:00');
    this.seek = makeSlider((f, phase) => {
      this.scrubbing = phase !== 'end';
      if (!this.len) return;
      // A converted stream restarts to seek, so dragging only previews the time and the jump happens on release.
      if (this.conv && this.scrubbing) this.cur.textContent = fmtTime(f * this.len);
      else this.seekTo(f * this.len);
    });
    this.playBtn = this.btn('play', 'Play / pause', () => this.toggle());
    this.volBtn = this.btn('volume', 'Mute', () => this.toggleMute());
    this.speedBtn = h('button', { class: 'round v-speed', tabindex: '-1', title: 'Speed', onclick: () => this.cycleSpeed() }, '1×');
    this.fsBtn = this.btn('fullscreen', 'Fullscreen', () => app.toggleFullscreen());
    this.ccBtn = this.btn('cc', 'Subtitles (C)', () => this.openTrackPicker());
    this.vol = makeSlider((f) => { this.v.volume = f; this.v.muted = false; });
    this.vol.el.style.cssText = 'width:96px;flex:none';
    this.subsEl = h('div', { class: 'subs' });
    this.subs = new SubtitleView(this.subsEl);
    this.tracks = [];
    this.track = null;
    this.offset = 0; // subtitle delay in seconds, remembered per video
    this.subToken = 0; // lets a slow subtitle request notice it has been superseded
    this.conv = null; // { base, duration, caps, force, mode } while the video is being converted by ffmpeg
    this.loadToken = 0; // lets a slow "what does this video need?" answer notice it has been superseded
    this.speed = 1;
    this.badge = h('span', { class: 'v-badge' });
    this.badge.style.display = 'none';

    const top = h('div', { class: 'v-top' }, this.btn('back', 'Back', () => app.nav.back()), this.title, this.badge);
    const bottom = h('div', { class: 'v-bottom' },
      h('div', { class: 'seek' }, this.cur, this.seek.el, this.dur),
      h('div', { class: 'v-row' }, this.playBtn, this.btn('back10', 'Back 10 seconds', () => this.skip(-10)), this.btn('fwd10', 'Forward 10 seconds', () => this.skip(10)),
        this.btn('prev', 'Previous video', () => this.step(-1)), this.btn('next', 'Next video', () => this.step(1)),
        h('span', { class: 'grow' }), this.ccBtn, this.speedBtn, this.volBtn, this.vol.el, this.fsBtn));
    this.ui = h('div', { class: 'v-ui' }, top, bottom);
    // Subtitles sit under the controls so the control bar always stays clickable.
    this.el = h('section', { class: 'screen video' }, this.v, this.subsEl, this.ui, this.flash, h('div', { class: 'v-spin' }));

    const v = this.v;
    v.addEventListener('play', () => this.state());
    v.addEventListener('pause', () => { this.state(); this.saveProgress(); this.wake(); });
    v.addEventListener('timeupdate', () => this.time());
    v.addEventListener('durationchange', () => this.time());
    v.addEventListener('progress', () => this.buffered());
    v.addEventListener('volumechange', () => this.volume());
    v.addEventListener('waiting', () => this.el.classList.add('wait'));
    v.addEventListener('playing', () => this.el.classList.remove('wait'));
    v.addEventListener('canplay', () => this.el.classList.remove('wait'));
    v.addEventListener('ended', () => this.ended());
    v.addEventListener('error', () => this.failed());
    v.addEventListener('loadedmetadata', () => this.checkPicture());
    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => app.toggleFullscreen());
    this.el.addEventListener('pointermove', () => this.wake());
    setInterval(() => { if (this.active && !v.paused) this.saveProgress(); }, 5000);
  }

  btn(name, label, fn) {
    return h('button', { class: 'round', tabindex: '-1', title: label, 'aria-label': label, onclick: fn }, icon(name));
  }

  enter({ list, index }) {
    this.active = true;
    this.list = list;
    const { audio, prefs } = this.app;
    this.wasMusic = audio.playing;
    audio.pause();
    this.v.volume = prefs.videoVolume ?? 0.9;
    this.applySize();
    this.load(index);
    this.app.setTint(214, 0.5);
    this.wake();
    const frame = () => {
      if (!this.active) return;
      this.subs.update(this.pos);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  leave() {
    this.active = false;
    this.loadToken++;
    cancelAnimationFrame(this.raf);
    this.subToken++;
    this.subs.clear();
    this.saveProgress();
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.conv = null;
    this.badge.style.display = 'none';
    clearTimeout(this.idle);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  coverEl() { return null; }

  load(i) {
    this.saveProgress();
    this.index = clamp(i, 0, this.list.length - 1);
    const item = (this.item = this.list[this.index]);
    this.title.textContent = item.displayTitle || item.title;
    this.conv = null;
    this.forced = false;
    this.declined = false; // said "play it without converting" for this video
    this.restarts = 0;
    this.badge.style.display = 'none';
    this.el.classList.add('wait');
    this.loadSubs(item);
    this.begin(item, ++this.loadToken);
  }

  /**
   * Start playing `item`. Most videos play as they are. One the player can't decode (see server/transcode.js)
   * is converted on the fly by ffmpeg, which is offered for download the first time it is needed.
   * `force` converts everything: it is used when a file that looked fine failed to play.
   */
  async begin(item, token, { force = false } = {}) {
    const resume = this.app.prefs.progress?.[item.id];
    let plan = null;
    if (this.app.prefs.convert !== false || force) {
      try {
        plan = await api.play(item.id, await playerCaps(), force);
      } catch {
        /* the server couldn't tell: play it as it is */
      }
      if (token !== this.loadToken) return;
    }
    if (plan && plan.mode !== 'direct' && plan.ffmpeg.state !== 'ready') {
      const choice = await askFfmpeg(this.app, plan);
      if (token !== this.loadToken) return;
      if (choice === 'never') this.app.patchPrefs({ convert: false });
      this.declined = choice !== 'download';
      plan = null;
      if (choice === 'download' && (await installFfmpeg(this.app))) {
        if (token !== this.loadToken) return;
        plan = await api.play(item.id, await playerCaps(), force).catch(() => null);
        if (token !== this.loadToken) return;
      }
    }
    if (plan && plan.mode !== 'direct' && plan.ffmpeg.state === 'ready') {
      this.conv = { base: 0, duration: plan.duration, caps: await playerCaps(), force, mode: plan.mode };
      this.badge.textContent = plan.mode === 'remux' ? 'Sound converted' : 'Converted';
      this.badge.style.display = '';
      toast(plan.description, 'sync', 3500);
      if (token !== this.loadToken) return;
      const at = resume && resume > 10 && resume < (plan.duration || Infinity) - 10 ? resume : 0;
      if (at) toast(`Resumed at ${fmtTime(at)}`, 'play');
      this.startAt(at);
    } else {
      this.v.src = `/media/${item.id}`;
      this.v.addEventListener('loadedmetadata', () => {
        if (resume && resume > 10 && resume < this.v.duration - 10) {
          this.v.currentTime = resume;
          toast(`Resumed at ${fmtTime(resume)}`, 'play');
        }
      }, { once: true });
      this.time();
      this.v.play().catch(() => {});
    }
  }

  // ------------------------------------------------- where we are in the video

  /** Seconds into the whole video. A converted stream starts wherever it was last restarted, so it adds its start. */
  get pos() { return this.conv ? this.conv.base + this.v.currentTime : this.v.currentTime; }
  get len() { return this.conv ? this.conv.duration : this.v.duration; }

  /** Start (or restart) the converted stream `t` seconds in. */
  startAt(t, { play = true } = {}) {
    this.conv.base = t;
    this.el.classList.add('wait');
    this.v.src = convertUrl(this.item.id, t, this.conv.caps, this.conv.force);
    this.v.playbackRate = this.speed;
    this.time();
    if (play) this.v.play().catch(() => {});
  }

  seekTo(t) {
    const len = this.len;
    if (!len || !Number.isFinite(len)) return;
    t = clamp(t, 0, len);
    if (!this.conv) {
      this.v.currentTime = t;
      return;
    }
    // Inside what is already buffered, just move; anywhere else the stream starts again from there.
    const rel = t - this.conv.base;
    const b = this.v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (rel >= b.start(i) && rel <= b.end(i) - 0.5) {
        this.v.currentTime = rel;
        return;
      }
    }
    this.startAt(t, { play: !this.v.paused });
  }

  /**
   * Some files open without any error yet have no picture the player can decode (10-bit HEVC in an MP4, say): the
   * sound plays and the screen stays black. Treat that like a failure, once.
   */
  checkPicture() {
    if (this.conv || this.forced || this.declined || !this.item || !this.v.getAttribute('src') || this.v.videoWidth > 0) return;
    this.v.pause();
    this.failed();
  }

  /** The video element reported an error. */
  failed() {
    this.el.classList.remove('wait');
    const item = this.item;
    if (!item || !this.v.getAttribute('src')) return;
    if (this.conv) return toast(`Couldn't convert ${item.title || 'this video'}`, 'info', 5000);
    // It looked fine but wouldn't play: convert it (offering ffmpeg first if needed), unless the user turned that off
    // or has just said no to converting this very video.
    if (this.declined) return toast(`Can't play ${item.title || 'this video'} without ffmpeg. Options → Video conversion sets it up`, 'info', 6000);
    if (!this.forced && this.app.prefs.convert !== false) {
      this.forced = true;
      this.begin(item, ++this.loadToken, { force: true });
      return;
    }
    toast(`Can't play ${item.title || 'this video'}`, 'info', 4000);
  }

  // -------------------------------------------------------------- subtitles

  get subPrefs() { return this.app.prefs.subs || {}; }

  applySize() {
    this.el.style.setProperty('--sub-size', `${SIZES[this.subPrefs.size] || SIZES.M}vh`);
  }

  paintCC() {
    this.ccBtn.classList.toggle('on', !!this.track);
  }

  /** Find this video's tracks and switch on the remembered language if it has one. */
  async loadSubs(item) {
    const token = ++this.subToken;
    this.tracks = [];
    this.track = null;
    this.subs.clear();
    this.paintCC();
    this.offset = this.app.prefs.subDelay?.[item.id] || 0;
    this.subs.setOffset(this.offset);
    let tracks;
    try {
      ({ tracks } = await api.subtitleTracks(item.id));
    } catch {
      return; // no subtitles is not an error worth interrupting a film for
    }
    if (token !== this.subToken) return;
    this.tracks = tracks;
    const pick = pickTrack(tracks, this.subPrefs);
    if (pick) this.selectTrack(pick, { remember: false });
  }

  /** `t` null turns subtitles off. `remember` stores the choice (language, on/off) for the next video. */
  async selectTrack(t, { remember = true } = {}) {
    const token = ++this.subToken;
    this.track = t;
    this.paintCC();
    if (!t) {
      this.subs.clear();
      if (remember) this.app.patchPrefs({ subs: { on: false } });
      toast('Subtitles off', 'cc', 1400);
      return;
    }
    if (remember) this.app.patchPrefs({ subs: { on: true, lang: t.lang } });
    if (t.kind === 'embedded') toast('Reading subtitles from the video…', 'cc', 2500);
    try {
      const { cues } = await api.subtitleCues(this.item.id, t.key);
      if (token !== this.subToken) return;
      this.subs.setCues(cues);
      toast(cues.length ? `Subtitles: ${trackLabel(t)}` : `${trackLabel(t)} has no lines`, 'cc', 1800);
    } catch (e) {
      if (token !== this.subToken) return;
      this.track = null;
      this.subs.clear();
      this.paintCC();
      toast(`Couldn't load those subtitles: ${e.message}`, 'info', 4500);
    }
  }

  /** Off → each usable track → off. */
  cycleSubs() {
    const usable = this.tracks.filter((t) => t.supported !== false);
    if (!usable.length) return toast('No subtitles found for this video', 'cc', 2200);
    const at = this.track ? usable.findIndex((t) => t.key === this.track.key) : -1;
    this.selectTrack(at + 1 < usable.length ? usable[at + 1] : null);
  }

  adjustDelay(by, { announce = true } = {}) {
    this.offset = Math.round((this.offset + by) * 10) / 10;
    this.subs.setOffset(this.offset);
    this.app.patchPrefs({ subDelay: { [this.item.id]: this.offset || null } }); // null forgets it
    if (announce) toast(`Subtitle delay ${fmtDelay(this.offset)}`, 'cc', 1200);
  }

  openTrackPicker() {
    const here = (t) => (this.track && t && this.track.key === t.key) || (!this.track && !t) ? '✓' : '';
    const items = [{ label: 'Off', value: here(null), action: () => this.selectTrack(null) }];
    for (const t of this.tracks) items.push({ label: trackLabel(t), sm: trackDetail(t), value: here(t), disabled: t.supported === false, action: () => this.selectTrack(t) });
    const sheet = new ListSheet(this.app, {
      title: 'Subtitles',
      note: this.tracks.length ? '' : 'No subtitles found. Put a .srt, .vtt or .ass file next to the video with the same name (for example Movie.en.srt), or use a video with text subtitles inside.',
      wide: this.tracks.length > 0,
      closeBelow: true,
      items,
    });
    sheet.sel = Math.max(0, this.track ? this.tracks.findIndex((t) => t.key === this.track.key) + 1 : 0);
    sheet.paint(false);
    this.app.openLayer(sheet);
  }

  openOptions() {
    const sizes = Object.keys(SIZES);
    const build = () => [
      { label: 'Subtitles', icon: 'cc', value: this.track ? trackLabel(this.track) : 'Off', keep: true, action: () => this.openTrackPicker() },
      {
        label: 'Subtitle size', icon: 'sort', value: SIZE_NAMES[this.subPrefs.size || 'M'], keep: true,
        action: (s) => step(1, s), adjust: (dir, s) => step(dir, s),
      },
      {
        label: 'Subtitle delay', icon: 'clock', value: fmtDelay(this.offset), keep: true,
        action: (s) => { this.adjustDelay(-this.offset, { announce: false }); s.setItems(build(), { keepSel: true }); },
        adjust: (dir, s) => { this.adjustDelay(dir * 0.1, { announce: false }); s.setItems(build(), { keepSel: true }); },
      },
      {
        label: 'Playback speed', icon: 'speed', value: `${this.v.playbackRate}×`, keep: true,
        action: (s) => { this.cycleSpeed(1, { wrap: true }); s.setItems(build(), { keepSel: true }); },
        adjust: (dir, s) => { this.cycleSpeed(dir, { announce: false }); s.setItems(build(), { keepSel: true }); },
      },
      {
        label: 'Video conversion', icon: 'sync', value: this.conv ? (this.conv.mode === 'remux' ? 'Sound converted' : 'Converting') : this.app.prefs.convert === false ? 'Off' : 'Not needed', keep: true,
        action: () => openFfmpegSheet(this.app),
      },
    ];
    const step = (dir, s) => {
      const at = sizes.indexOf(this.subPrefs.size || 'M');
      this.app.patchPrefs({ subs: { size: sizes[(at + dir + sizes.length) % sizes.length] } });
      this.applySize();
      s.setItems(build(), { keepSel: true });
    };
    this.app.openLayer(new ListSheet(this.app, {
      title: 'Playback options',
      note: '← → changes a value. Enter on the delay resets it.',
      items: build(),
    }));
  }

  step(d) {
    const i = this.index + d;
    if (i < 0 || i >= this.list.length) return false;
    this.load(i);
    return true;
  }

  ended() {
    // A converted stream also "ends" if ffmpeg stops early. That is not the end of the video: start it again, once.
    if (this.conv && this.len && this.pos < this.len - 8) {
      if (this.restarts++ >= 1) return toast('The conversion keeps stopping, so playback has stopped', 'info', 5000);
      toast('The conversion stopped early. Restarting…', 'sync', 2500);
      return this.startAt(this.pos);
    }
    this.app.patchProgress(this.item.id, null);
    if (this.step(1)) toast(`Up next: ${this.item.displayTitle || this.item.title}`, 'next');
    else this.wake(true);
  }

  saveProgress() {
    // Only while a video is actually loaded: with no source the element reports 0, which must not erase a resume point.
    if (!this.item || !this.v.getAttribute('src')) return;
    const len = this.len;
    if (!len || !Number.isFinite(len)) return;
    const t = this.pos;
    this.app.patchProgress(this.item.id, t > 10 && t < len - 10 ? Math.floor(t) : null);
  }

  // -------------------------------------------------------------- controls

  toggle() {
    if (this.v.paused) this.v.play().catch(() => {});
    else this.v.pause();
    this.pop(this.v.paused ? 'play' : 'pause');
  }

  skip(sec) {
    if (!this.len) return;
    this.seekTo(this.pos + sec);
    this.pop(sec < 0 ? 'back10' : 'fwd10');
    this.wake();
  }

  toggleMute() {
    this.v.muted = !this.v.muted;
  }

  cycleSpeed(dir = 1, { announce = true, wrap = false } = {}) {
    const i = SPEEDS.indexOf(this.v.playbackRate);
    const at = (i < 0 ? 2 : i) + dir;
    const next = SPEEDS[wrap ? (at + SPEEDS.length) % SPEEDS.length : clamp(at, 0, SPEEDS.length - 1)];
    this.speed = next;
    this.v.defaultPlaybackRate = next; // so the next video (and a restarted stream) keeps the speed too
    this.v.playbackRate = next;
    this.speedBtn.textContent = `${next}×`;
    if (announce) toast(`Speed ${next}×`, 'speed', 1200);
  }

  pop(name) {
    this.flash.replaceChildren(icon(name));
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
  }

  state() {
    this.playBtn.replaceChildren(icon(this.v.paused ? 'play' : 'pause'));
  }

  time() {
    const d = Number.isFinite(this.len) ? this.len : 0;
    const p = this.pos;
    if (!this.scrubbing) this.seek.set(d ? p / d : 0);
    if (!(this.conv && this.scrubbing)) this.cur.textContent = fmtTime(p); // while dragging a converted stream the slider shows the target time
    this.dur.textContent = d ? fmtTime(d) : '';
  }

  buffered() {
    const { v } = this;
    const d = this.len;
    if (v.buffered.length && d && Number.isFinite(d)) this.seek.buffered((this.conv ? this.conv.base : 0) / d + v.buffered.end(v.buffered.length - 1) / d);
  }

  volume() {
    this.vol.set(this.v.muted ? 0 : this.v.volume);
    this.volBtn.replaceChildren(icon(this.v.muted || this.v.volume === 0 ? 'mute' : 'volume'));
    this.app.patchPrefs({ videoVolume: this.v.volume });
  }

  /** Show the controls, then hide them again after a moment of inactivity. */
  wake(stay = false) {
    this.el.classList.remove('idle');
    clearTimeout(this.idle);
    if (!stay) this.idle = setTimeout(() => { if (!this.v.paused) this.el.classList.add('idle'); }, IDLE_MS);
  }

  hints() {
    return [
      { pad: 'cross', key: 'Space', label: 'Play / pause' },
      { pad: 'D-pad', key: '← →', label: 'Seek' },
      { pad: 'D-pad', key: '↑ ↓', label: 'Volume' },
      { pad: 'square', key: 'C', label: 'Subtitles' },
      { pad: 'triangle', key: 'Tab', label: 'Options' },
      { pad: 'circle', key: 'Esc', label: 'Back' },
    ];
  }

  onAction(a, ev) {
    this.wake();
    const v = this.v;
    switch (a) {
      case 'confirm': case 'playpause': this.toggle(); return true;
      case 'left': this.skip(ev?.shiftKey ? -30 : -5); return true;
      case 'right': this.skip(ev?.shiftKey ? 30 : 5); return true;
      case 'up': v.volume = clamp(v.volume + 0.05, 0, 1); v.muted = false; return true;
      case 'down': v.volume = clamp(v.volume - 0.05, 0, 1); return true;
      case 'catNext': case 'next': this.step(1); return true;
      case 'catPrev': case 'prev': this.step(-1); return true;
      case 'options': this.openOptions(); return true;
      case 'view': this.cycleSubs(); return true;
      case 'back': this.app.nav.back(); return true;
      case 'char': {
        const k = ev.key;
        if (k === 'c' || k === 'C') this.cycleSubs();
        else if (k === 'g' || k === 'G') this.adjustDelay(-0.1);
        else if (k === 'h' || k === 'H') this.adjustDelay(0.1);
        else if (k === 'm' || k === 'M') this.toggleMute();
        else if (k === 'f' || k === 'F') this.app.toggleFullscreen();
        else if (k === 'j' || k === 'J') this.skip(-10);
        else if (k === 'l' || k === 'L') this.skip(10);
        else if (k === 'k' || k === 'K') this.toggle();
        else if (k === 'n' || k === 'N') this.step(1);
        else if (k === 'p' || k === 'P') this.step(-1);
        else if (k === '>' || k === '.') this.cycleSpeed(1);
        else if (k === '<' || k === ',') this.cycleSpeed(-1);
        else return false;
        return true;
      }
      default: return false;
    }
  }
}

import { api, convertUrl } from '../api.js';
import { askFfmpeg, installFfmpeg, openFfmpegSheet, playerCaps } from '../convert.js';
import { fmtDelay, languageName, pickTrack, SIZE_NAMES, SIZES, SubtitleView, trackDetail, trackLabel } from '../subs.js';
import { isFinished } from '../library.js';
import { fitName, isFit, nextFit, placement, stepZoom } from '../picture.js';
import { ListSheet, makeSlider, toast } from '../ui.js';
import { clamp, fmtTime, h, icon } from '../util.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const IDLE_MS = 2600;

const channelsText = (n) => ({ 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[n] || `${n} channels`);
/** "English", "Spanish · Commentary": the language, plus the track's own name when it adds something. */
function audioLabel(t) {
  const lang = languageName(t.lang);
  const extra = t.name && t.name.length < 40 && !(lang && t.name.toLowerCase() === lang.toLowerCase()) ? t.name : '';
  return [lang || (extra ? '' : `Track ${t.ordinal + 1}`), extra].filter(Boolean).join(' · ');
}
const audioDetail = (t) => `${t.codec} · ${channelsText(t.channels)}${t.isDefault ? ' · file default' : ''}`;

export class VideoScreen {
  constructor(app) {
    this.app = app;
    this.v = h('video', { playsinline: '', preload: 'auto' });
    this.title = h('h3');
    this.flash = h('div', { class: 'v-flash' });
    this.audioOnly = false; // the file has sound but no picture, so a blank screen is expected
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
    this.picBtn = this.btn('image', 'Picture shape (Z)', () => this.cycleFit());
    this.zoom = 1; // how far in the picture is zoomed (per video); the shape chosen is remembered in prefs
    this.pan = { x: 0, y: 0 };
    this.ccBtn = this.btn('cc', 'Subtitles (C)', () => this.openTrackPicker());
    this.audioBtn = this.btn('lang', 'Sound track (A)', () => this.openAudioPicker());
    this.audioBtn.style.display = 'none'; // only when the video has more than one sound track
    this.audioTracks = [];
    this.audioOrdinal = null; // the sound track picked (null: whichever the file starts with)
    this.audioReady = null; // settles once this video's track list is known
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
        h('span', { class: 'grow' }), this.audioBtn, this.ccBtn, this.picBtn, this.speedBtn, this.volBtn, this.vol.el, this.fsBtn));
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
    v.addEventListener('loadedmetadata', () => { this.checkPicture(); this.place(); });
    v.addEventListener('resize', () => this.place());
    v.addEventListener('click', () => { if (this.dragged) this.dragged = false; else this.toggle(); });
    // The wheel zooms; when zoomed in, dragging moves the picture around.
    this.el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    v.addEventListener('pointerdown', (e) => {
      if (this.zoom <= 1 || e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY, pan: { ...this.pan } };
      this.dragged = false;
      const move = (m) => {
        const dx = m.clientX - start.x;
        const dy = m.clientY - start.y;
        if (!this.dragged && Math.hypot(dx, dy) < 5) return;
        this.dragged = true;
        this.pan = { x: start.pan.x + dx, y: start.pan.y + dy };
        this.place();
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setTimeout(() => { this.dragged = false; }); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    new ResizeObserver(() => { cancelAnimationFrame(this.placeFrame); this.placeFrame = requestAnimationFrame(() => this.place()); }).observe(this.el); // next frame: placing the video inside must not feed back into this observer
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
    this.stopStream();
    this.badge.style.display = 'none';
    clearTimeout(this.idle);
    if (this.wasMusic) this.app.audio.play(); // the music that was playing before the video carries on
    this.wasMusic = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  coverEl() { return null; }

  /** Stop whatever is playing and let go of it: nothing of the old video may play or be saved under the next one. */
  stopStream() {
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.conv = null;
    this.subs.clear();
  }

  load(i) {
    // Keep the old video's real position, then stop it at once. Starting the next one takes a moment (the server looks
    // at the file first), and until then the old picture and sound must not carry on under the new title.
    this.saveProgress();
    this.stopStream();
    this.index = clamp(i, 0, this.list.length - 1);
    const item = (this.item = this.list[this.index]);
    this.title.textContent = item.displayTitle || item.title;
    this.zoom = 1; // zoom and position start fresh for every video; the shape chosen stays
    this.pan = { x: 0, y: 0 };
    this.place();
    this.conv = null;
    this.forced = false;
    this.declined = false; // said "play it without converting" for this video
    this.audioOnly = false;
    this.audioOrdinal = null;
    this.restarts = 0;
    this.badge.style.display = 'none';
    this.el.classList.add('wait');
    this.loadSubs(item);
    this.audioReady = this.loadAudio(item);
    this.begin(item, ++this.loadToken);
  }

  /**
   * Start playing `item`. Most videos play as they are. One the player can't decode (see server/transcode.js)
   * is converted on the fly by ffmpeg, which is offered for download the first time it is needed.
   * `force` converts everything: it is used when a file that looked fine failed to play.
   */
  async begin(item, token, { force = false, at = null } = {}) {
    const resume = this.app.prefs.progress?.[item.id];
    // A remembered language picks the matching sound track on its own, but only when ffmpeg is already there:
    // switching tracks needs it, and a film must not start by asking for a download.
    const lang = this.app.prefs.audio?.lang;
    if (this.audioOrdinal == null && lang && this.app.prefs.convert !== false && this.app.ffmpeg?.state === 'ready') {
      await this.audioReady;
      if (token !== this.loadToken) return;
      const want = this.audioFor(lang);
      if (want && !want.isDefault) this.audioOrdinal = want.ordinal;
      this.paintAudio();
    }
    let plan = null;
    if (this.app.prefs.convert !== false || force || this.audioOrdinal != null) {
      try {
        plan = await api.play(item.id, await playerCaps(), force, this.audioOrdinal);
      } catch {
        /* the server couldn't tell: play it as it is */
      }
      if (token !== this.loadToken) return;
      this.audioOnly = plan?.hasVideo === false;
    }
    if (plan && plan.mode !== 'direct' && plan.ffmpeg.state !== 'ready') {
      const choice = await askFfmpeg(this.app, plan);
      if (token !== this.loadToken) return;
      if (choice === 'never') this.app.patchPrefs({ convert: false });
      this.declined = choice !== 'download';
      plan = null;
      if (choice === 'download' && (await installFfmpeg(this.app))) {
        if (token !== this.loadToken) return;
        plan = await api.play(item.id, await playerCaps(), force, this.audioOrdinal).catch(() => null);
        if (token !== this.loadToken) return;
      }
    }
    if (!plan && this.audioOrdinal != null) {
      // Declined or failed: the picked track can't be played without ffmpeg, so it plays as the file starts.
      this.audioOrdinal = null;
      this.paintAudio();
      toast("Couldn't switch the sound track", 'info', 4000);
    }
    if (plan && plan.mode !== 'direct' && plan.ffmpeg.state === 'ready') {
      this.conv = { base: 0, duration: plan.duration, caps: await playerCaps(), force, mode: plan.mode, audio: this.audioOrdinal };
      this.badge.textContent = plan.switched && !plan.reasons.length ? 'Sound track changed' : plan.mode === 'remux' ? 'Sound converted' : 'Converted';
      this.badge.style.display = '';
      toast(plan.description, 'sync', 3500);
      if (token !== this.loadToken) return;
      // `at` is where a track switch carries on from; otherwise pick up the saved position of an earlier viewing.
      const from = at != null ? at : resume && resume > 10 && resume < (plan.duration || Infinity) - 10 ? resume : 0;
      if (from && at == null) toast(`Resumed at ${fmtTime(from)}`, 'play');
      this.startAt(from);
    } else {
      this.v.src = `/media/${item.id}`;
      this.v.addEventListener('loadedmetadata', () => {
        if (token !== this.loadToken) return; // skipped to another video before this one loaded: its resume point isn't ours
        if (at != null) {
          if (at > 0 && at < this.v.duration) this.v.currentTime = at;
        } else if (resume && resume > 10 && resume < this.v.duration - 10) {
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
    this.v.src = convertUrl(this.item.id, t, this.conv.caps, this.conv.force, this.conv.audio);
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
    if (this.conv || this.forced || this.declined || this.audioOnly || !this.item || !this.v.getAttribute('src') || this.v.videoWidth > 0) return;
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

  // ------------------------------------------------------------ sound tracks

  /** Find this video's sound tracks (languages and formats). A file with just one has nothing to choose. */
  async loadAudio(item) {
    this.audioTracks = [];
    this.paintAudio();
    let tracks = [];
    try {
      ({ tracks } = await api.audioTracks(item.id));
    } catch {
      /* the list is a convenience: playback goes on without it */
    }
    if (item !== this.item) return;
    this.audioTracks = tracks;
    this.paintAudio();
    if (this.active) this.app.chrome(); // the hint bar mentions the sound track key only when there is one to switch
  }

  /** The track to use for a remembered language: full dialogue before commentary tracks. */
  audioFor(lang) {
    const rank = (t) => (/commentary/i.test(t.name || '') ? 1 : 0);
    return [...this.audioTracks].filter((t) => t.lang === lang).sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  /** The track now in use: the one picked, else the file's usual one. */
  get currentAudio() {
    return this.audioTracks.find((t) => (this.audioOrdinal == null ? t.isDefault : t.ordinal === this.audioOrdinal)) || null;
  }

  paintAudio() {
    this.audioBtn.style.display = this.audioTracks.length > 1 ? '' : 'none';
    this.audioBtn.classList.toggle('on', this.audioOrdinal != null);
  }

  /** Switch to `t`, carrying on from where the video is. */
  selectAudio(t, { remember = true } = {}) {
    if (!this.item || t === this.currentAudio) return;
    const at = this.pos;
    this.audioOrdinal = t.isDefault ? null : t.ordinal;
    // A track with no language can't be matched in the next video, so it also forgets the old choice.
    if (remember) this.app.patchPrefs({ audio: { lang: t.lang || null } });
    this.paintAudio();
    toast(`Sound: ${audioLabel(t)}`, 'volume', 1800);
    // Keep the real position, then stop the old stream: until the new one starts, nothing may save a position from it.
    this.saveProgress();
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.conv = null;
    this.badge.style.display = 'none';
    this.el.classList.add('wait');
    this.begin(this.item, ++this.loadToken, { force: this.forced, at: Number.isFinite(at) ? at : 0 });
  }

  /** Each track in turn, then back to the first. */
  cycleAudio() {
    if (this.audioTracks.length < 2) return toast('This video has only one sound track', 'volume', 2200);
    const at = this.audioTracks.indexOf(this.currentAudio);
    this.selectAudio(this.audioTracks[(at + 1) % this.audioTracks.length]);
  }

  openAudioPicker() {
    if (!this.audioTracks.length) return toast('No other sound tracks found for this video', 'volume', 2200);
    const now = this.currentAudio;
    const items = this.audioTracks.map((t) => ({ label: audioLabel(t), sm: audioDetail(t), value: t === now ? '✓' : '', action: () => this.selectAudio(t) }));
    const sheet = new ListSheet(this.app, {
      title: 'Sound track',
      note: 'Choosing another track restarts the picture from where you are, and needs ffmpeg. Your language is remembered for the next video.',
      wide: true,
      closeBelow: true,
      items,
    });
    sheet.sel = Math.max(0, this.audioTracks.indexOf(now));
    sheet.paint(false);
    this.app.openLayer(sheet);
  }

  // -------------------------------------------------------------- subtitles

  get subPrefs() { return this.app.prefs.subs || {}; }

  // -------------------------------------------------------------- picture shape and zoom

  get fit() { return isFit(this.app.prefs.videoFit) ? this.app.prefs.videoFit : 'original'; }

  /** Put the video where the shape, zoom and drag say. */
  place() {
    const box = { w: this.el.clientWidth, h: this.el.clientHeight };
    if (!box.w || !box.h) return;
    const p = placement({ fit: this.fit, zoom: this.zoom, pan: this.pan, box, vw: this.v.videoWidth, vh: this.v.videoHeight });
    this.pan = { x: p.panX, y: p.panY };
    Object.assign(this.v.style, { inset: 'auto', objectFit: 'fill', width: `${p.w}px`, height: `${p.h}px`, left: `${p.x}px`, top: `${p.y}px` });
    this.picBtn.classList.toggle('on', this.fit !== 'original' || this.zoom > 1);
  }

  setFit(fit, { announce = true } = {}) {
    this.app.patchPrefs({ videoFit: fit });
    this.pan = { x: 0, y: 0 };
    this.place();
    if (announce) toast(`Picture: ${fitName(fit)}`, 'image', 1400);
  }

  cycleFit(dir = 1, opts) { this.setFit(nextFit(this.fit, dir), opts); }

  zoomBy(dir) {
    const z = stepZoom(this.zoom, dir);
    if (z === this.zoom) return;
    this.zoom = z;
    this.place();
    toast(`Zoom ${Math.round(z * 100)}%`, 'image', 900);
  }

  /** Back to the file's own shape, no zoom, centred. */
  resetPicture() {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.app.patchPrefs({ videoFit: 'original' });
    this.place();
    toast('Picture reset', 'image', 1200);
  }

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
      ...(this.audioTracks.length > 1 ? [{ label: 'Sound track', icon: 'lang', value: this.currentAudio ? audioLabel(this.currentAudio) : '', keep: true, action: () => this.openAudioPicker() }] : []),
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
        label: 'Picture shape', icon: 'image', value: fitName(this.fit), keep: true,
        action: (s) => { this.cycleFit(1, { announce: false }); s.setItems(build(), { keepSel: true }); },
        adjust: (dir, s) => { this.cycleFit(dir, { announce: false }); s.setItems(build(), { keepSel: true }); },
      },
      {
        label: 'Zoom', icon: 'image', value: `${Math.round(this.zoom * 100)}%`, sm: '+ − / wheel', keep: true,
        action: (s) => { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.place(); s.setItems(build(), { keepSel: true }); },
        adjust: (dir, s) => { this.zoom = stepZoom(this.zoom, dir); this.place(); s.setItems(build(), { keepSel: true }); },
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
    this.app.patchProgress(this.item.id, null, { finished: true });
    if (this.step(1)) toast(`Up next: ${this.item.displayTitle || this.item.title}`, 'next');
    else this.wake(true);
  }

  saveProgress() {
    // Only while a video is actually loaded: with no source the element reports 0, which must not erase a resume point.
    if (!this.item || !this.v.getAttribute('src')) return;
    const len = this.len;
    if (!len || !Number.isFinite(len)) return;
    const t = this.pos;
    // Past the point where only credits are left it counts as watched, rather than "in progress" forever.
    if (isFinished(t, len)) this.app.patchProgress(this.item.id, null, { finished: true });
    else this.app.patchProgress(this.item.id, t > 10 ? Math.floor(t) : null);
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
      ...(this.audioTracks.length > 1 ? [{ pad: 'R3', key: 'A', label: 'Sound track' }] : []),
      { pad: 'L3', key: 'Z', label: 'Shape' },
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
      case 'shape': this.cycleFit(1); return true;
      case 'picZoomIn': this.zoomBy(1); return true;
      case 'picZoomOut': this.zoomBy(-1); return true;
      case 'back': this.app.nav.back(); return true;
      case 'char': {
        const k = ev.key;
        if (k === 'c' || k === 'C') this.cycleSubs();
        else if (k === 'a' || k === 'A') this.cycleAudio();
        else if (k === 'g' || k === 'G') this.adjustDelay(-0.1);
        else if (k === 'h' || k === 'H') this.adjustDelay(0.1);
        else if (k === 'm' || k === 'M') this.toggleMute();
        else if (k === 'f' || k === 'F') this.app.toggleFullscreen();
        else if (k === 'z' || k === 'Z') this.cycleFit(ev.shiftKey ? -1 : 1);
        else if (k === '0') this.resetPicture();
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

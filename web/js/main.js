import { api, coverUrl } from './api.js';
import { AudioEngine } from './audio.js';
import { Background } from './bg.js';
import { openFfmpegSheet, refreshFfmpeg } from './convert.js';
import { dominantColor, setThumbSize } from './covers.js';
import { carriesFiles, droppedPaths, likelyKind } from './dropfolder.js';
import { Input } from './input.js';
import { baseCategory, bindWatchState, buildCollections, buildContinue, CATEGORIES, DEFAULT_SORT, describe, entryIds, isGroup, lookupTarget, MUSIC_GROUPS, SORTS } from './library.js';
import { AlbumScreen } from './screens/album.js';
import { HomeScreen } from './screens/home.js';
import { NowPlayingScreen } from './screens/nowplaying.js';
import { PhotoAlbumScreen } from './screens/photoalbum.js';
import { PhotoScreen } from './screens/photo.js';
import { ShowScreen } from './screens/show.js';
import { VideoScreen } from './screens/video.js';
import { ThemeManager } from './themes.js';
import { openThemes } from './themeui.js';
import { openSongReview } from './songsui.js';
import { AboutSheet, Hints, ListSheet, openFolderBrowser, StatusBar, TextPrompt, toast } from './ui.js';
import { FrameGovernor, isTier, lowerTier, QUALITY_CHOICES, stepUiSize, thumbSize, tierFor, UI_SIZES, uiFactor } from './quality.js';
import { debounce, Emitter, h, hashHue, icon, reducedMotion, sleep } from './util.js';

const $ = (sel) => document.querySelector(sel);
const SCAN_REFRESH_MS = 3500; // how often the shelves are rebuilt while a scan is running
// Look things up for new items on launch, and save what's found into the files, unless switched off in Options.
const DEFAULTS = { category: 'music', view: 'flow', clock24: false, volume: 0.9, videoVolume: 0.9, sort: {}, focus: {}, progress: {}, autoFetch: true, writeTags: true, quality: 'auto' };

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) deepMerge((target[k] = target[k] && typeof target[k] === 'object' ? target[k] : {}), v);
    else target[k] = v;
  }
  return target;
}

/** Like deepMerge, but keeps nulls: a patch on its way to the server must still say "delete this key". */
function mergePatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) mergePatch((target[k] = target[k] && typeof target[k] === 'object' ? target[k] : {}), v);
    else target[k] = v;
  }
  return target;
}

class Nav {
  constructor(app) {
    this.app = app;
    this.screens = {};
    this.stack = [];
    this.pending = false;
  }

  get top() { return this.stack.at(-1); }

  async push(name, params = {}) {
    if (this.pending) return;
    const to = this.screens[name];
    await this.swap(this.top?.screen, to, () => {
      to.enter(params);
      this.stack.push({ name, screen: to });
    });
  }

  async back() {
    if (this.pending || this.stack.length < 2) return;
    const from = this.top.screen;
    const to = this.stack.at(-2).screen;
    await this.swap(from, to, () => {
      this.stack.pop();
      to.resume?.();
    });
  }

  /** Switch screens; when both have a cover element, it morphs between them (View Transitions API). */
  async swap(from, to, mutate) {
    this.pending = true;
    const fromCover = from?.coverEl?.();
    const toCover = to.coverEl?.();
    const morph = fromCover && toCover;
    const update = () => {
      this.pending = false;
      if (morph) fromCover.style.viewTransitionName = '';
      from?.leave?.();
      from?.el.classList.remove('active');
      mutate();
      to.el.classList.add('active');
      if (morph) toCover.style.viewTransitionName = 'cover';
      this.app.chrome();
    };
    if (!from || !document.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') {
      update();
      return;
    }
    if (morph) fromCover.style.viewTransitionName = 'cover';
    try {
      const vt = document.startViewTransition(update);
      // A transition can be skipped (newer one started, tab hidden); the screens still switch.
      vt.ready.catch(() => {});
      vt.updateCallbackDone.catch(() => {});
      await vt.finished;
    } catch {
      /* skipped */
    } finally {
      if (morph) toCover.style.viewTransitionName = fromCover.style.viewTransitionName = '';
      this.pending = false;
    }
  }
}

class App extends Emitter {
  constructor() {
    super();
    this.prefs = structuredClone(DEFAULTS);
    this.items = [];
    this.roots = [];
    this.photoRoots = [];
    this.rev = -1;
    this.fullAt = 0; // when the whole library was last taken from the server
    this.scanning = false;
    this.cols = { music: [], nocover: [], spoken: [], video: [], continue: [], unmatched: [], photo: [], albums: [], byId: new Map() };
    bindWatchState(() => this.prefs); // `prefs` is replaced when the saved ones arrive, hence a getter
    this.albumByTrack = new Map();
    this.layers = [];
    this.device = 'kbd';
    this.pendingPrefs = {};
    this.flushPrefs = debounce(() => {
      const patch = this.pendingPrefs;
      this.pendingPrefs = {};
      api.savePrefs(patch).catch(() => {
        // The server didn't take it: keep the changes (newer ones on top) and try again shortly.
        this.pendingPrefs = mergePatch(patch, this.pendingPrefs);
        setTimeout(() => this.flushPrefs(), 5000);
      });
    }, 600);

    this.bg = new Background($('#bg'));
    this.tint = { hue: 322, sat: 0.62 }; // what the focused cover asks for; a theme with a fixed accent overrides it
    this.themes = new ThemeManager(this);
    this.audio = new AudioEngine();
    this.status = new StatusBar($('#statusbar'), this);
    this.hintBar = new Hints($('#hints'), (action) => this.dispatch(action));
    this.nav = new Nav(this);
  }

  async boot() {
    const [prefs, snap] = await Promise.all([api.prefs(), api.library()]);
    this.prefs = deepMerge(structuredClone(DEFAULTS), prefs);
    this.audio.setVolume(this.prefs.volume);
    this.audio.on('volume', () => this.patchPrefs({ volume: this.audio.el.volume }));
    this.setLibrary(snap);

    const screens = this.nav.screens;
    screens.home = new HomeScreen(this);
    screens.album = new AlbumScreen(this);
    screens.show = new ShowScreen(this);
    screens.nowplaying = new NowPlayingScreen(this);
    screens.video = new VideoScreen(this);
    screens.photo = new PhotoScreen(this);
    screens.photoalbum = new PhotoAlbumScreen(this);
    $('#screens').append(...Object.values(screens).map((s) => s.el), this.buildMini());
    this.themes.apply(); // background, colours, fonts and the cover layout
    this.applyUiSize();
    this.startQuality();
    refreshFfmpeg(this); // so Options can say whether video conversion is ready

    this.input = new Input({ dispatch: (a, e) => this.dispatch(a, e), onDevice: (d) => this.deviceChanged(d) });
    document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
    document.addEventListener('fullscreenchange', () => this.chrome());
    this.watchDrops();
    this.followLibrary();

    await this.nav.push('home');
    if (snap.scanning || snap.fetch?.active) this.poll();
    // Launch housekeeping: look up whatever is new, and save anything fetched earlier that isn't in the files yet.
    if (this.prefs.metaConsent && this.prefs.autoFetch !== false) this.fetchMissing(CATEGORIES.map((c) => c.id), { auto: true });
    if (this.prefs.writeTags !== false) this.savePending();
  }

  get writing() { return this.prefs.writeTags !== false; }

  // --------------------------------------------------------------- graphics quality

  /** The tier in use now: the chosen one, or in Auto whatever the safety governor last settled on. */
  get tier() { return tierFor(this.prefs.quality, this.prefs.autoTier); }

  startQuality() {
    this.governor = new FrameGovernor();
    this.bg.onFrame = (ms) => {
      if (this.prefs.quality !== 'auto' && isTier(this.prefs.quality)) return; // a tier chosen by hand is never overridden
      if (this.governor.push(ms) !== 'down') return;
      const now = this.tier;
      const next = lowerTier(now);
      if (next === now) return;
      this.patchPrefs({ autoTier: next }); // remembered: a machine that struggled once will again
      this.applyTier();
      toast('Lowered graphics quality to keep things smooth. Change it in Options → Graphics quality', 'info', 6000);
    };
    const reset = () => this.governor.reset();
    addEventListener('resize', reset);
    document.addEventListener('visibilitychange', reset);
    this.applyTier();
  }

  /** Put the tier into effect: backdrop sharpness, and how big new thumbnails are made. */
  applyTier() {
    this.bg.setTier(this.tier);
    setThumbSize(thumbSize(this.tier, Math.max(screen.width, screen.height), devicePixelRatio || 1));
  }

  // --------------------------------------------------------------- interface size

  get canZoom() { return typeof window.flowdeckHost?.setZoom === 'function'; }

  /** Make the whole interface the size the setting asks for (Auto: bigger on a 4K screen). Only in the desktop app. */
  applyUiSize() {
    if (this.canZoom) window.flowdeckHost.setZoom(uiFactor(this.prefs.uiSize || 'auto', screen.width));
  }

  /** dir 1 / -1: a step larger / smaller; 0: back to Auto. Returns whether it was handled (a plain browser keeps its own zoom). */
  stepUiSize(dir) {
    if (!this.canZoom) return false;
    this.setUiSize(dir === 0 ? 'auto' : stepUiSize(this.prefs.uiSize || 'auto', dir, screen.width));
    return true;
  }

  setUiSize(size) {
    this.patchPrefs({ uiSize: size });
    this.applyUiSize();
    toast(`Interface size: ${UI_SIZES.find(([k]) => k === size)?.[1] || size}`, 'info', 1800);
  }

  /** Options → Graphics quality: step through Auto, Standard, High, Ultra. */
  cycleQuality() {
    const keys = QUALITY_CHOICES.map(([k]) => k);
    const cur = keys.includes(this.prefs.quality) ? this.prefs.quality : 'auto';
    const next = keys[(keys.indexOf(cur) + 1) % keys.length];
    this.patchPrefs({ quality: next, ...(next === 'auto' ? { autoTier: 'high' } : {}) }); // Auto starts afresh from High
    this.governor.reset();
    this.applyTier();
  }

  async savePending() {
    try {
      this.reportWrite(await api.writeFiles({ pending: true }));
      this.libraryChanged();
    } catch {
      /* nothing worth interrupting for: it will be retried next launch */
    }
  }

  /** Tell the user what was saved into files, once with a pointer to undo. */
  reportWrite({ wrote = 0, failed = 0, writeError = '', errors = [] }, { always = false } = {}) {
    if (wrote) {
      const first = !this.prefs.writeNoticeShown;
      if (first) this.patchPrefs({ writeNoticeShown: true });
      toast(`Saved details into ${wrote} file${wrote === 1 ? '' : 's'}${first ? '. Options → Artwork & metadata can undo this' : ''}`, 'check', first ? 7000 : 4000);
    } else if (always && !failed) {
      toast('Those files already have everything', 'check', 2500);
    }
    if (failed) toast(`${failed} file${failed === 1 ? '' : 's'} couldn't be saved (${writeError || errors[0] || 'in use or read-only'}). It will be tried again next time`, 'info', 7000);
  }

  // ------------------------------------------------------------- library

  setLibrary(snap) {
    this.items = snap.items;
    this.roots = snap.roots;
    this.photoRoots = snap.photoRoots || [];
    this.rev = snap.rev;
    this.scanning = snap.scanning;
    this.tmdb = snap.tmdb;
    this.version = snap.version || this.version;
    this.rebuildCollections();
    this.emit('library');
  }

  /** The shelves from the library as it is now, in the chosen sort order. */
  rebuildCollections() {
    this.cols = buildCollections(this.items, this.prefs.sort, { group: this.prefs.musicGroup });
    this.cols.continue = buildContinue(this.cols);
    this.albumByTrack = new Map();
    for (const a of [...this.cols.music, ...this.cols.nocover, ...this.cols.spoken]) for (const t of a.tracks) this.albumByTrack.set(t.id, a);
  }

  /** Options → Group music by: albums (by folder and tags), albums by tags alone, or one entry per artist. */
  cycleMusicGroup(dir = 1) {
    const keys = MUSIC_GROUPS.map(([k]) => k);
    const now = isGroup(this.prefs.musicGroup) ? this.prefs.musicGroup : keys[0];
    this.patchPrefs({ musicGroup: keys[(keys.indexOf(now) + dir + keys.length) % keys.length] });
    this.rebuildCollections();
    this.emit('library');
  }

  /** Progress changed (a video was played or marked): redo the Continue shelf and let the shelves redraw. */
  refreshContinue() {
    this.cols.continue = buildContinue(this.cols);
    this.emit('library');
  }

  /** Follow the server while it scans folders or looks up artwork, refreshing the shelves as results arrive. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    let scanned = false;
    let fetched = false;
    try {
      for (;;) {
        // While a scan runs the library changes every second or so. Re-sending and rebuilding all of it that often
        // is what makes a big library stutter, so in between the page asks for the progress only.
        const quick = this.scanning && Date.now() - this.fullAt < SCAN_REFRESH_MS;
        let snap = await api.library(this.rev, { lite: quick });
        if (snap.lite && !snap.scanning) snap = await api.library(this.rev); // the scan just ended: take the final library now
        const job = snap.fetch || {};
        this.scanning = snap.scanning;
        this.tmdb = snap.tmdb;
        if (!snap.unchanged && !snap.lite) {
          this.setLibrary(snap);
          this.fullAt = Date.now();
        }
        scanned ||= snap.scanning;
        if (job.active) this.expectFetch = false;
        fetched ||= job.active;
        if (snap.scanning) {
          const { done, total } = snap.progress;
          this.status.setScan(true, done ? `${done} / ${total}` : total ? `${total} files` : 'Scanning');
        } else {
          this.status.setScan(job.active, `Artwork ${job.done} / ${job.total}`);
        }
        if (!snap.scanning && !job.active) {
          if (fetched || this.expectFetch) this.reportFetch(job);
          this.expectFetch = false;
          break;
        }
        await sleep(snap.scanning ? 900 : 1500);
      }
    } catch (e) {
      toast(`Lost connection to the library: ${e.message}`);
    } finally {
      this.polling = false;
      this.status.setScan(false);
      this.emit('library');
    }
    // A finished scan is the moment new files appear, so it's when "auto-fetch" looks for work.
    if (scanned && !fetched && this.prefs.autoFetch && this.prefs.metaConsent) this.fetchMissing(CATEGORIES.map((c) => c.id), { auto: true });
  }

  reportFetch(job) {
    if (!job.total) return;
    const parts = [`${job.found} found`, job.missed && `${job.missed} not found`, job.failed && `${job.failed} failed`].filter(Boolean);
    toast(`Artwork & metadata: ${parts.join(', ')}`, 'image', 5500);
    this.reportWrite({ wrote: job.wrote, failed: job.writeFailed, writeError: job.writeError });
    if (job.noKey) toast('Movies skipped: the TMDB key is missing or was rejected', 'info', 5500);
    if (job.offline) toast("Couldn't reach the lookup services. Are you offline?", 'info', 5500);
  }

  libraryChanged() {
    this.poll();
  }

  // --------------------------------------------------------------- prefs

  patchPrefs(patch) {
    deepMerge(this.prefs, patch);
    mergePatch(this.pendingPrefs, patch);
    this.flushPrefs();
  }

  /**
   * Remember where a video got to. `seconds` null clears the resume point; `finished` also marks it watched.
   * Starting a video and leaving at once is not "playing" it, so only a real position or a finish counts as recent.
   */
  patchProgress(id, seconds, { finished = false } = {}) {
    const now = Date.now();
    const played = seconds != null || finished;
    this.patchPrefs({ progress: { [id]: seconds }, ...(played ? { lastPlayed: { [id]: now } } : {}), ...(finished ? { watched: { [id]: now } } : {}) });
  }

  /** Mark videos (a movie, or every episode of a show) watched or not. Watching them again is never blocked by this. */
  setWatched(ids, on) {
    const now = Date.now();
    const watched = {};
    const progress = {};
    for (const id of ids) {
      watched[id] = on ? now : null;
      if (on) progress[id] = null; // a finished video has nothing to resume
    }
    this.patchPrefs({ watched, ...(on ? { progress } : {}) });
    this.refreshContinue();
  }

  // --------------------------------------------------------------- theme

  /** The colour the focused cover suggests. A theme with one fixed accent ignores it. */
  setTint(hue, sat) {
    this.tint = { hue, sat };
    const accent = this.themes.effective.accent;
    if (accent.mode === 'fixed') this.bg.setTint(accent.hue, accent.sat / 100);
    else this.bg.setTint(hue, sat);
  }

  /** Re-apply the tint after the theme's accent setting changed. */
  retint() {
    this.setTint(this.tint.hue, this.tint.sat);
  }

  trackCover(t, album = this.albumByTrack.get(t.id)) {
    if (t.cover) return coverUrl(t.id, t.cv);
    return album?.coverId ? coverUrl(album.coverId, album.coverV) : null;
  }

  trackHue(t) {
    const a = this.albumByTrack.get(t.id);
    return hashHue(`${a?.artist || t.artist}${a?.title || t.album}`);
  }

  trackTheme(t) {
    const cover = this.trackCover(t);
    const fallback = this.trackHue(t);
    if (!cover) return this.setTint(fallback, 0.55);
    dominantColor(cover).then((c) => {
      if (this.audio.track?.id === t.id) this.setTint(c ? c.hue : fallback, c ? c.sat : 0.55);
    });
  }

  // ------------------------------------------------------------- layers

  openLayer(layer) {
    this.layers.at(-1)?.el.classList.add('under');
    this.layers.push(layer);
    $('#overlays').append(layer.el);
    this.chrome();
  }

  closeLayer(layer) {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.layers.at(-1)?.el.classList.remove('under');
    layer.el.classList.add('out');
    setTimeout(() => layer.el.remove(), 200);
    layer.opts?.onClose?.();
    this.chrome();
  }

  openFolderBrowser(opts) { openFolderBrowser(this, opts); }

  /** Refresh the hint bar and mini player for whatever is on top. */
  chrome() {
    const src = this.layers.at(-1) || this.nav.top?.screen;
    if (src) this.hintBar.set(src.hints());
    const name = this.nav.top?.name;
    const showMini = !!this.audio.track && (name === 'home' || name === 'album' || name === 'show' || name === 'photoalbum') && !this.layers.length;
    this.mini.classList.toggle('show', showMini);
    $('#screens').classList.toggle('mini-on', showMini);
    document.body.classList.toggle('immersive', name === 'video' || name === 'photo');
    // The status bar's buttons: Back wherever there is a screen or sheet to go back from; tools only when no sheet is open.
    const layers = this.layers.length;
    this.status.setNav({ back: layers > 0 || this.nav.stack.length > 1, search: !layers && name === 'home', options: !layers });
  }

  deviceChanged(d) {
    this.device = d;
    this.hintBar.setDevice(d);
    this.nav.screens.home?.deviceChanged(d);
  }

  // ------------------------------------------------------------ dispatch

  dispatch(action, ev) {
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') return this.stepUiSize(action === 'zoomIn' ? 1 : action === 'zoomOut' ? -1 : 0);
    const layer = this.layers.at(-1);
    if (layer) return layer.onAction(action, ev) !== false;
    if (action === 'fullscreen') return this.toggleFullscreen(), true;
    if (this.nav.top.screen.onAction(action, ev)) return true;
    const { audio } = this;
    switch (action) {
      case 'options': this.openMenu(); return true;
      case 'search': if (this.nav.top.name === 'home') { this.nav.screens.home.search(); return true; } return false;
      case 'playpause': if (audio.track) { audio.toggle(); return true; } return false;
      case 'next': if (audio.track) { audio.next(); return true; } return false;
      case 'prev': if (audio.track) { audio.prev(); return true; } return false;
      default: return false;
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  toggleView() {
    this.patchPrefs({ view: this.prefs.view === 'flow' ? 'grid' : 'flow' });
    this.nav.screens.home.applyView();
    this.chrome();
  }

  // --------------------------------------------------------------- menus

  openMenu() {
    const p = this.prefs;
    const cat = p.category;
    const sortKey = () => p.sort[cat] || DEFAULT_SORT[cat];
    const sortLabel = () => SORTS[cat].find(([k]) => k === sortKey())[1];
    const build = () => [
      ...(this.nav.top?.name === 'home' ? [{ label: 'Search library…', icon: 'search', sm: '/', action: () => this.nav.screens.home.search() }] : []),
      { label: 'Add music / video folder…', icon: 'folderPlus', action: () => this.openFolderBrowser() },
      { label: 'Library folders', icon: 'folder', value: String(this.roots.length), keep: true, action: () => this.openRoots() },
      { label: 'Add photo folder…', icon: 'image', action: () => this.openFolderBrowser({ photos: true }) },
      { label: 'Photo folders', icon: 'folder', value: String(this.photoRoots.length), keep: true, action: () => this.openRoots({ photos: true }) },
      { label: 'Rescan library', icon: 'sync', action: () => { api.scan().then(() => this.poll()); toast('Scanning your folders…', 'sync'); } },
      ...this.watchRow(),
      { label: 'Artwork & metadata', icon: 'image', keep: true, action: () => this.openArtwork() },
      { label: 'Theme & style', icon: 'palette', value: `${this.themes.base.name}${this.themes.dirty ? ' (edited)' : ''}`, keep: true, action: () => openThemes(this) },
      { label: 'Video conversion', icon: 'sync', value: p.convert === false ? 'Off' : this.ffmpeg?.state === 'ready' ? 'Ready' : this.ffmpeg?.state === 'busy' ? 'Downloading' : 'Needs ffmpeg', keep: true, action: () => openFfmpegSheet(this) },
      { sep: true },
      { label: 'View', icon: p.view === 'flow' ? 'flow' : 'grid', value: p.view === 'flow' ? 'Cover flow' : 'Grid', keep: true, action: (s) => { this.toggleView(); s.setItems(build(), { keepSel: true }); } },
      {
        label: `Sort ${baseCategory(cat) === 'video' ? 'videos' : baseCategory(cat) === 'music' ? (cat === 'spoken' ? 'audiobooks and podcasts' : 'music') : CATEGORIES.find((c) => c.id === cat).label.toLowerCase()} by`, icon: 'sort', value: sortLabel(), keep: true,
        action: (s) => {
          const keys = SORTS[cat].map(([k]) => k);
          this.patchPrefs({ sort: { [cat]: keys[(keys.indexOf(sortKey()) + 1) % keys.length] } });
          this.rebuildCollections();
          this.emit('library');
          s.setItems(build(), { keepSel: true });
        },
      },
      { label: 'Graphics quality', icon: 'palette', value: `${QUALITY_CHOICES.find(([k]) => k === p.quality)?.[1] || 'Auto'}${p.quality === 'auto' || !p.quality ? ` (${this.tier})` : ''}`, keep: true, action: (s) => { this.cycleQuality(); s.setItems(build(), { keepSel: true }); } },
      ...(this.canZoom ? [{ label: 'Interface size', icon: 'grid', sm: 'Ctrl + / −', value: UI_SIZES.find(([k]) => k === (p.uiSize || 'auto'))?.[1] || 'Auto', keep: true, action: (s) => { this.stepUiSize(p.uiSize === 'xlarge' ? -9 : 1); s.setItems(build(), { keepSel: true }); } }] : []),
      ...(baseCategory(cat) === 'music' ? [{
        label: 'Group music by', icon: 'music', value: (MUSIC_GROUPS.find(([k]) => k === p.musicGroup) || MUSIC_GROUPS[0])[1], keep: true,
        action: (s) => { this.cycleMusicGroup(1); s.setItems(build(), { keepSel: true }); },
        adjust: (dir, s) => { this.cycleMusicGroup(dir); s.setItems(build(), { keepSel: true }); },
      }] : []),
      { label: 'Clock', icon: 'clock', value: p.clock24 ? '24-hour' : '12-hour', keep: true, action: (s) => { this.patchPrefs({ clock24: !p.clock24 }); this.status.tick(); s.setItems(build(), { keepSel: true }); } },
      { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', icon: document.fullscreenElement ? 'exitFs' : 'fullscreen', action: () => this.toggleFullscreen() },
      // Only in the desktop app, where the page can ask for the folder to be shown.
      ...(window.flowdeckHost?.openLogs ? [{ label: 'Open log folder', icon: 'folder', sm: 'for bug reports', action: () => window.flowdeckHost.openLogs() }] : []),
      { label: 'About and credits', icon: 'info', keep: true, action: () => this.openLayer(new AboutSheet(this, { version: this.version })) },
    ];
    const sheet = new ListSheet(this, { title: 'Options', items: build(), onClose: () => off() });
    const off = this.on('themes', () => sheet.setItems(build(), { keepSel: true })); // the Theme row shows the current name
    this.openLayer(sheet);
  }

  /**
   * The server rescans by itself when files change in a library folder. This is how the page finds out: a very cheap
   * question every few seconds (just the library's revision number), and a refresh only when the answer has changed.
   */
  followLibrary() {
    setInterval(async () => {
      if (this.polling || document.hidden) return;
      try {
        const s = await api.library(this.rev, { lite: true });
        if (!s.unchanged) this.poll();
      } catch {
        /* the server is busy or restarting: the next tick asks again */
      }
    }, 5000);
  }

  // ------------------------------------------------- dropping folders in

  /** Folders dragged onto the window are offered to the library. The page cannot see where a dropped file lives; the desktop app tells it. */
  watchDrops() {
    let depth = 0; // dragenter/dragleave fire for every element crossed, so count them
    const hint = (on) => document.body.classList.toggle('dropping', on);
    addEventListener('dragenter', (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (++depth === 1) hint(true);
    });
    addEventListener('dragover', (e) => { if (carriesFiles(e.dataTransfer)) e.preventDefault(); }); // without this the browser refuses the drop
    addEventListener('dragleave', (e) => {
      if (carriesFiles(e.dataTransfer) && --depth <= 0) { depth = 0; hint(false); }
    });
    addEventListener('drop', (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault(); // the window must never navigate to a dropped file
      depth = 0;
      hint(false);
      this.dropped(e.dataTransfer);
    });
  }

  async dropped(dataTransfer) {
    const host = window.flowdeckHost;
    if (!host?.pathForFile) return toast('Dropping folders works in the Flowdeck app. Use Options → Add folder here.', 'info', 5000);
    const found = [];
    for (const p of droppedPaths(dataTransfer, host.pathForFile)) {
      try {
        const d = await api.browse(p); // a file, or a place that can't be opened, comes back as an error
        if (!d.error && d.path) found.push({ path: d.path, name: d.name, counts: d.counts || {} });
      } catch {
        /* not something that can be added */
      }
    }
    if (!found.length) return toast('Drop a folder, not a file. Its music, videos or photos are found inside it.', 'info', 5000);
    this.askDroppedKind(found);
  }

  /** One question for everything dropped: music and video, or photos? The folder's own contents suggest the answer. */
  askDroppedKind(folders) {
    const names = folders.length === 1 ? `“${folders[0].name}”` : `${folders.length} folders`;
    const sum = (k) => folders.reduce((n, f) => n + (f.counts[k] || 0), 0);
    const says = (parts) => parts.filter(Boolean).join(' · ') || 'looks inside subfolders too';
    const add = (photos) => async () => {
      let added = 0;
      for (const f of folders) {
        try {
          await api.addRoot(f.path, photos);
          added++;
        } catch (e) {
          toast(`${f.name}: ${e.message}`, 'info', 4000);
        }
      }
      if (added) {
        toast(`Added ${added === 1 ? folders[0].name : `${added} folders`}`, 'folder');
        this.libraryChanged();
      }
    };
    const media = { label: 'Add as music and video', icon: 'folderPlus', sm: says([sum('audio') && `${sum('audio')} songs`, sum('video') && `${sum('video')} videos`]), action: add(false) };
    const photos = { label: 'Add as photos', icon: 'image', sm: says([sum('image') && `${sum('image')} photos`]), action: add(true) };
    const first = likelyKind({ audio: sum('audio'), video: sum('video'), image: sum('image') });
    this.openLayer(new ListSheet(this, {
      title: `Add ${names}?`,
      note: 'Photos only appear on the Photos shelf from folders added as photos. Your files are never changed.',
      items: first === 'photos' ? [{ ...photos, primary: true }, media, { label: 'Cancel', icon: 'close' }] : [{ ...media, primary: true }, photos, { label: 'Cancel', icon: 'close' }],
    }));
  }

  /** "Mark as watched / not watched" for the movie or show in focus. Nothing for music and photos. */
  watchRow() {
    const ctx = this.currentEntry();
    if (!ctx || baseCategory(ctx.category) !== 'video') return [];
    const watched = describe('video', ctx.entry).watched;
    return [{
      label: watched ? 'Mark as not watched' : 'Mark as watched', icon: 'check',
      action: () => {
        this.setWatched(entryIds(ctx.category, ctx.entry), !watched);
        toast(watched ? 'Marked as not watched' : 'Marked as watched', 'check', 1800);
      },
    }];
  }

  openRoots({ photos = false } = {}) {
    const list = () => (photos ? this.photoRoots : this.roots);
    const build = () => [
      { label: photos ? 'Add a photo folder…' : 'Add a folder…', icon: 'folderPlus', primary: true, action: () => this.openFolderBrowser({ photos }) },
      ...(list().length ? [{ sep: true }] : []),
      ...list().map((r) => ({
        label: r, icon: 'folder', sm: 'Remove', keep: true,
        action: async (s) => {
          await api.removeRoot(r, photos);
          this.libraryChanged();
          toast('Removed from library. Your files are untouched.', 'trash');
          s.setItems(build().filter((i) => i.label !== r), { keepSel: true });
        },
      })),
    ];
    this.openLayer(new ListSheet(this, { title: photos ? 'Photo folders' : 'Library folders', wide: true, closeBelow: true, items: build(), hints: [{ pad: 'cross', key: 'Enter', label: 'Add / remove' }, { pad: 'circle', key: 'Esc', label: 'Close' }] }));
  }

  // ------------------------------------------------- artwork & metadata

  /** The album, show or movie the user is looking at (home shelf focus, or an open album/show). */
  currentEntry() {
    const name = this.nav.top?.name;
    const { screens } = this.nav;
    if (name === 'album') return { category: 'music', entry: screens.album.album };
    if (name === 'show') return { category: 'video', entry: screens.show.show };
    if (name === 'home' && screens.home.flow.item) return { category: this.prefs.category, entry: screens.home.flow.item };
    return null;
  }

  /** Lookups for everything on the given shelves that hasn't been checked yet. */
  missingTargets(categories) {
    const out = [];
    for (const c of categories) {
      for (const e of this.cols[c]) {
        if (e.fetched) continue; // already looked up, whether or not anything was found
        if (baseCategory(c) === 'music' && e.coverId) continue; // has art already
        const t = lookupTarget(c, e);
        if (t) out.push(t);
      }
    }
    return out;
  }

  /** Looking things up means sending titles to third parties, so ask once, in plain words. */
  ensureConsent() {
    if (this.prefs.metaConsent) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.openLayer(new ListSheet(this, {
        title: 'Look things up online?',
        note: "Flowdeck sends album and artist names to MusicBrainz, the Cover Art Archive and Apple's iTunes Search, show names to TVMaze, and movie titles to iTunes Search and TMDB (if you add a key), to fetch artwork and details. Your files and their locations are never sent.",
        items: [
          { label: 'Continue', icon: 'check', primary: true, action: () => { this.patchPrefs({ metaConsent: true }); resolve(true); } },
          { label: 'Not now', icon: 'close', action: () => resolve(false) },
        ],
        onClose: () => resolve(false), // closing with Esc counts as "not now" (a no-op if already answered)
      }));
    });
  }

  async fetchMissing(categories, { auto = false } = {}) {
    if (auto ? !this.prefs.metaConsent : !(await this.ensureConsent())) return;
    const targets = this.missingTargets(categories);
    if (!targets.length) {
      if (!auto) toast('Nothing new to look up: everything here has been checked.', 'info');
      return;
    }
    try {
      await api.fetchMeta(targets, false, this.writing);
    } catch (e) {
      return toast(e.message);
    }
    if (!auto) toast(`Looking up ${targets.length} item${targets.length === 1 ? '' : 's'}…`, 'sync');
    this.expectFetch = true;
    this.poll();
  }

  /** Let the user pick the right match from what the services return, then apply it. */
  async matchCurrent() {
    const ctx = this.currentEntry();
    const target = ctx && lookupTarget(ctx.category, ctx.entry);
    if (!target) return toast("Open an album, show or movie first. This item can't be looked up.", 'info');
    if (!(await this.ensureConsent())) return;

    const name = ctx.entry.title;
    const sheet = new ListSheet(this, { title: 'Choose the right match', note: `Searching for “${name}”…`, wide: true, items: [{ label: 'Searching…', disabled: true }] });
    this.openLayer(sheet);
    const query = target.type === 'album' ? { type: 'album', artist: target.artist, album: target.album, trackCount: target.ids.length }
      : target.type === 'show' ? { type: 'show', name: target.show, year: target.year }
      : { type: 'movie', title: target.title, year: target.year };
    let candidates;
    try {
      ({ candidates } = await api.candidates(query));
    } catch (e) {
      sheet.close();
      if (e.code === 'NO_KEY' || e.code === 'BAD_KEY') return this.promptTmdbKey({ after: () => this.matchCurrent() });
      return toast(e.code === 'OFFLINE' ? "Couldn't reach the lookup services. Are you offline?" : e.message, 'info', 5000);
    }
    const ids = target.ids || [target.id];
    const items = candidates.map((c) => ({
      label: c.title, sm: c.subtitle, thumb: c.thumb,
      action: async () => {
        toast('Applying…', 'sync', 1500);
        try {
          const r = await api.applyMatch({ type: target.type, ref: c.ref, ids, episodes: target.episodes, write: target.type === 'album' && this.writing });
          toast(r.found === false ? 'Matched, but no artwork was available for it' : 'Artwork and details updated', 'check');
          this.reportWrite({ wrote: r.written, failed: r.writeFailed, writeError: r.writeError });
          this.libraryChanged();
        } catch (e) {
          toast(e.message, 'info', 5000);
          return 'keep';
        }
      },
    }));
    items.push({ sep: true }, { label: 'None of these', icon: 'close' });
    sheet.setItems(items, { note: candidates.length ? 'Pick the best match. Its artwork and details replace what is shown now.' : 'Nothing found. Check the spelling of the file and folder names.' });
  }

  promptTmdbKey({ after } = {}) {
    this.openLayer(new TextPrompt(this, {
      title: 'TMDB API key',
      note: 'Movies are looked up on iTunes without a key. A TMDB key adds ratings and more matches. Make a free account at themoviedb.org, open Settings → API, and paste the API Key (or the long Read Access Token) here. Leave it empty and save to remove the key. This product uses the TMDB API but is not endorsed or certified by TMDB.',
      placeholder: 'Paste your key',
      onSubmit: async (key) => {
        const r = await api.setTmdbKey(key);
        this.tmdb = r.tmdb;
        toast(key ? 'TMDB key saved' : 'TMDB key removed', 'check');
        if (after) setTimeout(after, 250);
      },
    }));
  }

  async clearCurrent() {
    const ctx = this.currentEntry();
    if (!ctx) return;
    await api.clearFetched(entryIds(ctx.category, ctx.entry));
    toast('Removed the fetched artwork and details', 'trash');
    this.libraryChanged();
  }

  openArtwork() {
    const p = this.prefs;
    const build = (sheet) => {
      const ctx = this.currentEntry();
      const canMatch = !!ctx && !!lookupTarget(ctx.category, ctx.entry);
      const album = baseCategory(ctx?.category) === 'music' ? ctx.entry : null;
      const shelf = this.missingTargets([p.category]).length;
      const all = this.missingTargets(CATEGORIES.map((c) => c.id)).length;
      const short = (s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
      return [
        { label: canMatch ? `Match “${short(ctx.entry.title)}”…` : 'Match the selected item…', icon: 'sync', sm: canMatch ? 'choose from results' : 'select an album, show or movie', disabled: !canMatch, action: () => this.matchCurrent() },
        { label: 'Fetch missing: this shelf', icon: 'image', sm: `${shelf} to look up`, disabled: !shelf, action: () => this.fetchMissing([p.category]) },
        { label: 'Fetch missing: all shelves', icon: 'image', sm: `${all} to look up`, disabled: !all, action: () => this.fetchMissing(CATEGORIES.map((c) => c.id)) },
        {
          label: album ? `Identify the songs in “${short(album.title)}”…` : 'Identify songs and fix their tags…', icon: 'music',
          sm: album ? `${album.ids.length} song${album.ids.length === 1 ? '' : 's'}` : 'select an album or artist', disabled: !album,
          action: async () => { if (await this.ensureConsent()) openSongReview(this, { ids: album.ids, title: album.title }); }, // looking songs up sends their titles and artists out, so it asks once first
        },
        { sep: true },
        {
          label: 'Fetch automatically for new items', icon: 'sync', value: p.autoFetch ? 'On' : 'Off', keep: true,
          action: async (s) => {
            if (!p.autoFetch && !(await this.ensureConsent())) return;
            this.patchPrefs({ autoFetch: !p.autoFetch });
            s.setItems(build(s), { keepSel: true });
          },
        },
        {
          label: 'Save details into my music files', icon: 'check', value: this.writing ? 'On' : 'Off', keep: true,
          action: (s) => {
            this.patchPrefs({ writeTags: !this.writing });
            if (this.writing) this.savePending(); // switching it on also saves what was fetched while it was off
            s.setItems(build(s), { keepSel: true });
          },
        },
        { label: 'TMDB key (optional, adds movie ratings)', icon: 'gear', value: this.tmdb ? 'Set' : 'Not set', keep: true, action: (s) => this.promptTmdbKey({ after: () => s.setItems(build(s), { keepSel: true }) }) },
        { sep: true },
        { label: 'Remove fetched data for the selected item', icon: 'trash', disabled: !ctx || ctx.entry.fetched !== 2, action: () => this.clearCurrent() },
        {
          label: 'Save the selected album into its files now', icon: 'folder', sm: album ? '' : 'select an album', disabled: !album || album.fetched !== 2,
          action: async () => {
            try {
              this.reportWrite(await api.writeFiles({ ids: album.ids }), { always: true });
              this.libraryChanged();
            } catch (e) {
              toast(e.message);
            }
          },
        },
        {
          label: 'Undo file changes for the selected album', icon: 'trash', sm: album ? '' : 'select an album', disabled: !album || !album.saved,
          action: async () => {
            try {
              const r = await api.undoFiles(album.ids);
              toast(r.restored ? `Put ${r.restored} file${r.restored === 1 ? '' : 's'} back exactly as ${r.restored === 1 ? 'it was' : 'they were'}` : 'Nothing was restored: the files have changed since', r.restored ? 'trash' : 'info', 5000);
              this.libraryChanged();
            } catch (e) {
              toast(e.message);
            }
          },
        },
      ];
    };
    const sheet = new ListSheet(this, {
      title: 'Artwork & metadata',
      note: 'Music: MusicBrainz and iTunes. Shows: TVMaze. Movies: iTunes, plus TMDB if you add a free key. Only names are sent, never your files. What is found for music is saved into the MP3 and FLAC files themselves, and can be undone.',
      wide: true,
      closeBelow: true,
      items: [],
    });
    sheet.setItems(build(sheet));
    this.openLayer(sheet);
  }

  // --------------------------------------------------------- mini player

  buildMini() {
    const { audio } = this;
    const cover = h('div');
    const title = h('b');
    const sub = h('span');
    const prog = h('div', { class: 'prog' });
    const play = h('button', { class: 'round', tabindex: '-1', onclick: () => audio.toggle() }, icon('play'));
    const btn = (name, fn) => h('button', { class: 'round', tabindex: '-1', onclick: fn }, icon(name));
    this.mini = h('div', { class: 'mini', onclick: (e) => { if (!e.target.closest('.round')) this.nav.push('nowplaying'); } },
      cover, h('div', { class: 'meta' }, title, sub), btn('prev', () => audio.prev()), play, btn('next', () => audio.next()), prog);
    audio.on('track', (t) => {
      title.textContent = t.title;
      sub.textContent = [t.artist, t.album].filter(Boolean).join(' — ');
      const url = this.trackCover(t);
      cover.replaceChildren(h('div', { class: 'cover' }, url ? h('img', { src: url, class: 'loaded', alt: '' }) : h('div', { class: 'ph', style: { '--ph': this.trackHue(t) } }, icon('music')), h('div', { class: 'shine' })));
      this.chrome();
    });
    audio.on('state', () => play.replaceChildren(icon(audio.playing ? 'pause' : 'play')));
    audio.on('time', () => { prog.style.width = `${audio.duration ? (audio.time / audio.duration) * 100 : 0}%`; });
    audio.on('error', (t) => toast(`Can't play ${t?.title || 'this track'}`, 'info', 4000));
    return this.mini;
  }
}

const app = new App();
window.flowdeck = app; // handy for debugging in the console
app.boot().catch((e) => {
  document.body.append(h('pre', { style: { position: 'fixed', inset: '20px', color: '#fff', zIndex: 99, whiteSpace: 'pre-wrap' } }, `Flowdeck could not start:\n${e.stack || e}`));
});

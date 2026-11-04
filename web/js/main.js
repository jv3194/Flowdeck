import { api, coverUrl } from './api.js';
import { AudioEngine } from './audio.js';
import { Background } from './bg.js';
import { openFfmpegSheet, refreshFfmpeg } from './convert.js';
import { dominantColor } from './covers.js';
import { Input } from './input.js';
import { buildCollections, CATEGORIES, DEFAULT_SORT, entryIds, lookupTarget, SORTS } from './library.js';
import { AlbumScreen } from './screens/album.js';
import { HomeScreen } from './screens/home.js';
import { NowPlayingScreen } from './screens/nowplaying.js';
import { PhotoScreen } from './screens/photo.js';
import { ShowScreen } from './screens/show.js';
import { VideoScreen } from './screens/video.js';
import { ThemeManager } from './themes.js';
import { openThemes } from './themeui.js';
import { AboutSheet, Hints, ListSheet, openFolderBrowser, StatusBar, TextPrompt, toast } from './ui.js';
import { debounce, Emitter, h, hashHue, icon, reducedMotion, sleep } from './util.js';

const $ = (sel) => document.querySelector(sel);
// Look things up for new items on launch, and save what's found into the files, unless switched off in Options.
const DEFAULTS = { category: 'music', view: 'flow', clock24: false, volume: 0.9, videoVolume: 0.9, sort: {}, focus: {}, progress: {}, autoFetch: true, writeTags: true };

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
    this.rev = -1;
    this.scanning = false;
    this.cols = { music: [], video: [], photo: [], byId: new Map() };
    this.albumByTrack = new Map();
    this.layers = [];
    this.device = 'kbd';
    this.pendingPrefs = {};
    this.flushPrefs = debounce(() => {
      const patch = this.pendingPrefs;
      this.pendingPrefs = {};
      api.savePrefs(patch).catch(() => {});
    }, 600);

    this.bg = new Background($('#bg'));
    this.tint = { hue: 322, sat: 0.62 }; // what the focused cover asks for; a theme with a fixed accent overrides it
    this.themes = new ThemeManager(this);
    this.audio = new AudioEngine();
    this.status = new StatusBar($('#statusbar'), this);
    this.hintBar = new Hints($('#hints'));
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
    $('#screens').append(...Object.values(screens).map((s) => s.el), this.buildMini());
    this.themes.apply(); // background, colours, fonts and the cover layout
    refreshFfmpeg(this); // so Options can say whether video conversion is ready

    this.input = new Input({ dispatch: (a, e) => this.dispatch(a, e), onDevice: (d) => this.deviceChanged(d) });
    document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
    document.addEventListener('fullscreenchange', () => this.chrome());

    await this.nav.push('home');
    if (snap.scanning || snap.fetch?.active) this.poll();
    // Launch housekeeping: look up whatever is new, and save anything fetched earlier that isn't in the files yet.
    if (this.prefs.metaConsent && this.prefs.autoFetch !== false) this.fetchMissing(CATEGORIES.map((c) => c.id), { auto: true });
    if (this.prefs.writeTags !== false) this.savePending();
  }

  get writing() { return this.prefs.writeTags !== false; }

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
    this.rev = snap.rev;
    this.scanning = snap.scanning;
    this.tmdb = snap.tmdb;
    this.version = snap.version || this.version;
    this.cols = buildCollections(snap.items, this.prefs.sort);
    this.albumByTrack = new Map();
    for (const a of this.cols.music) for (const t of a.tracks) this.albumByTrack.set(t.id, a);
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
        const snap = await api.library(this.rev);
        const job = snap.fetch || {};
        this.scanning = snap.scanning;
        this.tmdb = snap.tmdb;
        if (!snap.unchanged) this.setLibrary(snap);
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

  patchProgress(id, seconds) {
    this.patchPrefs({ progress: { [id]: seconds } });
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

  openFolderBrowser() { openFolderBrowser(this); }

  /** Refresh the hint bar and mini player for whatever is on top. */
  chrome() {
    const src = this.layers.at(-1) || this.nav.top?.screen;
    if (src) this.hintBar.set(src.hints());
    const name = this.nav.top?.name;
    const showMini = !!this.audio.track && (name === 'home' || name === 'album' || name === 'show') && !this.layers.length;
    this.mini.classList.toggle('show', showMini);
    $('#screens').classList.toggle('mini-on', showMini);
    document.body.classList.toggle('immersive', name === 'video' || name === 'photo');
  }

  deviceChanged(d) {
    this.device = d;
    this.hintBar.setDevice(d);
    this.nav.screens.home?.deviceChanged(d);
  }

  // ------------------------------------------------------------ dispatch

  dispatch(action, ev) {
    const layer = this.layers.at(-1);
    if (layer) return layer.onAction(action, ev) !== false;
    if (action === 'fullscreen') return this.toggleFullscreen(), true;
    if (this.nav.top.screen.onAction(action, ev)) return true;
    const { audio } = this;
    switch (action) {
      case 'options': this.openMenu(); return true;
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
      { label: 'Add media folder…', icon: 'folderPlus', action: () => this.openFolderBrowser() },
      { label: 'Library folders', icon: 'folder', value: String(this.roots.length), keep: true, action: () => this.openRoots() },
      { label: 'Rescan library', icon: 'sync', action: () => { api.scan().then(() => this.poll()); toast('Scanning your folders…', 'sync'); } },
      { label: 'Artwork & metadata', icon: 'image', keep: true, action: () => this.openArtwork() },
      { label: 'Theme & style', icon: 'palette', value: `${this.themes.base.name}${this.themes.dirty ? ' (edited)' : ''}`, keep: true, action: () => openThemes(this) },
      { label: 'Video conversion', icon: 'sync', value: p.convert === false ? 'Off' : this.ffmpeg?.state === 'ready' ? 'Ready' : this.ffmpeg?.state === 'busy' ? 'Downloading' : 'Needs ffmpeg', keep: true, action: () => openFfmpegSheet(this) },
      { sep: true },
      { label: 'View', icon: p.view === 'flow' ? 'flow' : 'grid', value: p.view === 'flow' ? 'Cover flow' : 'Grid', keep: true, action: (s) => { this.toggleView(); s.setItems(build(), { keepSel: true }); } },
      {
        label: `Sort ${CATEGORIES.find((c) => c.id === cat).label.toLowerCase()} by`, icon: 'sort', value: sortLabel(), keep: true,
        action: (s) => {
          const keys = SORTS[cat].map(([k]) => k);
          this.patchPrefs({ sort: { [cat]: keys[(keys.indexOf(sortKey()) + 1) % keys.length] } });
          this.cols = buildCollections(this.items, p.sort);
          this.albumByTrack = new Map(this.cols.music.flatMap((a) => a.tracks.map((t) => [t.id, a])));
          this.emit('library');
          s.setItems(build(), { keepSel: true });
        },
      },
      { label: 'Clock', icon: 'clock', value: p.clock24 ? '24-hour' : '12-hour', keep: true, action: (s) => { this.patchPrefs({ clock24: !p.clock24 }); this.status.tick(); s.setItems(build(), { keepSel: true }); } },
      { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', icon: document.fullscreenElement ? 'exitFs' : 'fullscreen', action: () => this.toggleFullscreen() },
      { label: 'About and credits', icon: 'info', keep: true, action: () => this.openLayer(new AboutSheet(this, { version: this.version })) },
    ];
    const sheet = new ListSheet(this, { title: 'Options', items: build(), onClose: () => off() });
    const off = this.on('themes', () => sheet.setItems(build(), { keepSel: true })); // the Theme row shows the current name
    this.openLayer(sheet);
  }

  openRoots() {
    const build = () => [
      { label: 'Add a folder…', icon: 'folderPlus', primary: true, action: () => this.openFolderBrowser() },
      ...(this.roots.length ? [{ sep: true }] : []),
      ...this.roots.map((r) => ({
        label: r, icon: 'folder', sm: 'Remove', keep: true,
        action: async (s) => {
          await api.removeRoot(r);
          this.libraryChanged();
          toast('Removed from library. Your files are untouched.', 'trash');
          s.setItems(build().filter((i) => i.label !== r), { keepSel: true });
        },
      })),
    ];
    this.openLayer(new ListSheet(this, { title: 'Library folders', wide: true, closeBelow: true, items: build(), hints: [{ pad: 'cross', key: 'Enter', label: 'Add / remove' }, { pad: 'circle', key: 'Esc', label: 'Close' }] }));
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
        if (c === 'music' && e.coverId) continue; // has art already
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
        note: "Flowdeck sends album and artist names to MusicBrainz, the Cover Art Archive and Apple's iTunes Search, show names to TVMaze, and movie titles to TMDB, to fetch artwork and details. Your files and their locations are never sent.",
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
    let targets = this.missingTargets(categories);
    const movies = targets.filter((t) => t.type === 'movie').length;
    if (movies && !this.tmdb) {
      targets = targets.filter((t) => t.type !== 'movie');
      if (!auto) toast(`${movies} movie${movies === 1 ? '' : 's'} skipped: add a free TMDB key under Artwork & metadata`, 'info', 6000);
    }
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
    if (target.type === 'movie' && !this.tmdb) return this.promptTmdbKey({ after: () => this.matchCurrent() });

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
      note: 'Movie posters and details come from TMDB. Make a free account at themoviedb.org, open Settings → API, and paste the API Key (or the long Read Access Token) here. Leave it empty and save to remove the key. This product uses the TMDB API but is not endorsed or certified by TMDB.',
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
      const album = ctx?.category === 'music' ? ctx.entry : null;
      const shelf = this.missingTargets([p.category]).length;
      const all = this.missingTargets(CATEGORIES.map((c) => c.id)).length;
      const short = (s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
      return [
        { label: canMatch ? `Match “${short(ctx.entry.title)}”…` : 'Match the selected item…', icon: 'sync', sm: canMatch ? 'choose from results' : 'select an album, show or movie', disabled: !canMatch, action: () => this.matchCurrent() },
        { label: 'Fetch missing: this shelf', icon: 'image', sm: `${shelf} to look up`, disabled: !shelf, action: () => this.fetchMissing([p.category]) },
        { label: 'Fetch missing: all shelves', icon: 'image', sm: `${all} to look up`, disabled: !all, action: () => this.fetchMissing(CATEGORIES.map((c) => c.id)) },
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
        { label: 'TMDB key (needed for movies)', icon: 'gear', value: this.tmdb ? 'Set' : 'Not set', keep: true, action: (s) => this.promptTmdbKey({ after: () => s.setItems(build(s), { keepSel: true }) }) },
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
      note: 'Music: MusicBrainz and iTunes. Shows: TVMaze. Movies: TMDB, which needs a free key. Only names are sent, never your files. What is found for music is saved into the MP3 and FLAC files themselves, and can be undone.',
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

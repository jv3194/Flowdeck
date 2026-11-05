import { baseCategory, CATEGORIES, DEFAULT_SORT, describe, jumpLabel, watchInfo } from '../library.js';
import { coverEl, dominantColor, ensureThumb, clearThumbQueue, whenQuiet } from '../covers.js';
import { Flow } from '../flow.js';
import { openSearch } from '../search.js';
import { glyph, h, icon, keycap } from '../util.js';

const EASE = 'cubic-bezier(.22,.8,.24,1)';
const DERIVED = new Set(['continue', 'unmatched', 'nocover', 'spoken']);

export class HomeScreen {
  constructor(app) {
    this.app = app;
    this.themeToken = 0;
    this.sig = '';

    this.catEls = new Map(CATEGORIES.map((c) => [c.id, h('button', { class: 'cat', tabindex: '-1', onclick: () => this.setCategory(c.id) }, icon(c.icon), h('span', {}, c.label), h('span', { class: 'count' }, '0'))]));
    // The page-up / page-down keys that switch shelf, as buttons too.
    this.shoulderL = h('span', { class: 'shoulder l', title: 'Previous shelf', onclick: () => this.stepCategory(-1) });
    this.shoulderR = h('span', { class: 'shoulder r', title: 'Next shelf', onclick: () => this.stepCategory(1) });
    this.cats = h('nav', { class: 'cats' }, this.shoulderL, ...this.catEls.values(), this.shoulderR);

    this.emptyIcon = h('span');
    this.emptyTitle = h('h2');
    this.emptyText = h('p');
    this.emptyBtn = h('button', { class: 'btn primary', tabindex: '-1', onclick: () => app.openFolderBrowser({ photos: this.photoShelf }) }, icon('folderPlus'), 'Add a folder');
    this.empty = h('div', { class: 'empty' }, h('div', { class: 'empty-card' }, this.emptyIcon, this.emptyTitle, this.emptyText, this.emptyBtn));

    // Arrows beside the cover flow, for stepping through the shelf with the mouse (the cards and wheel work too).
    this.arrowL = h('button', { class: 'flow-arrow l', tabindex: '-1', title: 'Previous', 'aria-label': 'Previous', onclick: () => this.flow.step(-1) }, icon('chevL'));
    this.arrowR = h('button', { class: 'flow-arrow r', tabindex: '-1', title: 'Next', 'aria-label': 'Next', onclick: () => this.flow.step(1) }, icon('chevR'));
    this.flowRoot = h('div', { class: 'flow-root' }, h('div', { class: 'flow-stage' }), h('div', { class: 'flow-grid' }), this.arrowL, this.arrowR, this.empty);
    this.title = h('h1', { class: 'title' });
    this.subtitle = h('p', { class: 'subtitle' });
    this.blurb = h('p', { class: 'blurb' });
    this.chips = h('div', { class: 'chips' });
    this.counter = h('div', { class: 'counter' });
    this.info = h('div', { class: 'info' }, this.title, this.subtitle, this.blurb, this.chips, this.counter);

    this.el = h('section', { class: 'screen home' }, this.cats, this.flowRoot, this.info);

    this.flow = new Flow(this.flowRoot, {
      renderCover: (e, lazy) => {
        const d = describe(this.category, e);
        // A show with no art borrows a frame from its first episode.
        // A photo album makes a thumbnail of its cover photo.
        const target = e.kind === 'folder' ? (d.cover ? null : e.coverPhoto) : e.kind === 'show' ? (d.cover ? null : e.episodes[0]) : baseCategory(this.category) === 'music' ? null : e;
        if (target) ensureThumb(target, (item, meta) => this.thumbReady(item, meta));
        return coverEl(this.category, d, lazy);
      },
      caption: (e) => describe(this.category, e).title,
      onFocus: (i, e) => this.focused(i, e),
      onActivate: (i, e) => this.open(e),
    });
    app.on('library', () => this.refresh());
    new ResizeObserver(() => { cancelAnimationFrame(this.fitFrame); this.fitFrame = requestAnimationFrame(() => this.fitTabs()); }).observe(this.cats); // the row is refitted whenever the window changes size
    whenQuiet(() => this.flow.moving);
    app.bg.busy = () => this.flow.moving && app.nav.top?.name === 'home';
  }

  get category() { return this.app.prefs.category; }
  /** Photos and Albums are the same pictures, and both come from the photo folders. */
  get photoShelf() { return this.category === 'photo' || this.category === 'albums'; }
  get cat() { return CATEGORIES.find((c) => c.id === this.category); }
  get entries() { return this.app.cols[this.category]; }

  enter() {
    this.applyView();
    this.setCategory(this.category, { initial: true });
    this.deviceChanged(this.app.device);
  }

  leave() {}

  resume() {
    this.app.refreshContinue(); // what was just watched: progress bars, ticks and the Continue shelf
    if (this.flow.item) this.focused(this.flow.index, this.flow.item);
  }

  coverEl() { return this.flow.focusedNode; }

  deviceChanged(device) {
    this.shoulderL.replaceChildren(device === 'pad' ? glyph('L1') : keycap('PgUp'));
    this.shoulderR.replaceChildren(device === 'pad' ? glyph('R1') : keycap('PgDn'));
  }

  hints() {
    return [
      { pad: 'cross', key: 'Enter', label: 'Open' },
      { pad: 'D-pad', key: '← →', label: 'Browse' },
      { pad: 'L1 R1', key: 'PgUp / PgDn', label: 'Category' },
      { pad: 'square', key: 'V', label: this.app.prefs.view === 'flow' ? 'Grid' : 'Flow' },
      { pad: 'R3', key: '/', label: 'Search' },
      { pad: 'triangle', key: 'Tab', label: 'Options' },
    ];
  }

  // ---------------------------------------------------------------- state

  applyView() {
    const grid = this.app.prefs.view === 'grid';
    this.el.classList.toggle('grid-mode', grid);
    this.flow.setMode(grid ? 'grid' : 'flow');
  }

  setCategory(id, { initial = false } = {}) {
    const prev = CATEGORIES.findIndex((c) => c.id === this.category);
    const next = CATEGORIES.findIndex((c) => c.id === id);
    if (!initial && prev === next) return;
    this.app.patchPrefs({ category: id });
    clearThumbQueue();
    this.sig = '';
    this.flow.setShape(this.cat.ratio);
    this.refresh({ dir: initial ? 1 : Math.sign(next - prev), force: true, animate: !initial });
    this.app.setTint(this.cat.hue, 0.62);
    this.app.chrome();
  }

  stepCategory(d) {
    const ids = CATEGORIES.map((c) => c.id).filter((id) => this.tabShown(id));
    const i = ids.indexOf(this.category);
    this.setCategory(ids[(i + d + ids.length) % ids.length]);
  }

  /** Shelves made from other shelves ("Continue", "No artwork") only appear while they have something in them (or are the one being looked at). */
  tabShown(id) {
    // Albums are only worth a tab when there is more than one folder to choose between.
    const least = id === 'albums' ? 2 : 1;
    return (!DERIVED.has(id) && id !== 'albums') || id === this.category || this.app.cols[id].length >= least;
  }

  /**
   * Make the row of shelf tabs fit the window. As many as eight can show, so it tightens in steps, measuring after each
   * one: first the PgUp / PgDn boxes go, then the spacing and icons, then the counts. The chosen tab is kept in view.
   */
  fitTabs() {
    const row = this.cats;
    const levels = ['crowded', 'tight', 'tiny'];
    row.classList.remove(...levels);
    for (const level of levels) {
      if (row.scrollWidth <= row.clientWidth + 1) break;
      row.classList.add(level);
    }
    const on = this.catEls.get(this.category);
    if (on && on.offsetParent && row.scrollWidth > row.clientWidth) row.scrollTo({ left: on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2 });
  }

  /** Re-read the shelf from the library, keeping focus on the same entry when possible. */
  refresh({ dir = 0, force = false, animate = false } = {}) {
    for (const c of CATEGORIES) {
      this.catEls.get(c.id).classList.toggle('active', c.id === this.category);
      this.catEls.get(c.id).querySelector('.count').textContent = this.app.cols[c.id].length;
      this.catEls.get(c.id).style.display = this.tabShown(c.id) ? '' : 'none';
    }
    this.fitTabs();
    const entries = this.entries;
    // Anything that changes how a card looks: artwork, title, fetched details.
    const video = baseCategory(this.category) === 'video';
    const watch = (e) => { if (!video) return ''; const w = watchInfo(e); return `${w.frac.toFixed(3)}${w.watched ? 'w' : ''}${w.resume}`; };
    const sig = entries.map((e) => `${e.id}|${e.title}|${e.coverId || e.cover || ''}|${e.coverV || e.cv || ''}|${e.fetched || ''}|${e.tracks?.length || e.episodes?.length || ''}|${e.episodes?.reduce((s, x) => s + (x.cv || 0), 0) || ''}|${e.photos?.length || ''}${e.coverPhoto?.cover || ''}${e.coverPhoto?.cv || ''}|${watch(e)}`).join(';');
    this.updateEmpty();
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const want = this.app.prefs.focus?.[this.category];
    const keepId = !force && this.flow.item ? this.flow.item.id : want;
    const focus = Math.max(0, entries.findIndex((e) => e.id === keepId));
    this.flow.setItems(entries, { focus, dir, keepPos: !force });
    if (animate) this.flowRoot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: EASE });
    if (!entries.length) this.showInfo(null);
  }

  updateEmpty() {
    const none = !this.entries.length;
    this.empty.classList.toggle('show', none);
    this.flowRoot.classList.toggle('bare', none); // no arrows over an empty shelf
    if (!none) return;
    const photos = this.photoShelf;
    const unmatched = DERIVED.has(this.category); // a shelf made from the others: it can't be filled by adding folders
    const noRoots = !(photos ? this.app.photoRoots : this.app.roots).length;
    const scanning = this.app.scanning;
    this.emptyIcon.replaceChildren(icon(noRoots ? 'folderPlus' : this.cat.icon));
    this.emptyTitle.textContent = noRoots ? (photos ? 'Choose your photo folders' : 'Add your media') : scanning ? 'Scanning your library…' : this.cat.empty;
    this.emptyText.textContent = noRoots
      ? photos
        ? 'Photos only come from the folders you pick for them. Choose a folder and Flowdeck shows the pictures in it and its subfolders.'
        : 'Pick a folder with music or videos. Flowdeck scans it, reads the tags and builds your shelves.'
      : scanning
        ? 'New items appear here as they are found.'
        : photos
          ? 'No pictures were found in your photo folders. Try adding another folder.'
          : this.category === 'continue'
            ? 'Movies and shows you have started appear here, so you can carry on where you stopped.'
            : this.category === 'spoken'
              ? 'Audiobooks and podcasts (m4b files, a genre like Audiobook or Podcast, or a folder with that name) are kept here, apart from your music.'
            : this.category === 'nocover'
              ? 'Albums with no cover art, in their files or online, are kept here.'
              : unmatched
              ? 'Videos that no artwork was found for online, and home clips, are kept here.'
            : 'Nothing of this type was found in your folders. Try adding another folder.';
    this.emptyBtn.style.display = (scanning && !noRoots) || (unmatched && !noRoots) ? 'none' : '';
  }

  thumbReady(item, meta) {
    item.cover = 1;
    item.cv = (item.cv || 0) + 1; // a sharper thumbnail replaces an older one: the browser must fetch it again
    Object.assign(item, Object.fromEntries(Object.entries(meta).filter(([, v]) => v > 0)));
    const i = this.entries.findIndex((e) => e.id === item.id || e.episodes?.some((x) => x.id === item.id) || e.coverPhoto?.id === item.id);
    if (i >= 0) this.flow.refresh(i);
    if (i === this.flow.index) this.showInfo(this.entries[i]);
  }

  // ------------------------------------------------------------ focus info

  focused(i, e) {
    this.app.patchPrefs({ focus: { [this.category]: e.id } });
    this.showInfo(e);
    this.counter.textContent = `${i + 1} / ${this.entries.length}`;
    this.arrowL.classList.toggle('off', i <= 0); // nothing further that way
    this.arrowR.classList.toggle('off', i >= this.entries.length - 1);
    const d = describe(this.category, e);
    const token = ++this.themeToken;
    const apply = (c) => token === this.themeToken && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55);
    // Photos only get sampled once a small thumbnail exists, to avoid decoding full-size files while scrolling.
    const src = this.category === 'photo' ? (e.cover ? d.cover : null) : d.cover;
    // Sampling a cover's colour decodes it and reads its pixels. Stepping quickly through a shelf passes dozens of
    // covers, so only the one the shelf settles on is sampled; the others would be thrown away.
    clearTimeout(this.tintTimer);
    this.tintTimer = setTimeout(() => {
      if (token !== this.themeToken) return;
      if (src) dominantColor(src).then(apply);
      else apply(null);
    }, 90);
  }

  showInfo(e) {
    if (!e) {
      this.title.textContent = this.subtitle.textContent = this.blurb.textContent = this.counter.textContent = '';
      this.chips.textContent = '';
      return;
    }
    const d = describe(this.category, e);
    if (this.title.textContent !== d.title) {
      this.title.textContent = d.title;
      this.title.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    }
    this.subtitle.textContent = d.subtitle;
    this.blurb.textContent = d.blurb || '';
    this.chips.replaceChildren(...d.chips.map((c) => h('span', { class: 'chip' }, String(c))));
  }

  // --------------------------------------------------------------- actions

  open(shown) {
    if (!shown) return;
    // The shelf can still hold an older copy of an entry when the library was rebuilt underneath it, so find the
    // current one by its id. (Looking it up by object left "not found", which the player turned into the first movie.)
    const e = this.entries.find((x) => x.id === shown.id) || shown;
    if (baseCategory(this.category) === 'music') return this.app.nav.push('album', { album: e });
    if (this.category === 'albums') return this.app.nav.push('photoalbum', { album: e });
    if (baseCategory(this.category) === 'video') {
      if (e.kind === 'show') return this.app.nav.push('show', { show: e });
      // Next/previous in the player step through the movies; shows are opened from their own screen.
      const list = this.entries.filter((x) => x.kind !== 'show');
      const index = list.findIndex((x) => x.id === e.id);
      return index < 0 ? undefined : this.app.nav.push('video', { list, index });
    }
    const list = this.entries;
    const index = list.findIndex((x) => x.id === e.id);
    return index < 0 ? undefined : this.app.nav.push('photo', { list, index });
  }

  search() { openSearch(this.app, this); }

  /** Go to an entry found by search: its shelf, focused on it, then open it (an album can open with one song marked). */
  reveal(category, entry, { select } = {}) {
    if (this.category !== category) this.setCategory(category);
    const i = this.entries.findIndex((x) => x.id === entry.id);
    if (i >= 0) this.flow.moveTo(i, { instant: true });
    if (baseCategory(category) === 'music') return this.app.nav.push('album', { album: entry, select });
    return this.open(entry);
  }

  jump(ch) {
    const list = this.entries;
    if (!list.length) return;
    const sort = this.app.prefs.sort?.[this.category] || DEFAULT_SORT[this.category];
    const start = this.flow.index;
    const c = ch.toLowerCase();
    const starts = (e) => jumpLabel(this.category, sort, e).trim().toLowerCase().startsWith(c);
    for (let n = 1; n <= list.length; n++) {
      const i = (start + n) % list.length;
      if (starts(list[i])) return this.flow.moveTo(i);
    }
  }

  onAction(a, ev) {
    switch (a) {
      case 'left': this.flow.step(-1); return true;
      case 'right': this.flow.step(1); return true;
      case 'up': this.flow.gridMove(0, -1); return true;
      case 'down': this.flow.gridMove(0, 1); return true;
      case 'first': this.flow.moveTo(0); return true;
      case 'last': this.flow.moveTo(this.entries.length - 1); return true;
      case 'confirm':
        if (!this.entries.length) { if (!DERIVED.has(this.category)) this.app.openFolderBrowser({ photos: this.photoShelf }); }
        else this.open(this.flow.item);
        return true;
      case 'catPrev': this.stepCategory(-1); return true;
      case 'catNext': this.stepCategory(1); return true;
      case 'view': this.app.toggleView(); return true;
      case 'char':
        if (ev.key === '/') return this.search(), true;
        if (ev.key.toLowerCase() === 'v') return this.app.toggleView(), true;
        this.jump(ev.key);
        return true;
      default: return false;
    }
  }
}

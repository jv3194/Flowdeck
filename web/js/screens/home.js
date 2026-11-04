import { CATEGORIES, DEFAULT_SORT, describe, jumpLabel } from '../library.js';
import { coverEl, dominantColor, ensureThumb, clearThumbQueue } from '../covers.js';
import { Flow } from '../flow.js';
import { glyph, h, icon, keycap } from '../util.js';

const EASE = 'cubic-bezier(.22,.8,.24,1)';

export class HomeScreen {
  constructor(app) {
    this.app = app;
    this.themeToken = 0;
    this.sig = '';

    this.catEls = new Map(CATEGORIES.map((c) => [c.id, h('button', { class: 'cat', tabindex: '-1', onclick: () => this.setCategory(c.id) }, icon(c.icon), h('span', {}, c.label), h('span', { class: 'count' }, '0'))]));
    this.shoulderL = h('span', { class: 'shoulder l' });
    this.shoulderR = h('span', { class: 'shoulder r' });
    this.cats = h('nav', { class: 'cats' }, this.shoulderL, ...this.catEls.values(), this.shoulderR);

    this.emptyIcon = h('span');
    this.emptyTitle = h('h2');
    this.emptyText = h('p');
    this.emptyBtn = h('button', { class: 'btn primary', tabindex: '-1', onclick: () => app.openFolderBrowser() }, icon('folderPlus'), 'Add a folder');
    this.empty = h('div', { class: 'empty' }, h('div', { class: 'empty-card' }, this.emptyIcon, this.emptyTitle, this.emptyText, this.emptyBtn));

    this.flowRoot = h('div', { class: 'flow-root' }, h('div', { class: 'flow-stage' }), h('div', { class: 'flow-grid' }), this.empty);
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
        const target = e.kind === 'show' ? (d.cover ? null : e.episodes[0]) : this.category === 'music' ? null : e;
        if (target) ensureThumb(target, (item, meta) => this.thumbReady(item, meta));
        return coverEl(this.category, d, lazy);
      },
      caption: (e) => describe(this.category, e).title,
      onFocus: (i, e) => this.focused(i, e),
      onActivate: (i, e) => this.open(e),
    });
    app.on('library', () => this.refresh());
  }

  get category() { return this.app.prefs.category; }
  get cat() { return CATEGORIES.find((c) => c.id === this.category); }
  get entries() { return this.app.cols[this.category]; }

  enter() {
    this.applyView();
    this.setCategory(this.category, { initial: true });
    this.deviceChanged(this.app.device);
  }

  leave() {}

  resume() {
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
    const i = CATEGORIES.findIndex((c) => c.id === this.category);
    this.setCategory(CATEGORIES[(i + d + CATEGORIES.length) % CATEGORIES.length].id);
  }

  /** Re-read the shelf from the library, keeping focus on the same entry when possible. */
  refresh({ dir = 0, force = false, animate = false } = {}) {
    for (const c of CATEGORIES) {
      this.catEls.get(c.id).classList.toggle('active', c.id === this.category);
      this.catEls.get(c.id).querySelector('.count').textContent = this.app.cols[c.id].length;
    }
    const entries = this.entries;
    // Anything that changes how a card looks: artwork, title, fetched details.
    const sig = entries.map((e) => `${e.id}|${e.title}|${e.coverId || e.cover || ''}|${e.coverV || e.cv || ''}|${e.fetched || ''}|${e.tracks?.length || e.episodes?.length || ''}|${e.episodes?.reduce((s, x) => s + (x.cv || 0), 0) || ''}`).join(';');
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
    if (!none) return;
    const noRoots = !this.app.roots.length;
    const scanning = this.app.scanning;
    this.emptyIcon.replaceChildren(icon(noRoots ? 'folderPlus' : this.cat.icon));
    this.emptyTitle.textContent = noRoots ? 'Add your media' : scanning ? 'Scanning your library…' : this.cat.empty;
    this.emptyText.textContent = noRoots
      ? 'Pick a folder with music, videos or photos. Flowdeck scans it, reads the tags and builds your shelves.'
      : scanning
        ? 'New items appear here as they are found.'
        : 'Nothing of this type was found in your folders. Try adding another folder.';
    this.emptyBtn.style.display = scanning && !noRoots ? 'none' : '';
  }

  thumbReady(item, meta) {
    item.cover = 1;
    Object.assign(item, Object.fromEntries(Object.entries(meta).filter(([, v]) => v > 0)));
    const i = this.entries.findIndex((e) => e.id === item.id || e.episodes?.some((x) => x.id === item.id));
    if (i >= 0) this.flow.refresh(i);
    if (i === this.flow.index) this.showInfo(this.entries[i]);
  }

  // ------------------------------------------------------------ focus info

  focused(i, e) {
    this.app.patchPrefs({ focus: { [this.category]: e.id } });
    this.showInfo(e);
    this.counter.textContent = `${i + 1} / ${this.entries.length}`;
    const d = describe(this.category, e);
    const token = ++this.themeToken;
    const apply = (c) => token === this.themeToken && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55);
    // Photos only get sampled once a small thumbnail exists, to avoid decoding full-size files while scrolling.
    const src = this.category === 'photo' ? (e.cover ? d.cover : null) : d.cover;
    if (src) dominantColor(src).then(apply);
    else apply(null);
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

  open(e) {
    if (!e) return;
    if (this.category === 'music') return this.app.nav.push('album', { album: e });
    if (this.category === 'video') {
      if (e.kind === 'show') return this.app.nav.push('show', { show: e });
      // Next/previous in the player step through the movies; shows are opened from their own screen.
      const list = this.entries.filter((x) => x.kind !== 'show');
      return this.app.nav.push('video', { list, index: list.indexOf(e) });
    }
    const list = this.entries;
    return this.app.nav.push('photo', { list, index: list.indexOf(e) });
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
        if (!this.entries.length) this.app.openFolderBrowser();
        else this.open(this.flow.item);
        return true;
      case 'catPrev': this.stepCategory(-1); return true;
      case 'catNext': this.stepCategory(1); return true;
      case 'view': this.app.toggleView(); return true;
      case 'char':
        if (ev.key.toLowerCase() === 'v') return this.app.toggleView(), true;
        this.jump(ev.key);
        return true;
      default: return false;
    }
  }
}

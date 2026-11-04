// Chrome shared by every screen: status bar, hint bar, toasts, sliders and list sheets.
import { api } from './api.js';
import { clamp, glyph, h, icon, keycap } from './util.js';

// ------------------------------------------------------------- status bar

export class StatusBar {
  constructor(el, app) {
    this.app = app;
    this.scanText = h('span');
    this.scan = h('div', { class: 'stat scan', style: { display: 'none' } }, icon('sync'), this.scanText);
    this.wifi = h('div', { class: 'stat' }, icon('wifi'));
    this.battery = h('div', { class: 'stat', style: { display: 'none' } }, h('span', { class: 'battery' }, h('i')), h('span'));
    this.clock = h('div', { class: 'clock' });
    el.append(
      h('div', { class: 'brand' }, h('span', { class: 'logo', html: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' }), 'Flowdeck'),
      h('div', { class: 'status-right' }, this.scan, this.wifi, this.battery, this.clock),
    );
    this.tick();
    setInterval(() => this.tick(), 1000);
    const online = () => this.wifi.style.opacity = navigator.onLine ? '0.9' : '0.35';
    addEventListener('online', online);
    addEventListener('offline', online);
    online();
    navigator.getBattery?.().then((b) => {
      const update = () => {
        this.battery.style.display = '';
        this.battery.firstChild.style.setProperty('--lvl', b.level);
        this.battery.lastChild.textContent = `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}`;
      };
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    }).catch(() => {});
  }

  tick() {
    const d = new Date();
    const text = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !this.app.prefs.clock24 });
    if (text !== this.clock.textContent) this.clock.textContent = text;
  }

  setScan(on, text = '') {
    this.scan.style.display = on ? '' : 'none';
    this.scanText.textContent = text;
  }
}

// --------------------------------------------------------------- hints bar

export class Hints {
  constructor(el) {
    this.el = el;
    this.list = [];
    this.device = 'kbd';
  }

  set(list) {
    this.list = list;
    this.render();
  }

  setDevice(d) {
    this.device = d;
    this.render();
  }

  render() {
    this.el.textContent = '';
    for (const hint of this.list) {
      const key = this.device === 'pad' ? glyph(hint.pad) : keycap(hint.key);
      this.el.append(h('div', { class: 'hint' }, key, h('span', {}, hint.label)));
    }
  }
}

// ------------------------------------------------------------------ toasts

export function toast(message, ic = 'info', ms = 2800) {
  const el = h('div', { class: 'toast' }, icon(ic), h('span', {}, message));
  const box = document.getElementById('toasts');
  while (box.children.length > 2) box.firstChild.remove();
  box.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ----------------------------------------------------------------- slider

/** Horizontal scrub bar. `onInput(fraction, phase)` with phase 'start' | 'move' | 'end'. */
export function makeSlider(onInput) {
  const buf = h('div', { class: 'buf' });
  const fill = h('div', { class: 'fill' });
  const knob = h('div', { class: 'knob' });
  const el = h('div', { class: 'bar' }, buf, fill, knob);
  let dragging = false;
  const paint = (f) => {
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
  };
  const frac = (e) => {
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    const f = frac(e);
    paint(f);
    onInput(f, 'start');
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const f = frac(e);
    paint(f);
    onInput(f, 'move');
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('drag');
    onInput(frac(e), 'end');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return {
    el,
    set(f) { if (!dragging) paint(clamp(f || 0, 0, 1)); },
    buffered(f) { buf.style.width = `${clamp(f || 0, 0, 1) * 100}%`; },
  };
}

// -------------------------------------------------------------- list sheet

/**
 * A glass panel with a keyboard/gamepad-navigable list. Items:
 * { label, value?, sm?, icon?, action?, adjust?, keep?, disabled?, sep?, primary? }
 * `action` runs on confirm; the sheet closes afterwards unless `keep` is set.
 * `adjust(dir, sheet)` runs on left (-1) / right (+1) while the row is selected, for values you nudge.
 * `meter` (0..1) draws a small gauge in the row; clicking it calls `setFrac(fraction, sheet)`.
 * `swatch` (a CSS background made by the app) is a colour chip in place of the icon; `dot` is a CSS colour for a dot beside the value.
 * `onSelect(item, index, sheet)` fires whenever the highlighted row changes, for live previews.
 */
export class ListSheet {
  constructor(app, { title, note = '', path = '', wide = false, items = [], hints, onKey, onClose, onSelect, closeBelow = false } = {}) {
    this.app = app;
    this.opts = { onKey, onClose, onSelect, hints, closeBelow };
    this.sel = 0;
    this.titleEl = h('h3', {}, title);
    this.noteEl = h('p', { class: 'note-text' }, note);
    this.noteEl.style.display = note ? '' : 'none';
    this.pathEl = h('div', { class: 'path' }, path);
    this.list = h('ul', { class: 'list' });
    this.sheet = h('div', { class: `panel sheet${wide ? ' wide' : ''}` }, this.titleEl, this.noteEl, this.pathEl, this.list);
    this.el = h('div', { class: 'overlay' }, this.sheet);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    this.setItems(items);
  }

  setItems(items, { title, note, path, keepSel = false } = {}) {
    if (title != null) this.titleEl.textContent = title;
    if (note != null) {
      this.noteEl.textContent = note;
      this.noteEl.style.display = note ? '' : 'none';
    }
    if (path != null) {
      this.pathEl.textContent = path;
      this.pathEl.style.display = path ? '' : 'none';
    }
    this.items = items;
    const top = keepSel ? this.list.scrollTop : 0; // rebuilding must not make a long list jump
    if (!keepSel) this.sel = Math.max(0, items.findIndex((i) => !i.sep && !i.disabled));
    this.sel = clamp(this.sel, 0, Math.max(0, items.length - 1));
    this.list.textContent = '';
    items.forEach((it, i) => {
      if (it.sep) return this.list.append(h('li', { class: 'row sep' }));
      const thumb = /^https:\/\//.test(it.thumb || '') ? h('img', { class: 'thumb', src: it.thumb, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null;
      const chip = it.swatch ? h('span', { class: 'chip-swatch', style: { background: it.swatch } }) : null;
      const meter = it.meter != null
        ? h('span', { class: 'meter', onclick: (e) => {
          if (!it.setFrac) return;
          e.stopPropagation(); // a click on the gauge sets the value; it is not "confirm"
          const r = e.currentTarget.getBoundingClientRect();
          this.sel = i;
          it.setFrac(clamp((e.clientX - r.left) / r.width, 0, 1), this);
        } }, h('i', { style: { width: `${clamp(it.meter, 0, 1) * 100}%` } }))
        : null;
      const row = h('li', { class: `row${it.primary ? ' action' : ''}${it.disabled ? ' disabled' : ''}${it.thumb ? ' has-thumb' : ''}${it.on ? ' on' : ''}`, 'data-i': i },
        thumb || chip || (it.icon ? icon(it.icon) : null),
        h('span', { class: 'lbl' }, it.label),
        it.sm ? h('span', { class: 'sm' }, it.sm) : null,
        meter,
        it.value != null || it.dot ? h('span', { class: 'val' }, it.dot ? h('span', { class: 'dot', style: { background: it.dot } }) : null, it.value) : null);
      row.addEventListener('click', () => { this.sel = i; this.confirm(); });
      row.addEventListener('pointermove', () => { if (this.sel !== i) { this.sel = i; this.paint(false); this.selected(); } });
      this.list.append(row);
    });
    if (!items.length) this.list.append(h('li', { class: 'note' }, 'Nothing here'));
    this.list.scrollTop = top;
    this.paint(!keepSel);
  }

  selected() {
    this.opts.onSelect?.(this.items[this.sel], this.sel, this);
  }

  paint(scroll = true) {
    this.list.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
    const row = this.list.querySelector(`[data-i="${this.sel}"]`);
    if (!row) return;
    row.classList.add('sel');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  move(d) {
    let i = this.sel;
    for (let n = 0; n < this.items.length; n++) {
      i = (i + d + this.items.length) % this.items.length;
      const it = this.items[i];
      if (!it.sep && !it.disabled) break;
    }
    this.sel = i;
    this.paint();
    this.selected();
  }

  async confirm() {
    const it = this.items[this.sel];
    if (!it || it.disabled || it.sep) return;
    const result = await it.action?.(this);
    if (it.keep || result === 'keep') return;
    // A sub-menu whose action is finished takes the menus it was opened from with it.
    if (this.opts.closeBelow) for (const below of this.app.layers.slice(0, this.app.layers.indexOf(this))) this.app.closeLayer(below);
    this.close();
  }

  close() { this.app.closeLayer(this); }

  onAction(a, ev) {
    if (this.opts.onKey?.(a, ev, this)) return true;
    if (a === 'up') this.move(-1);
    else if (a === 'down') this.move(1);
    else if ((a === 'left' || a === 'right') && this.items[this.sel]?.adjust) this.items[this.sel].adjust(a === 'left' ? -1 : 1, this);
    else if (a === 'confirm' || a === 'playpause') this.confirm();
    else if (a === 'back' || a === 'options') this.close();
    return true;
  }

  hints() {
    return this.opts.hints || [{ pad: 'cross', key: 'Enter', label: 'Select' }, { pad: 'circle', key: 'Esc', label: 'Close' }];
  }
}

/** A one-field dialog. `onSubmit(value)` may throw to show an error in the dialog, or return false to stay open. */
export class TextPrompt {
  constructor(app, { title, note = '', placeholder = '', value = '', submitLabel = 'Save', onSubmit }) {
    this.app = app;
    this.onSubmit = onSubmit;
    this.input = h('input', { class: 'field', type: 'text', placeholder, value, spellcheck: 'false', autocomplete: 'off' });
    this.msg = h('p', { class: 'field-msg' });
    this.sheet = h('div', { class: 'panel sheet' },
      h('h3', {}, title),
      note ? h('p', { class: 'note-text' }, note) : null,
      this.input, this.msg,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', tabindex: '-1', onclick: () => this.submit() }, submitLabel),
        h('button', { class: 'btn', tabindex: '-1', onclick: () => this.close() }, 'Cancel')));
    this.el = h('div', { class: 'overlay' }, this.sheet);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must never reach the global shortcuts
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    setTimeout(() => this.input.focus(), 60);
  }

  async submit() {
    this.msg.textContent = '';
    try {
      if ((await this.onSubmit(this.input.value.trim(), this)) !== false) this.close();
    } catch (e) {
      this.msg.textContent = e.message;
    }
  }

  close() { this.app.closeLayer(this); }

  onAction(a) {
    if (a === 'back') this.close();
    return true;
  }

  hints() {
    return [{ pad: 'cross', key: 'Enter', label: 'Save' }, { pad: 'circle', key: 'Esc', label: 'Cancel' }];
  }
}

/**
 * About / credits. The TMDB notice and logo live here, as TMDB's API terms ask for.
 * The logo is a file the user supplies (web/assets/tmdb-logo.svg); without it only the notice shows.
 */
export class AboutSheet {
  constructor(app, { version = '' } = {}) {
    this.app = app;
    const credit = (name, text) => h('li', {}, h('b', {}, name), h('span', {}, text));
    const logo = h('img', { class: 'tmdb-logo', src: 'assets/tmdb-logo.svg', alt: 'TMDB', onerror: (e) => e.target.remove() });
    this.sheet = h('div', { class: 'panel sheet about' },
      h('div', { class: 'about-head' },
        h('span', { class: 'brand-mark', html: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' }),
        h('div', {}, h('h3', {}, 'Flowdeck'), h('p', { class: 'ver' }, version ? `Version ${version}` : ''))),
      h('p', { class: 'note-text' }, 'A cover-flow player for your music, videos and photos.'),
      h('h4', {}, 'Artwork and details come from'),
      h('ul', { class: 'credits' },
        credit('MusicBrainz and the Cover Art Archive', 'album details and covers · musicbrainz.org'),
        credit('Apple iTunes Search', 'album details and covers · apple.com'),
        credit('TVMaze', 'TV show details and posters · tvmaze.com'),
        credit('TMDB', 'movie details and posters · themoviedb.org')),
      h('div', { class: 'tmdb-credit' }, logo, h('p', {}, 'This product uses the TMDB API but is not endorsed or certified by TMDB.')),
      h('p', { class: 'fine' }, 'Covers and posters belong to their owners. Only names are sent to these services, never your files.'));
    this.el = h('div', { class: 'overlay' }, this.sheet);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
  }

  close() { this.app.closeLayer(this); }

  onAction(a) {
    if (a === 'back' || a === 'confirm' || a === 'options') this.close();
    return true;
  }

  hints() {
    return [{ pad: 'circle', key: 'Esc', label: 'Close' }];
  }
}

// ---------------------------------------------------------- folder browser

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function openFolderBrowser(app) {
  let parent = null;
  const sheet = new ListSheet(app, {
    title: 'Add a folder',
    wide: true,
    hints: [
      { pad: 'cross', key: 'Enter', label: 'Open' },
      { pad: 'L1', key: 'Backspace', label: 'Up' },
      { pad: 'circle', key: 'Esc', label: 'Cancel' },
    ],
    onKey(a, ev, s) {
      if ((a === 'back' && ev?.key === 'Backspace') || a === 'catPrev') {
        if (parent != null) go(parent);
        return true;
      }
      return false;
    },
  });

  async function go(path) {
    let data;
    try {
      data = await api.browse(path);
    } catch (e) {
      toast(e.message, 'info');
      return;
    }
    if (data.error) {
      toast(data.error, 'info');
      return;
    }
    parent = data.parent;
    const items = [];
    if (data.path) {
      const c = data.counts;
      const found = [c.audio && plural(c.audio, 'song'), c.video && plural(c.video, 'video'), c.image && plural(c.image, 'photo')].filter(Boolean);
      items.push({
        label: 'Add this folder', icon: 'folderPlus', primary: true, sm: found.length ? `${found.join(' · ')} here` : 'looks inside subfolders too',
        async action() {
          try {
            await api.addRoot(data.path);
            toast(`Added ${data.name}`, 'folder');
            app.libraryChanged();
          } catch (e) {
            toast(e.message);
            return 'keep';
          }
        },
      });
      items.push({ label: 'Up one level', icon: 'back', keep: true, action: () => go(data.parent) });
      items.push({ sep: true });
    }
    for (const s of data.shortcuts || []) items.push({ label: s.name, icon: 'folder', keep: true, action: () => go(s.path) });
    if (data.shortcuts?.length && data.drives?.length) items.push({ sep: true });
    for (const d of data.drives || []) items.push({ label: d.name, icon: 'folder', sm: 'Drive', keep: true, action: () => go(d.path) });
    for (const d of data.dirs) items.push({ label: d.name, icon: 'folder', keep: true, action: () => go(d.path) });
    if (data.path && !data.dirs.length) items.push({ label: 'No subfolders', disabled: true });
    sheet.setItems(items, { title: data.path ? data.name : 'Add a folder', path: data.path });
  }

  app.openLayer(sheet);
  go('');
}

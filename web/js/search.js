// Search across the whole library: albums, songs, movies, shows, home clips and photos.
// The matching is plain functions over the shelves (buildIndex, search), so it can be tested without a browser;
// openSearch is the pop-up that types into it and opens what you pick.
import { ListSheet } from './ui.js';
import { h } from './util.js';

/** Lowercase, accent-free, punctuation-free: how both the text and the query are compared. */
export const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const folder = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
const words = (...parts) => parts.flat().filter((p) => p != null && p !== '').join(' ');
const dot = (...parts) => parts.filter((p) => p != null && p !== '').join(' · ');

/** One searchable thing per album, song, video entry and photo. `t` is its folded title, `o` the folded rest (artist, year, genre…). */
export function buildIndex(cols) {
  const docs = [];
  const add = (d) => docs.push({ ...d, t: fold(d.title), o: fold(d.other) });
  for (const [shelf, albums] of [['music', cols.music], ['nocover', cols.nocover], ['spoken', cols.spoken]]) for (const a of albums || []) {
    add({ kind: 'album', shelf, entry: a, title: a.title, other: words(a.artist, a.year, a.genre), sub: dot(a.artist, a.year) });
    for (const t of a.tracks) add({ kind: 'track', shelf, entry: a, track: t, title: t.title, other: words(t.artist, a.artist), sub: `${t.artist || a.artist} — ${a.title}` });
  }
  // "Continue" only repeats these, so it isn't searched.
  for (const shelf of ['video', 'unmatched']) {
    for (const e of (cols[shelf] || [])) {
      if (e.kind === 'show') {
        const m = e.meta || {};
        add({ kind: 'show', shelf, entry: e, title: e.title, other: words(e.year, m.network, m.genres || []), sub: dot(e.year, `${e.episodes.length} episode${e.episodes.length === 1 ? '' : 's'}`) });
      } else {
        const clip = e.parsed?.type === 'clip';
        add({ kind: clip ? 'clip' : 'movie', shelf, entry: e, title: e.title, other: words(e.year, e.meta?.genres || [], clip ? 'home video clip' : ''), sub: dot(e.year, e.meta?.genres?.[0]) || (clip ? 'Home video' : '') });
      }
    }
  }
  for (const a of cols.albums || []) add({ kind: 'folder', shelf: 'albums', entry: a, title: a.title, other: words(a.parent), sub: dot('Photo album', `${a.photos.length} photo${a.photos.length === 1 ? '' : 's'}`, a.parent && `in ${a.parent}`) });
  for (const p of cols.photo || []) add({ kind: 'photo', shelf: 'photo', entry: p, title: p.title, other: words(folder(p.dir), new Date(p.mtime).getFullYear()), sub: folder(p.dir) });
  return docs;
}

/** How well one word of the query matches a document, 0 for not at all. A title counts for more than the rest. */
function wordScore(d, k) {
  if (d.t === k) return 10;
  if (d.t.startsWith(k)) return 8;
  if ((` ${d.t}`).includes(` ${k}`)) return 6;
  if (k.length >= 3 && d.t.includes(k)) return 3;
  if ((` ${d.o}`).includes(` ${k}`)) return 2.5;
  if (k.length >= 3 && d.o.includes(k)) return 1;
  return 0;
}

const GROUPS = [
  { id: 'album', label: 'Albums', kinds: ['album'], max: 6 },
  { id: 'track', label: 'Songs', kinds: ['track'], max: 8 },
  { id: 'video', label: 'Movies & shows', kinds: ['movie', 'show', 'clip'], max: 10 },
  { id: 'photo', label: 'Photos', kinds: ['folder', 'photo'], max: 8 },
];

/** Every word of the query must match (title first, then artist/year/genre/folder). Returns { groups: [{ id, label, total, items }], total }. */
export function search(docs, query) {
  const toks = fold(query).split(' ').filter(Boolean);
  const out = { groups: [], total: 0 };
  if (!toks.length) return out;
  const whole = toks.join(' ');
  const hits = [];
  for (const d of docs) {
    let score = 0;
    for (const k of toks) {
      const s = wordScore(d, k);
      if (!s) { score = 0; break; }
      score += s;
    }
    if (!score) continue;
    if (d.t === whole) score += 10;
    else if (d.t.startsWith(whole)) score += 4;
    hits.push({ d, score });
  }
  hits.sort((a, b) => b.score - a.score || a.d.t.localeCompare(b.d.t, undefined, { numeric: true }));
  for (const g of GROUPS) {
    const list = hits.filter((x) => g.kinds.includes(x.d.kind));
    if (list.length) out.groups.push({ id: g.id, label: g.label, total: list.length, items: list.slice(0, g.max).map((x) => x.d) });
    out.total += list.length;
  }
  return out;
}

const ICON = { album: 'music', track: 'music', movie: 'film', show: 'film', clip: 'film', photo: 'image', folder: 'folder' };

/** The pop-up: type to filter, arrows or the mouse to choose, Enter to open. `home` is the shelf screen that opens the result. */
export function openSearch(app, home) {
  let index = null;
  const docs = () => {
    if (!index || index.cols !== app.cols) index = { cols: app.cols, docs: buildIndex(app.cols) }; // rebuilt only when the library changes
    return index.docs;
  };
  const sheet = new ListSheet(app, {
    title: 'Search',
    wide: true,
    items: [],
    hints: [{ pad: 'cross', key: 'Enter', label: 'Open' }, { pad: 'D-pad', key: '↑ ↓', label: 'Choose' }, { pad: 'circle', key: 'Esc', label: 'Close' }],
  });
  const input = h('input', { class: 'field', type: 'text', placeholder: 'Songs, albums, movies, shows, photos…', spellcheck: 'false', autocomplete: 'off' });
  sheet.sheet.insertBefore(input, sheet.titleEl.nextSibling);

  const run = () => {
    const q = input.value;
    if (!fold(q)) return sheet.setItems([{ label: 'Start typing to search your library', disabled: true }], { note: '' });
    const { groups, total } = search(docs(), q);
    if (!total) return sheet.setItems([{ label: 'No matches', disabled: true }], { note: 'Try fewer or different words.' });
    const items = groups.flatMap((g) => [
      { label: `${g.label.toUpperCase()}${g.total > g.items.length ? ` · ${g.total}` : ''}`, disabled: true },
      ...g.items.map((d) => ({ label: d.title, sm: d.sub, icon: ICON[d.kind], action: () => home.reveal(d.shelf, d.entry, { select: d.track?.id }) })),
    ]);
    sheet.setItems(items, { note: '' });
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must never reach the global shortcuts
    if (e.key === 'ArrowDown') { e.preventDefault(); sheet.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sheet.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); sheet.confirm(); }
    else if (e.key === 'Escape') { e.preventDefault(); sheet.close(); }
  });
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 60); });
  sheet.opts.onClose = () => clearTimeout(timer);

  run();
  app.openLayer(sheet);
  setTimeout(() => input.focus(), 60);
}

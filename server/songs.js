'use strict';
// Works out the right details for individual songs: it searches online for each one by its title and artist (from its
// tags, or from its file name and folders when the tags are missing), and proposes the answer. Nothing is written until
// the user has looked at the proposals and approved some; then the approved ones are saved into the files, with undo.
const path = require('path');
const { ACCEPT } = require('./providers');

const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'track', 'year', 'genre'];
const text = (v, n = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const whole = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
const soft = (e) => {
  if (e.code === 'OFFLINE') throw e;
  return [];
};

/** "Some Band - Some Song (Official Video) [HD]" → { artist: 'Some Band', title: 'Some Song' }. */
function parseName(name) {
  const n = String(name || '')
    .replace(/[\[(](official|lyrics?|audio|video|hd|hq|4k|music video|visuali[sz]er)[^\])]*[\])]/gi, ' ')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = n.split(/\s+[-–—]\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) return { artist: parts[0].trim(), title: parts[1].trim() };
  return { artist: '', title: n };
}

/** What to search for: the tags where there are some, the file name and folders where there are not. */
function songQuery(it) {
  const fromName = parseName(it.fileTitle || path.basename(it.path, path.extname(it.path)));
  const title = text(it.title) || fromName.title;
  const artist = text(it.artist) || (!it.title ? fromName.artist : '') || text(it.dirArtist);
  return { title, artist, album: text(it.album) || text(it.dirAlbum) };
}

const current = (it) => Object.fromEntries(FIELDS.map((k) => [k, it[k]]).filter(([, v]) => v != null && v !== ''));

/** True when a candidate would change nothing about the song. */
function sameAs(cur, c) {
  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  return eq(cur.title, c.title) && eq(cur.artist, c.artist) && eq(cur.album, c.album)
    && (!c.track || cur.track === c.track) && (!c.year || cur.year === c.year) && (!c.genre || eq(cur.genre, c.genre));
}

class SongIdentifier {
  constructor(lib, providers, writeback) {
    this.lib = lib;
    this.p = providers;
    this.wb = writeback;
    this.results = new Map(); // id → proposal
    this.art = new Map(); // id → artwork URLs of its candidates; these never leave the server
    this.state = { active: false, done: 0, total: 0, current: '', offline: false, error: '', cancelled: false };
    this.run = 0;
  }

  snapshot() {
    return { ...this.state, results: [...this.results.values()] };
  }

  /** Begin looking up these songs (replacing any earlier run). Returns how many were queued. */
  start(ids) {
    const items = ids.map((id) => this.lib.get(id)).filter((it) => it && it.kind === 'audio');
    const run = ++this.run;
    this.results = new Map();
    this.art = new Map();
    this.state = { active: items.length > 0, done: 0, total: items.length, current: '', offline: false, error: '', cancelled: false };
    this._go(items, run);
    return items.length;
  }

  cancel() {
    this.run++; // the running loop notices it is no longer the current one
    this.state.active = false;
    this.state.cancelled = true;
    this.state.current = '';
  }

  async _go(items, run) {
    let offline = 0;
    for (const it of items) {
      if (run !== this.run) return;
      this.state.current = path.basename(it.path);
      try {
        this.results.set(it.id, await this.identify(it));
        offline = 0;
      } catch (e) {
        this.state.error = e.message;
        this.results.set(it.id, this._result(it, songQuery(it), [], 'error'));
        if (e.code === 'OFFLINE' && ++offline >= 3) {
          this.state.offline = true;
          this.state.done += items.length - this.state.done;
          break;
        }
      }
      if (run !== this.run) return;
      this.state.done++;
    }
    if (run === this.run) {
      this.state.active = false;
      this.state.current = '';
    }
  }

  _result(it, query, candidates, status) {
    const cur = current(it);
    const writable = this.wb.canWrite(it.path);
    const best = candidates.findIndex((c) => c.score >= ACCEPT.song);
    const pick = best >= 0 ? best : candidates.length ? 0 : -1;
    const unchanged = pick >= 0 && sameAs(cur, candidates[pick]);
    this.art.set(it.id, candidates.map((c) => c.artUrl));
    return {
      id: it.id,
      name: path.basename(it.path),
      writable,
      query,
      current: cur,
      candidates: candidates.map(({ artUrl, ...c }) => ({ ...c, hasArt: !!artUrl })),
      pick,
      confident: best >= 0,
      status: status || (pick < 0 ? 'none' : unchanged ? 'same' : 'found'),
    };
  }

  async identify(it) {
    const query = songQuery(it);
    if (!query.title) return this._result(it, query, [], 'none');
    let candidates = await this.p.songCandidates(query).catch(soft);
    // Tags that name the wrong artist would hide the right song: try the title alone before giving up.
    if (!candidates.some((c) => c.score >= ACCEPT.song) && query.artist) {
      const alone = await this.p.songCandidates({ ...query, artist: '' }).catch(soft);
      candidates = candidates.concat(alone.map((c) => ({ ...c, score: Math.min(c.score, 0.7) }))); // a title match alone is a suggestion, not an answer
    }
    candidates = candidates.sort((a, b) => b.score - a.score).slice(0, 5);
    return this._result(it, query, candidates);
  }

  /**
   * Save what the user approved. `changes` is [{ id, pick, fields?, art? }]: `pick` chooses among the candidates found
   * for that song, `fields` replaces any of the values (the user edited them), `art` also adds the cover when the file
   * has none. Resolves what writeback.songs does.
   */
  async apply(changes) {
    const jobs = [];
    for (const ch of Array.isArray(changes) ? changes : []) {
      const res = this.results.get(ch?.id);
      if (!res) continue;
      const cand = res.candidates[ch.pick] || {};
      // What the user typed replaces the proposal field by field, but only where it is usable: a nonsense value is dropped, not applied.
      const typed = ch.fields && typeof ch.fields === 'object' ? ch.fields : {};
      const clean = {
        title: text(typed.title), artist: text(typed.artist), album: text(typed.album), albumArtist: text(typed.albumArtist),
        genre: text(typed.genre, 60), track: whole(typed.track, 1, 999), trackCount: whole(typed.trackCount, 1, 999), year: whole(typed.year, 1000, 2100),
      };
      const set = {};
      for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre']) set[k] = clean[k] || text(cand[k], k === 'genre' ? 60 : 300);
      for (const k of ['track', 'trackCount', 'year']) set[k] = clean[k] ?? whole(cand[k], 1, k === 'year' ? 2100 : 999);
      let image = null;
      const url = ch.art ? this.art.get(ch.id)?.[ch.pick] : null;
      if (url) image = await this.p.firstImage([url]).catch(() => null);
      jobs.push({ id: ch.id, set, image });
    }
    const out = await this.wb.songs(jobs);
    for (const id of out.done) {
      const r = this.results.get(id);
      if (r) { r.status = 'applied'; r.current = current(this.lib.get(id)); }
    }
    return out;
  }
}

module.exports = { SongIdentifier, songQuery, parseName, sameAs };

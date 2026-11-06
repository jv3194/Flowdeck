'use strict';
// "Tidy folder names": rename the folder a movie or show lives in to a clean "Title (Year)", or put loose files into a
// folder of their own. These are real changes to the user's files, so the rules are strict:
//   - nothing happens until the plan has been shown and approved;
//   - nothing is ever overwritten or merged (a folder is only renamed to a name that is free);
//   - only folders inside the library folders are touched, and only ones that hold nothing but what is being renamed;
//   - every change goes into a journal first-hand, so the last ones can be undone exactly;
//   - the library carries what it knows about the files (artwork, watch progress, caches) across the move.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { normalize, parseVideoName, SEASON_DIR } = require('./names');
const { findSidecars, SUB_EXT } = require('./subtitles');

const WIN = process.platform === 'win32';
const key = (p) => (WIN ? String(p).toLowerCase() : String(p));
const same = (a, b) => key(a) === key(b);
const withSep = (d) => (d.endsWith(path.sep) ? d : d + path.sep);
const isUnder = (p, dir) => !same(p, dir) && key(p).startsWith(key(withSep(dir))); // strictly inside
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i; // names Windows will not let a folder have
const MAX_PATH = 250; // Windows stops at 260, and some programs trip a little earlier
const MAX_NAME = 150;
const KEEP_BATCHES = 10;
const ID = /^[0-9a-f]{8,32}$/;

// Other files that belong to a video and travel with it when it is moved into a folder of its own. (Subtitles are
// matched the way the player matches them: see _sidecars.)
const SIDECAR_EXT = new Set(['sub', 'idx', 'sup', 'nfo', 'jpg', 'jpeg', 'png']);
const SIDECAR_ART = /^-(poster|fanart|thumb|landscape|banner|clearlogo|logo)\.(jpe?g|png)$/i;
const DISC_DIR = /^(cd|disc|disk|dvd|bd)[ ._-]?\d{1,2}$/i; // "Heat (1995)/CD1/heat.mkv": the movie's folder is the one above
const MANAGED = /(^|[\\/])(sonarr|radarr)([\\/]|$)/i;
const DOWNLOADS = /(^|[\\/])(downloads?|incoming|torrents?|seeding|complete|incomplete)([\\/]|$)/i;

/** Make text safe to use as a folder name on Windows: no separators or forbidden characters, no trailing dots or spaces. */
function safeName(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
}

const finish = (name) => {
  const n = name.slice(0, MAX_NAME).replace(/[\s.]+$/g, '');
  return n && RESERVED.test(n) ? `${n} _` : n;
};

/** "Title (Year)", or just the title when no year is known. A year already on the title is not doubled. */
function folderName(title, year) {
  const t = safeName(String(title ?? '').replace(/\s*[(\[]\s*(?:19|20)\d{2}\s*[)\]]\s*$/, ''));
  if (!t) return '';
  const y = Number(year);
  return finish(Number.isInteger(y) && y >= 1870 && y <= 2100 ? `${t.slice(0, MAX_NAME - 7)} (${y})` : t);
}

/** A name the user typed: kept as written, only made safe. */
const customName = (text) => finish(safeName(text));

const seasonDir = (n) => (Number(n) === 0 ? 'Specials' : `Season ${String(Number(n) || 1).padStart(2, '0')}`);

/** What a folder's own name says about the title and year ("Ronin.1998.720p-RARBG" -> Ronin, 1998), or null. */
function folderGuess(dir) {
  const parent = path.dirname(dir);
  const g = parseVideoName(path.join(parent, `${path.basename(dir)}.mkv`), parent);
  return g.type === 'movie' && g.title ? g : null;
}

/** What the page may ask for: a list of { ids, kind, title, year, name? }, cleaned of anything else. */
function cleanTargets(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3000).map((t) => {
    const year = t?.year == null || t.year === '' ? NaN : Number(t.year); // null and "" mean "unknown", not the year 0
    return {
      ids: Array.isArray(t?.ids) ? [...new Set(t.ids.filter((i) => typeof i === 'string' && ID.test(i)))].slice(0, 5000) : [],
      kind: t?.kind === 'show' ? 'show' : 'movie',
      title: typeof t?.title === 'string' ? t.title.slice(0, 300) : '',
      year: Number.isInteger(year) && year > 0 ? year : null,
      name: typeof t?.name === 'string' && t.name.trim() ? t.name.slice(0, 300) : '',
      looked: t?.looked === true, // the title and year come from an online lookup, not just from the file name
    };
  });
}

/** A short reason a file operation failed, in words a person can act on. */
function why(e) {
  if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return 'it is in use: close any player or program that has it open';
  if (e.code === 'ENOENT') return 'it was moved or deleted';
  if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') return 'something with that name is already there';
  return e.message || String(e.code || 'unknown error');
}

class Tidy {
  /**
   * @param lib       the Library
   * @param dataDir   where the undo journal lives
   * @param migrate   async (Map old id → new id): move whatever else is keyed by an item's id (preferences, caches)
   * @param busy      () => '' or a reason to refuse right now (a lookup is running)
   * @param ops       file operations, replaceable by tests
   */
  constructor({ lib, dataDir, migrate = async () => {}, busy = () => '', ops = {} }) {
    this.lib = lib;
    this.file = path.join(dataDir, 'tidy-undo.json');
    this.migrate = migrate;
    this.busy = busy;
    this.ops = { rename: fsp.rename, mkdir: fsp.mkdir, rmdir: fsp.rmdir, lstat: fsp.lstat, readdir: fsp.readdir, ...ops };
    this.batches = null;
  }

  async _stat(p) {
    try {
      return await this.ops.lstat(p);
    } catch {
      return null;
    }
  }

  _context() {
    const under = new Map(); // folder → the ids of every library file at or below it
    for (const it of this.lib.items.values()) {
      for (let d = path.dirname(it.path); ; d = path.dirname(d)) {
        let ids = under.get(key(d));
        if (!ids) under.set(key(d), (ids = new Set()));
        ids.add(it.id);
        if (path.dirname(d) === d) break;
      }
    }
    return { roots: this.lib.roots.slice(), photoRoots: this.lib.photoRoots.slice(), under };
  }

  /**
   * The files that go with a video, found beside it: its subtitles (exactly the ones the player would show for it, so
   * a "Subs" folder is left alone), and an .nfo or artwork named after it.
   */
  async _sidecars(item, ctx) {
    const dir = path.dirname(item.path);
    const file = path.basename(item.path);
    const base = path.basename(item.path, path.extname(item.path)).toLowerCase();
    const out = new Set();
    for (const s of await findSidecars(item.path)) if (same(path.dirname(s.file), dir)) out.add(s.file);
    // Another video's own files are not this one's, even when its name starts with this one's ("Heat" and "Heat.1995").
    const longer = [...(ctx.under.get(key(dir)) || [])]
      .map((id) => this.lib.get(id))
      .filter((o) => o && o.id !== item.id && same(path.dirname(o.path), dir))
      .map((o) => path.basename(o.path, path.extname(o.path)).toLowerCase())
      .filter((b) => b.length > base.length && b.startsWith(base));
    let names = [];
    try {
      names = await this.ops.readdir(dir);
    } catch {
      /* unreadable: nothing more travels with it */
    }
    for (const n of names) {
      const lower = n.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf('.') + 1);
      if (n === file || SUB_EXT.has(ext)) continue;
      let mine = false;
      if (lower.startsWith(`${base}.`)) mine = SIDECAR_EXT.has(ext);
      else if (lower.startsWith(`${base}-`)) mine = SIDECAR_ART.test(lower.slice(base.length));
      if (mine && !longer.some((b) => lower.startsWith(`${b}.`) || lower.startsWith(`${b}-`))) out.add(path.join(dir, n));
    }
    return [...out].sort();
  }

  /** What would change for each target, without changing anything. */
  async plan(targets) {
    const ts = cleanTargets(targets);
    const ctx = this._context();
    const claimed = new Set();
    const out = [];
    for (let i = 0; i < ts.length; i++) out.push(await this._planOne(ts[i], i, ctx, claimed));
    return out;
  }

  async _planOne(t, index, ctx, claimed) {
    const plan = { index, status: 'blocked', action: null, from: '', to: '', name: '', moves: [], created: [], files: 0, reason: '', warnings: [] };
    const block = (reason) => {
      plan.status = 'blocked';
      plan.reason = reason;
      plan.moves = [];
      plan.created = [];
      return plan;
    };
    const items = t.ids.map((id) => this.lib.get(id));
    if (!items.length || items.some((it) => !it || it.kind !== 'video')) return block('It is no longer in the library');
    if (items.some((it) => it.parsed?.type === 'clip')) return block('This looks like a home video, not a movie or show');
    const want = t.kind === 'show' ? 'episode' : 'movie';
    if (items.some((it) => it.parsed?.type !== want)) return block(t.kind === 'show' ? 'These are not all episodes of a show' : 'This is not a movie');
    if (t.kind === 'movie' && items.length !== 1) return block('A movie is a single file');
    const name = t.name ? customName(t.name) : folderName(t.title, t.year);
    if (!name) return block('There is no title to name it after');
    plan.name = name;
    const ids = new Set(items.map((it) => it.id));
    const ownTitle = normalize(items[0].parsed.show || items[0].parsed.title);

    const warn = (dir) => {
      if (MANAGED.test(dir)) plan.warnings.push('Sonarr or Radarr keeps its own record of this folder. After the change, point it at the new folder there, or it will report the files missing.');
      if (DOWNLOADS.test(dir)) plan.warnings.push('This looks like a downloads folder. A download client that is still seeding these files will lose them.');
    };

    /**
     * The name to give `from`. When the page only had a file name to go on (nothing looked up online), the folder's own
     * name often says more: the year, and better capital letters ("ronin.mp4" in "Ronin.1998.720p" is Ronin (1998)).
     */
    const nameFor = (from) => {
      if (t.name || t.looked) return name;
      const g = folderGuess(from);
      if (!g) return name;
      const lower = (x) => x === x.toLowerCase();
      const title = normalize(g.title) === normalize(t.title) && lower(t.title) && !lower(g.title) ? g.title : t.title; // "ronin" -> "Ronin", but a title already in capitals stays
      return folderName(title, t.year ?? g.year) || name;
    };

    /** Rename the folder `from` itself. */
    const rename = async (from) => {
      if (ctx.roots.some((r) => same(r, from)) || ctx.photoRoots.some((r) => same(r, from))) return block('This is one of your library folders itself');
      if ([...ctx.roots, ...ctx.photoRoots].some((r) => isUnder(r, from))) return block('One of your library folders lives inside it');
      if (!ctx.roots.some((r) => isUnder(from, r))) return block('It is outside your library folders');
      const held = ctx.under.get(key(from)) || new Set();
      if ([...held].some((id) => !ids.has(id))) return block('This folder also holds other videos or files from your library');
      const target = nameFor(from);
      plan.name = target;
      plan.from = from;
      if (path.basename(from) === target) {
        plan.status = 'same';
        plan.to = from;
        plan.reason = `Already named “${target}”`;
        return plan;
      }
      const to = path.join(path.dirname(from), target);
      if (!same(from, to) && (await this._stat(to))) return block(`A folder named “${target}” already exists next to it`);
      for (const id of held) if (to.length + this.lib.get(id).path.length - from.length > MAX_PATH) return block('The new path would be too long for Windows');
      if (claimed.has(key(to))) return block('Another item in this list is being given the same folder name');
      claimed.add(key(to));
      warn(from);
      Object.assign(plan, { status: 'ready', action: 'rename', to, moves: [{ from, to, isDir: true }] });
      return plan;
    };

    /** Put the videos (and their subtitles and the like) into a folder of their own inside `inDir`, in season folders for shows. */
    const organize = async (inDir, placements) => {
      if (!ctx.roots.some((r) => same(r, inDir) || isUnder(inDir, r))) return block('It is outside your library folders');
      const folder = path.join(inDir, name);
      const st = await this._stat(folder);
      if (st && !st.isDirectory()) return block(`“${name}” already exists here and is not a folder`);
      const created = st ? [] : [folder];
      const moves = [];
      const mine = new Set();
      const seen = new Set();
      for (const { item, sub } of placements) {
        const destDir = sub ? path.join(folder, sub) : folder;
        if (sub && !seen.has(sub)) {
          seen.add(sub);
          const ss = st ? await this._stat(destDir) : null;
          if (ss && !ss.isDirectory()) return block(`“${sub}” already exists in “${name}” and is not a folder`);
          if (!ss) created.push(destDir);
        }
        for (const from of [item.path, ...(await this._sidecars(item, ctx))]) {
          const to = path.join(destDir, path.basename(from));
          if (await this._stat(to)) return block(`“${path.basename(from)}” is already in “${name}”`);
          if (claimed.has(key(to)) || mine.has(key(to))) return block('Another item in this list is moving a file with the same name there');
          if (to.length > MAX_PATH) return block('The new path would be too long for Windows');
          mine.add(key(to));
          moves.push({ from, to, isDir: false });
        }
      }
      for (const k of mine) claimed.add(k);
      if (st) plan.warnings.push(`Adds to the folder “${name}” that is already there; nothing in it is replaced.`);
      for (const n of ['Subs', 'Subtitles']) if (await this._stat(path.join(inDir, n))) { plan.warnings.push('Subtitles kept in a separate Subs folder stay where they are, so they no longer go with the video.'); break; }
      warn(inDir);
      Object.assign(plan, { status: 'ready', action: 'organize', from: inDir, to: folder, moves, created, files: moves.length });
      return plan;
    };

    const isRoot = (d) => ctx.roots.some((r) => same(r, d));
    /** True when the folder has other titles in it: a collection folder, where a title of its own makes sense. */
    const collection = (dir) => [...(ctx.under.get(key(dir)) || [])].some((id) => {
      if (ids.has(id)) return false;
      const o = this.lib.get(id)?.parsed;
      return o && normalize(o.show || o.title) !== ownTitle;
    });
    const holdsOnly = (dir) => [...(ctx.under.get(key(dir)) || [])].every((id) => ids.has(id));

    if (t.kind === 'movie') {
      let dir = path.dirname(items[0].path);
      if (DISC_DIR.test(path.basename(dir)) && !isRoot(dir)) dir = path.dirname(dir);
      if (isRoot(dir) || (!holdsOnly(dir) && collection(dir))) return organize(dir, [{ item: items[0], sub: '' }]);
      if (holdsOnly(dir)) return rename(dir);
      return block('This folder holds more than one version of it, or other videos');
    }

    // A show: the folder its episodes share, climbing out of "Season 2" folders.
    const home = (it) => {
      const d = path.dirname(it.path);
      return SEASON_DIR.test(path.basename(d)) && !isRoot(d) ? path.dirname(d) : d;
    };
    const homes = [...new Map(items.map((it) => [key(home(it)), home(it)])).values()];
    if (homes.length !== 1) return block('Its episodes are in several different folders');
    const [dir] = homes;
    if (isRoot(dir) || (!holdsOnly(dir) && collection(dir))) return organize(dir, items.map((item) => ({ item, sub: seasonDir(item.parsed.season) })));
    if (holdsOnly(dir)) return rename(dir);
    return block('This folder also holds other videos');
  }

  // ---------------------------------------------------------------- doing it

  /** Carry out one ready plan; either all of it happens or none of it does. Returns what was done. */
  async _execute(p) {
    const moved = [];
    const made = [];
    try {
      for (const dir of p.created) {
        try {
          await this.ops.mkdir(dir);
          made.push(dir);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e; // it appeared meanwhile: fine, as long as it is a folder
          if (!(await this._stat(dir))?.isDirectory()) throw e;
        }
      }
      for (const m of p.moves) {
        if (!(await this._stat(m.from))) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const caseOnly = m.isDir && same(m.from, m.to) && m.from !== m.to;
        if (!caseOnly && (await this._stat(m.to))) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        await this.ops.rename(m.from, m.to);
        moved.push(m);
      }
      return { moves: moved, created: made };
    } catch (e) {
      for (const m of moved.reverse()) await this.ops.rename(m.to, m.from).catch(() => {});
      for (const d of made.reverse()) await this.ops.rmdir(d).catch(() => {});
      throw e;
    }
  }

  /** Move whatever is keyed by the old ids to the new ones. A failure here is logged, not allowed to stop the rest. */
  async _carry(idMap) {
    try {
      await this.migrate(idMap);
    } catch (e) {
      console.error('tidy: could not carry everything across to the new names:', e.message);
    }
  }

  async _load() {
    if (this.batches) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.batches = Array.isArray(data.batches) ? data.batches : [];
    } catch {
      this.batches = [];
    }
  }

  async _save() {
    this.batches = this.batches.slice(0, KEEP_BATCHES);
    const tmp = `${this.file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ batches: this.batches }));
      await fsp.rename(tmp, this.file);
    } catch (e) {
      console.error('could not save the tidy journal:', e.message);
    }
  }

  /**
   * Do the approved targets. Each one stands alone: one that cannot be done (in use, already taken) is reported and
   * the rest go ahead. Returns { batch, folders, files, failed: [{ index, reason }], skipped, idMap }.
   */
  async apply(targets) {
    const busy = this.busy();
    if (busy) throw Object.assign(new Error(busy), { status: 409 });
    await this._load();
    const result = { batch: '', folders: 0, files: 0, failed: [], skipped: 0, idMap: {} };
    await this.lib.paused(async () => {
      const plans = await this.plan(targets);
      const batch = { id: crypto.randomBytes(5).toString('hex'), at: Date.now(), label: '', entries: [] };
      for (const p of plans) {
        if (p.status === 'same') { result.skipped++; continue; }
        if (p.status !== 'ready') { result.failed.push({ index: p.index, reason: p.reason }); continue; }
        let done;
        try {
          done = await this._execute(p);
        } catch (e) {
          result.failed.push({ index: p.index, reason: why(e) });
          continue;
        }
        // The journal first, so what has been done can always be undone; then the library and what is keyed by it.
        const entry = { moves: done.moves, created: done.created, idMap: [] };
        batch.entries.push(entry);
        batch.label = batch.entries.length === 1 ? path.basename(p.to) : `${batch.entries.length} folders`;
        this.batches = [batch, ...this.batches.filter((b) => b !== batch)];
        await this._save();
        const idMap = await this.lib.movePaths(done.moves);
        entry.idMap = [...idMap];
        await this._save();
        await this._carry(idMap);
        for (const [a, b] of idMap) result.idMap[a] = b;
        result.folders += done.moves.filter((m) => m.isDir).length + done.created.length;
        result.files += done.moves.filter((m) => !m.isDir).length;
      }
      result.batch = batch.entries.length ? batch.id : '';
      if (!batch.entries.length) this.batches = this.batches.filter((b) => b !== batch);
    });
    return result;
  }

  /** The last few batches that can still be undone, newest first. */
  async history() {
    await this._load();
    return this.batches.map((b) => ({
      id: b.id, at: b.at, label: b.label,
      folders: b.entries.reduce((n, e) => n + e.moves.filter((m) => m.isDir).length, 0),
      files: b.entries.reduce((n, e) => n + e.moves.filter((m) => !m.isDir).length, 0),
    }));
  }

  /**
   * Put a batch back exactly as it was. A change that can no longer be reversed (the folder was renamed again, or its old
   * name is taken) is left alone and reported; the rest are undone.
   */
  async undo(id) {
    const busy = this.busy();
    if (busy) throw Object.assign(new Error(busy), { status: 409 });
    await this._load();
    const batch = this.batches.find((b) => b.id === id);
    if (!batch) throw Object.assign(new Error('That change is no longer in the undo list'), { status: 404 });
    const out = { undone: 0, failed: [], idMap: {} };
    await this.lib.paused(async () => {
      const left = [];
      for (const entry of [...batch.entries].reverse()) {
        const back = [...entry.moves].reverse().map((m) => ({ from: m.to, to: m.from, isDir: m.isDir }));
        try {
          await this._execute({ created: [], moves: back });
        } catch (e) {
          out.failed.push(why(e));
          left.unshift(entry);
          continue;
        }
        for (const dir of [...entry.created].reverse()) await this.ops.rmdir(dir).catch(() => {}); // the folders we made, if empty
        const idMap = await this.lib.movePaths(back);
        await this._carry(idMap);
        for (const [a, b] of idMap) out.idMap[a] = b;
        out.undone++;
      }
      if (left.length) batch.entries = left;
      else this.batches = this.batches.filter((b) => b !== batch);
      await this._save();
    });
    return out;
  }
}

/**
 * Re-key the preferences that are keyed by a video's id (where it got to, whether it is watched, its subtitle delay,
 * which entry was focused), given Map old id → new id. Values are lifted out first, so ids that swap can't clobber
 * each other.
 */
function migratePrefs(prefs, idMap) {
  if (!prefs || !idMap.size) return prefs;
  for (const k of ['progress', 'watched', 'lastPlayed', 'subDelay']) {
    const o = prefs[k];
    if (!o || typeof o !== 'object') continue;
    const lifted = new Map();
    for (const [a] of idMap) if (Object.hasOwn(o, a)) { lifted.set(a, o[a]); delete o[a]; }
    for (const [a, v] of lifted) o[idMap.get(a)] = v;
  }
  if (prefs.focus && typeof prefs.focus === 'object') for (const [cat, v] of Object.entries(prefs.focus)) if (idMap.has(v)) prefs.focus[cat] = idMap.get(v);
  return prefs;
}

module.exports = { Tidy, folderName, customName, cleanTargets, safeName, migratePrefs };

'use strict';
// Saves fetched artwork and details into the user's files, and can undo it.
// MP3 and FLAC get the year, genre and cover embedded in their tags. Other audio formats can't be tagged safely
// here, so they get a cover.jpg in their folder instead. See tagwrite.js for the safety rules.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readTags } = require('./tags');
const { restoreHeader, supportsTags, writeTags } = require('./tagwrite');

const fsp = fs.promises;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const ART_NAMES = /^(cover|folder|front|album|albumart|albumartsmall|albumartlarge)\.(jpe?g|png|webp)$/i;
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class WriteBack {
  constructor(lib, dataDir) {
    this.lib = lib;
    this.dir = path.join(dataDir, 'undo');
    this.indexFile = path.join(this.dir, 'index.json');
    this.entries = [];
    this.seq = 0;
    this.chain = Promise.resolve(); // file edits run one at a time, so two requests can never work on one file at once
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.entries = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      /* no journal yet */
    }
  }

  async _saveIndex() {
    const tmp = `${this.indexFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.entries));
    await fsp.rename(tmp, this.indexFile);
  }

  async _record(entry, original) {
    if (original) {
      entry.hdr = `${Date.now()}-${this.seq++}.hdr`;
      await fsp.writeFile(path.join(this.dir, entry.hdr), original);
    }
    this.entries.push({ ...entry, at: Date.now() });
    await this._saveIndex();
  }

  async _drop(entry) {
    this.entries = this.entries.filter((e) => e !== entry);
    if (entry.hdr) await fsp.rm(path.join(this.dir, entry.hdr), { force: true });
    await this._saveIndex();
  }

  /** Tracks whose fetched details haven't been saved into their files yet. */
  pending() {
    return [...this.lib.items.values()].filter((it) => it.kind === 'audio' && it.fetched?.found && !it.fetched.written && !it.fetched.noWrite).map((it) => it.id);
  }

  /** The picture fetched for this track's album, if there is one. */
  async _art(it) {
    const holder = this.lib.get(it.fetched.art || it.id);
    if (!holder?.fetched?.found || !holder.cf) return null;
    try {
      return { data: await fsp.readFile(path.join(this.lib.coverDir, `${holder.id}.${holder.cf}`)), mime: MIME[holder.cf] || 'image/jpeg' };
    } catch {
      return null;
    }
  }

  _serial(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Save fetched details into these tracks' files. `replaceArt` is for art the user picked by hand;
   * `force` re-checks tracks already saved. Resolves { wrote, same, skipped, failed, errors }.
   */
  tracks(ids, opts = {}) {
    return this._serial(() => this._tracks(ids, opts));
  }

  async _tracks(ids, { replaceArt = false, force = false }) {
    const out = { wrote: 0, same: 0, skipped: 0, failed: 0, errors: [] };
    const coveredDirs = new Set();
    for (const id of ids) {
      const it = this.lib.get(id);
      if (!it || it.kind !== 'audio' || !it.fetched || (!it.fetched.found && !it.fetched.filled?.length)) continue;
      if (it.fetched.noWrite && !force) { out.skipped++; continue; }
      if (it.fetched.written && !force && !replaceArt) { out.same++; continue; }
      const image = await this._art(it);
      const filled = it.fetched.filled || [];
      const wanted = { year: filled.includes('year') ? it.year : undefined, genre: filled.includes('genre') ? it.genre : undefined, image };
      try {
        if (supportsTags(it.path)) {
          const r = await writeTags(it.path, wanted, { replaceArt, journal: (original, newLen) => this._record({ kind: 'tags', id, path: it.path, newLen }, original) });
          if (r.changed) {
            out.wrote++;
            await this._refresh(it);
          } else if (r.reason === 'already complete') out.same++;
          else { out.skipped++; out.errors.push(`${path.basename(it.path)}: ${r.reason}`); }
          if (r.changed || r.reason === 'already complete') it.fetched.written = Date.now();
        } else if (image) {
          const dir = path.dirname(it.path);
          if (!coveredDirs.has(dir) && (await this._folderArt(dir, image, id))) out.wrote++;
          coveredDirs.add(dir);
          it.fetched.written = Date.now();
        } else {
          out.skipped++;
        }
      } catch (e) {
        out.failed++;
        out.errors.push(`${path.basename(it.path)}: ${e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' ? 'the file is in use or read-only' : e.message}`);
      }
    }
    this.lib._touch();
    return out;
  }

  async _folderArt(dir, image, id) {
    if ((await fsp.readdir(dir)).some((n) => ART_NAMES.test(n))) return false; // the folder already has a cover
    const ext = image.mime === 'image/png' ? 'png' : image.mime === 'image/webp' ? 'webp' : 'jpg';
    const file = path.join(dir, `cover.${ext}`);
    await fsp.writeFile(file, image.data, { flag: 'wx' }); // 'wx': never overwrite
    await this._record({ kind: 'cover', id, path: file, sha1: sha1(image.data) });
    return true;
  }

  /** The file just changed: bring the library's idea of it up to date so the next scan treats it as unchanged. */
  async _refresh(it) {
    const st = await fsp.stat(it.path);
    it.size = st.size;
    it.mtime = Math.round(st.mtimeMs);
    const t = await readTags(it.path, it.ext);
    it.hasPic = !!t.hasPic;
    if (t.duration) it.duration = t.duration;
    return t;
  }

  /** Put the original tags back (or remove a cover we added). Only touches what we changed, and only if it is still as we left it. */
  undo(ids) {
    return this._serial(() => this._undo(ids));
  }

  async _undo(ids) {
    const want = new Set(ids);
    const out = { restored: 0, skipped: 0 };
    for (const entry of this.entries.filter((e) => want.has(e.id)).reverse()) {
      try {
        if (entry.kind === 'tags') {
          await restoreHeader(entry.path, await fsp.readFile(path.join(this.dir, entry.hdr)), entry.newLen);
          const it = this.lib.get(entry.id);
          if (it) {
            const t = await this._refresh(it);
            it.year = t.year;
            it.genre = t.genre;
          }
        } else if (sha1(await fsp.readFile(entry.path)) === entry.sha1) {
          await fsp.rm(entry.path);
        } else {
          throw new Error('the cover was replaced since');
        }
        await this._drop(entry);
        out.restored++;
      } catch {
        out.skipped++;
      }
    }
    for (const id of ids) {
      const it = this.lib.get(id);
      if (it?.fetched) { it.fetched.noWrite = true; it.fetched.written = undefined; } // don't quietly redo what the user just undid
    }
    this.lib._touch();
    return out;
  }
}

module.exports = { WriteBack };

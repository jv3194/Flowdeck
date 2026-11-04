'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { readTags, readPicture } = require('./tags');
const { parseVideoName } = require('./names');

const IMAGE_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const EXT = {
  audio: new Set(['mp3', 'flac', 'm4a', 'm4b', 'aac', 'wav', 'ogg', 'oga', 'opus']),
  video: new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv']),
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']),
};
const kindOf = (ext) => (EXT.audio.has(ext) ? 'audio' : EXT.video.has(ext) ? 'video' : EXT.image.has(ext) ? 'image' : null);

const SKIP_DIRS = /^(\$recycle\.bin|system volume information|node_modules|appdata|windows|program files.*)$/i;
// Album-art sidecar files. They're used as covers and kept out of the Photos shelf.
const ART_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'albumartlarge'];
const ART_RE = /^(cover|folder|front|back|album|albumart.*|thumb)$/i;
const ART_EXT = ['jpg', 'jpeg', 'png', 'webp'];

const idFor = (p) => crypto.createHash('sha1').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 16);
const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function findFolderArt(dir, ents) {
  const found = new Map();
  for (const e of ents) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase();
    const base = path.basename(e.name, path.extname(e.name)).toLowerCase();
    if (ART_EXT.includes(ext) && ART_NAMES.includes(base) && !found.has(base)) found.set(base, e.name);
  }
  for (const n of ART_NAMES) if (found.has(n)) return path.join(dir, found.get(n));
  return null;
}

/** Fill in title/album/artist/track from the filename and folder layout when tags are missing. */
function guessFromPath(it) {
  const base = path.basename(it.path, path.extname(it.path));
  const m = /^\s*(\d{1,3})\s*[-._)\s]\s*(.+)$/.exec(base);
  it.fileTitle = (m ? m[2] : base).replace(/_/g, ' ').trim();
  it.fileTrack = m ? Number(m[1]) : undefined;
  const dir = path.dirname(it.path);
  it.dirAlbum = sameDir(dir, it.root) ? '' : path.basename(dir);
  const up = path.dirname(dir);
  it.dirArtist = !sameDir(dir, it.root) && !sameDir(up, it.root) && up.length > it.root.length ? path.basename(up) : '';
  if (it.kind === 'video') it.parsed = parseVideoName(it.path, it.root);
}

class Library {
  constructor(dataDir) {
    this.dir = dataDir;
    this.coverDir = path.join(dataDir, 'covers');
    this.file = path.join(dataDir, 'library.json');
    this.items = new Map();
    this.roots = [];
    this.rev = 0;
    this.scanning = false;
    this.progress = { done: 0, total: 0 };
    this._saveTimer = null;
    fs.mkdirSync(this.coverDir, { recursive: true });
  }

  async load() {
    // The last good copy (.bak) is the fallback if the main file is missing or damaged.
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        this.roots = Array.isArray(data.roots) ? data.roots : [];
        for (const it of data.items || []) this.items.set(it.id, it);
        this.rev++;
        return;
      } catch {
        /* first run, or unreadable: try the backup, then start empty */
      }
    }
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  async saveNow() {
    clearTimeout(this._saveTimer);
    const tmp = `${this.file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ roots: this.roots, items: [...this.items.values()] }));
      await fsp.copyFile(this.file, `${this.file}.bak`).catch(() => {}); // keep the previous version as a fallback
      await fsp.rename(tmp, this.file);
    } catch (e) {
      console.error('could not save library:', e.message);
    }
  }

  async addRoot(p) {
    const abs = path.resolve(p);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw new Error('Not a folder');
    if (!this.roots.some((r) => sameDir(r, abs))) this.roots.push(abs);
    this.rev++;
    this.save();
    this.scan();
    return abs;
  }

  removeRoot(p) {
    const abs = path.resolve(p);
    this.roots = this.roots.filter((r) => !sameDir(r, abs));
    for (const [id, it] of this.items) {
      if (sameDir(it.root, abs)) {
        this._dropCover(it);
        this.items.delete(id);
      }
    }
    this.rev++;
    this.save();
  }

  toClient(it) {
    return {
      id: it.id,
      kind: it.kind,
      ext: it.ext,
      name: it.fileTitle,
      title: it.title || it.fileTitle,
      artist: it.artist || it.dirArtist || '',
      album: it.album || it.dirAlbum || '',
      albumArtist: it.albumArtist || '',
      track: it.track || it.fileTrack,
      disc: it.disc,
      year: it.year,
      genre: it.genre,
      duration: it.duration,
      size: it.size,
      mtime: it.mtime,
      added: it.added,
      cover: it.cf || it.pf || it.hasPic || it.folderArt ? 1 : 0,
      cv: it.cv || 0, // bumps whenever the cover changes, so the browser re-fetches it
      poster: it.pf ? 1 : 0,
      width: it.width,
      height: it.height,
      dir: path.dirname(it.path),
      parsed: it.kind === 'video' ? (it.parsed ||= parseVideoName(it.path, it.root)) : undefined,
      meta: it.meta,
      fetched: it.fetched ? (it.fetched.found ? 2 : 1) : 0, // 1 = looked up, nothing found; 2 = metadata applied
      saved: it.fetched?.written ? 1 : 0, // the details have been written into the file itself
    };
  }

  snapshot() {
    return {
      rev: this.rev,
      scanning: this.scanning,
      progress: this.progress,
      roots: this.roots,
      items: [...this.items.values()].map((it) => this.toClient(it)),
    };
  }

  _bump() {
    this.rev++;
  }

  scan() {
    if (this.scanning) {
      this._again = true;
      return;
    }
    this.scanning = true;
    this.progress = { done: 0, total: 0 };
    this._bump();
    (async () => {
      try {
        do {
          this._again = false;
          await this._scanOnce();
        } while (this._again);
      } catch (e) {
        console.error('scan failed:', e);
      } finally {
        this.scanning = false;
        this._bump();
        await this.saveNow();
      }
    })();
  }

  async _scanOnce() {
    const seen = new Set();
    const todo = [];
    const okRoots = [];
    let lastBump = Date.now();
    for (const root of this.roots.slice()) {
      let ok = true;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let ents;
        try {
          ents = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          if (sameDir(dir, root)) ok = false;
          continue;
        }
        const art = findFolderArt(dir, ents);
        const files = [];
        for (const e of ents) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.test(e.name)) stack.push(path.join(dir, e.name));
          } else if (e.isFile()) {
            const ext = path.extname(e.name).slice(1).toLowerCase();
            const kind = kindOf(ext);
            if (kind) files.push({ name: e.name, ext, kind });
          }
        }
        const hasAudio = files.some((f) => f.kind === 'audio');
        for (let i = 0; i < files.length; i += 32) {
          await Promise.all(
            files.slice(i, i + 32).map(async (f) => {
              if (f.kind === 'image' && hasAudio && ART_RE.test(path.basename(f.name, path.extname(f.name)))) return;
              const full = path.join(dir, f.name);
              let st;
              try {
                st = await fsp.stat(full);
              } catch {
                return;
              }
              const id = idFor(full);
              seen.add(id);
              let it = this.items.get(id);
              if (it && it.size === st.size && it.mtime === Math.round(st.mtimeMs)) {
                it.root = root;
                it.folderArt = f.kind === 'audio' ? art : null;
                return;
              }
              if (it) this._dropCover(it);
              it = { id, path: full, root, kind: f.kind, ext: f.ext, size: st.size, mtime: Math.round(st.mtimeMs), added: it ? it.added : Date.now() };
              it.folderArt = f.kind === 'audio' ? art : null;
              guessFromPath(it);
              this.items.set(id, it);
              if (f.kind !== 'image') todo.push(it);
            }),
          );
        }
        if (Date.now() - lastBump > 1200) {
          lastBump = Date.now();
          this.progress = { done: 0, total: seen.size };
          this._bump();
        }
      }
      if (ok) okRoots.push(root);
    }
    // Only prune roots we could actually read, so an unplugged drive doesn't wipe its library.
    for (const [id, it] of this.items) {
      if (!seen.has(id) && okRoots.some((r) => sameDir(r, it.root))) {
        this._dropCover(it);
        this.items.delete(id);
      }
    }
    this.progress = { done: 0, total: todo.length };
    this._bump();

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        const tags = await readTags(it.path, it.ext);
        Object.assign(it, tags);
        this.progress.done++;
        if (Date.now() - lastBump > 1200) {
          lastBump = Date.now();
          this._bump();
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  /** Forget the item's cover files. The returned promise settles once they're deleted (callers may ignore it). */
  _dropCover(it) {
    const gone = [];
    if (it.cf) gone.push(fsp.unlink(path.join(this.coverDir, `${it.id}.${it.cf}`)).catch(() => {}));
    if (it.pf) gone.push(fsp.unlink(path.join(this.coverDir, `${it.id}.poster.${it.pf}`)).catch(() => {}));
    it.cf = it.pf = undefined;
    return Promise.all(gone);
  }

  // ------------------------------------------------------- fetched metadata

  async _writeImage(it, image, poster) {
    const ext = IMAGE_EXT[image.mime] || 'jpg';
    if (poster) {
      if (it.pf) await fsp.unlink(path.join(this.coverDir, `${it.id}.poster.${it.pf}`)).catch(() => {});
      await fsp.writeFile(path.join(this.coverDir, `${it.id}.poster.${ext}`), image.data);
      it.pf = ext;
    } else {
      if (it.cf) await fsp.unlink(path.join(this.coverDir, `${it.id}.${it.cf}`)).catch(() => {});
      await fsp.writeFile(path.join(this.coverDir, `${it.id}.${ext}`), image.data);
      it.cf = ext;
    }
    it.cv = (it.cv || 0) + 1;
  }

  _touch() {
    this._bump();
    this.save();
  }

  /** Album art goes on the first track (the shelf uses the first track that has any); year/genre only fill gaps. */
  async applyAlbum(ids, { year, genre, image, src }) {
    const items = ids.map((id) => this.items.get(id)).filter(Boolean);
    if (!items.length) return false;
    if (image) await this._writeImage(items[0], image, false);
    for (const it of items) {
      const filled = [];
      if (year && !it.year) { it.year = year; filled.push('year'); }
      if (genre && !it.genre) { it.genre = genre; filled.push('genre'); }
      // `art` points at the track that holds the picture, so any track can find it later (e.g. to save it into its file).
      it.fetched = { src, at: Date.now(), found: !!image, filled, art: items[0].id };
    }
    this._touch();
    return true;
  }

  async applyMovie(id, { meta, image, src }) {
    const it = this.items.get(id);
    if (!it) return false;
    if (image) await this._writeImage(it, image, true);
    it.meta = { ...meta, src };
    it.fetched = { src, at: Date.now(), found: true };
    this._touch();
    return true;
  }

  /** `episodes` is [{ id, season, episode }]; `epInfo` maps "SxE" to that episode's details. The poster is stored once, on the first. */
  async applyShow(episodes, { show, image, epInfo, src }) {
    const rows = episodes.map((e) => ({ e, it: this.items.get(e.id) })).filter((r) => r.it);
    if (!rows.length) return false;
    if (image) await this._writeImage(rows[0].it, image, true);
    for (const { e, it } of rows) {
      const info = epInfo && epInfo.get(`${e.season}x${e.episode}`);
      it.meta = { src, show, ...(info ? { epTitle: info.title, epSummary: info.summary, airdate: info.airdate, runtime: info.runtime } : {}) };
      it.fetched = { src, at: Date.now(), found: true };
    }
    this._touch();
    return true;
  }

  /** Remember a lookup that found nothing, so bulk runs don't keep retrying it. */
  markTried(ids) {
    for (const id of ids) {
      const it = this.items.get(id);
      if (it && !it.fetched) it.fetched = { src: null, at: Date.now(), found: false };
    }
    this._touch();
  }

  /** Undo fetched data: poster, metadata, art, and any year/genre we filled in. Tags and files are untouched. */
  async clearFetched(ids) {
    const gone = [];
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      for (const key of it.fetched?.filled || []) it[key] = undefined;
      if (it.pf || it.fetched?.found) gone.push(this._dropCover(it));
      it.meta = it.fetched = undefined;
      it.cv = (it.cv || 0) + 1;
    }
    await Promise.all(gone);
    this._touch();
  }

  /** Client-generated thumbnail (video frame / downscaled photo) plus any metadata it learned. */
  async setThumb(id, data, meta = {}) {
    const it = this.items.get(id);
    if (!it) return false;
    if (data && data.length) {
      await fsp.writeFile(path.join(this.coverDir, `${id}.jpg`), data);
      it.cf = 'jpg';
      it.cv = (it.cv || 0) + 1;
    }
    for (const k of ['duration', 'width', 'height']) if (Number.isFinite(meta[k]) && meta[k] > 0) it[k] = meta[k];
    this._bump();
    this.save();
    return true;
  }

  setMeta(id, meta) {
    return this.setThumb(id, null, meta);
  }

  /** Resolves to `{ file, mime }` for the best available cover, extracting embedded art on first use. */
  async cover(id) {
    const it = this.items.get(id);
    if (!it) return null;
    const mimes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    if (it.pf) {
      const file = path.join(this.coverDir, `${id}.poster.${it.pf}`);
      if (fs.existsSync(file)) return { file, mime: mimes[it.pf] };
      it.pf = undefined;
    }
    if (it.cf) {
      const file = path.join(this.coverDir, `${id}.${it.cf}`);
      if (fs.existsSync(file)) return { file, mime: mimes[it.cf] };
      it.cf = undefined;
    }
    if (it.hasPic) {
      const pic = await readPicture(it.path, it.ext);
      if (pic) {
        const ext = pic.mime === 'image/png' ? 'png' : pic.mime === 'image/webp' ? 'webp' : pic.mime === 'image/gif' ? 'gif' : 'jpg';
        const file = path.join(this.coverDir, `${id}.${ext}`);
        await fsp.writeFile(file, pic.data);
        it.cf = ext;
        this.save();
        return { file, mime: mimes[ext] };
      }
      it.hasPic = false;
    }
    if (it.folderArt && fs.existsSync(it.folderArt)) {
      const ext = path.extname(it.folderArt).slice(1).toLowerCase();
      return { file: it.folderArt, mime: mimes[ext === 'jpeg' ? 'jpg' : ext] || 'image/jpeg' };
    }
    return null;
  }

  get(id) {
    return this.items.get(id);
  }
}

module.exports = { Library, kindOf, EXT };

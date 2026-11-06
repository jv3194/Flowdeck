'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');
const { version } = require('../package.json');
const { Library, kindOf } = require('./library');
const { createProviders } = require('./providers');
const { Enricher, cleanTargets } = require('./enrich');
const { SongIdentifier } = require('./songs');
const { WriteBack } = require('./writeback');
const subtitles = require('./subtitles');
const { mkvTracks, mkvCues, mkvStreams } = require('./mkv');
const { Ffmpeg } = require('./ffmpeg');
const transcode = require('./transcode');
const { Tidy, migratePrefs } = require('./tidy');

const SUB_FILE_MAX = 8 * 1024 * 1024;
const CODEC_EXT = { 'TEXT/UTF8': 'srt', 'TEXT/ASS': 'ass', 'TEXT/SSA': 'ssa', 'TEXT/WEBVTT': 'vtt' };

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  // Chromium only plays Matroska when it's served as webm.
  mkv: 'video/webm',
};
const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? MIME.json : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Streams a file with HTTP Range support, which <audio>/<video> need for seeking. */
async function serveFile(req, res, file, mime, extra = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!st.isFile()) return send(res, 404, 'Not found');
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && st.size > 0) {
    if (range[1] === '' && range[2] === '') return send(res, 416, 'Bad range', { 'Content-Range': `bytes */${st.size}` });
    if (range[1] === '') {
      start = Math.max(0, st.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= st.size) return send(res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${st.size}` });
    status = 206;
  }
  const headers = {
    'Content-Type': mime,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ...extra,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  pipeline(stream, res, () => {});
}

// ---------------------------------------------------------------- folder browser

const WIN_JUNK = /^(\$recycle\.bin|system volume information|\$winreagent|recovery|config\.msi)$/i;

async function listRoots() {
  const home = os.homedir();
  const shortcuts = [];
  for (const n of ['Music', 'Videos', 'Movies', 'Pictures', 'Downloads', 'Desktop', 'Documents']) {
    const p = path.join(home, n);
    if (fs.existsSync(p)) shortcuts.push({ name: n, path: p });
  }
  const drives = [];
  if (process.platform === 'win32') {
    await Promise.all(
      'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map(async (l) => {
        try {
          await fsp.access(`${l}:\\`);
          drives.push({ name: `${l}:`, path: `${l}:\\` });
        } catch {
          /* not mounted */
        }
      }),
    );
    drives.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    drives.push({ name: 'File system', path: '/' });
  }
  return { path: '', parent: null, name: 'This computer', shortcuts, drives, dirs: [], counts: null };
}

async function listDir(p) {
  if (!p) return listRoots();
  const abs = path.resolve(p);
  let ents;
  try {
    ents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'Folder not found' : 'Cannot open this folder', path: abs };
  }
  const dirs = [];
  const counts = { audio: 0, video: 0, image: 0 };
  for (const e of ents) {
    if (e.name.startsWith('.') || WIN_JUNK.test(e.name)) continue;
    const full = path.join(abs, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(full)).isDirectory();
      } catch {
        /* broken link */
      }
    }
    if (isDir) dirs.push({ name: e.name, path: full });
    else if (e.isFile()) {
      const kind = kindOf(path.extname(e.name).slice(1).toLowerCase());
      if (kind) counts[kind]++;
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, name: path.basename(abs) || abs, dirs, counts };
}

// ---------------------------------------------------------------- prefs

function mergePrefs(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue; // JSON.parse makes "__proto__" an own key
    if (v === null) delete base[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) mergePrefs(base[k], v);
    else base[k] = v;
  }
  return base;
}

// ---------------------------------------------------------------- server

async function startServer({ port = 0, dataDir, webDir, providers, ffmpeg }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lib = new Library(dataDir);
  await lib.load();
  ffmpeg = ffmpeg || new Ffmpeg({ dataDir }); // nothing is created on disk until ffmpeg is downloaded

  // The TMDB key (for movie lookups) lives in its own file, and is never sent back to the page.
  const keyFile = path.join(dataDir, 'tmdb.key');
  let tmdbKey = '';
  try {
    tmdbKey = (await fsp.readFile(keyFile, 'utf8')).trim();
  } catch {
    /* no key saved */
  }
  const getTmdbKey = () => tmdbKey || process.env.TMDB_API_KEY || '';
  providers = providers || createProviders({ getTmdbKey });
  const writeback = new WriteBack(lib, dataDir);
  const enricher = new Enricher(lib, providers, writeback);
  const songs = new SongIdentifier(lib, providers, writeback);
  const libraryPayload = () => ({ ...lib.snapshot(), fetch: enricher.state, tmdb: !!getTmdbKey(), version });

  // ---- subtitles
  const subsDir = path.join(dataDir, 'subs');
  fs.mkdirSync(subsDir, { recursive: true });
  const embeddedTracks = new Map(); // video id -> { mtime, tracks }: parsing a file's track list is cheap but not free
  const extracting = new Map(); // cache file -> in-flight extraction, so two requests share one scan

  /** Every subtitle source for a video. Sidecars are re-listed each time so a file dropped in next to the video shows up. */
  async function subtitleSources(it) {
    let embedded = embeddedTracks.get(it.id);
    if (!embedded || embedded.mtime !== it.mtime) {
      embedded = { mtime: it.mtime, tracks: /\.(mkv|webm)$/i.test(it.path) ? await mkvTracks(it.path) : [] };
      embeddedTracks.set(it.id, embedded);
    }
    const files = (await subtitles.findSidecars(it.path)).map((s, i) => ({
      key: `f${i}`, kind: 'file', ext: s.ext, lang: s.lang, forced: s.forced, sdh: s.sdh, name: s.name, supported: true, file: s.file,
    }));
    const inside = embedded.tracks.map((t) => ({
      key: `e${t.number}`, kind: 'embedded', ext: CODEC_EXT[t.codec] || t.codec.split('/').pop().toLowerCase(), lang: t.lang,
      forced: t.forced, sdh: /\b(sdh|cc|hearing)\b/i.test(t.name), name: t.name, supported: t.supported, number: t.number,
    }));
    return [...files, ...inside];
  }

  async function subtitleCues(it, src) {
    if (src.kind === 'file') {
      if ((await fsp.stat(src.file)).size > SUB_FILE_MAX) throw Object.assign(new Error('Subtitle file is too large'), { status: 413 });
      return subtitles.parseSubtitle(await fsp.readFile(src.file), src.ext, src.lang);
    }
    // Pulling text out of a big video means scanning it, so the result is kept on disk (keyed by the file's mtime).
    const cache = path.join(subsDir, `${it.id}.${src.number}.${it.mtime}.json`);
    try {
      return JSON.parse(await fsp.readFile(cache, 'utf8'));
    } catch {
      /* not cached yet */
    }
    if (!extracting.has(cache)) {
      extracting.set(cache, (async () => {
        const cues = await mkvCues(it.path, src.number);
        for (const old of await fsp.readdir(subsDir).catch(() => [])) if (old.startsWith(`${it.id}.${src.number}.`) && old !== path.basename(cache)) fsp.unlink(path.join(subsDir, old)).catch(() => {});
        await fsp.writeFile(cache, JSON.stringify(cues)).catch(() => {});
        return cues;
      })().finally(() => extracting.delete(cache)));
    }
    return extracting.get(cache);
  }

  // ---- playing videos the browser can't decode (see transcode.js, ffmpeg.js)
  /** What a video contains: from ffprobe when ffmpeg is there, else from a Matroska file's own headers, else unknown (null). */
  async function videoInfo(it) {
    if (await ffmpeg.locate()) {
      try {
        return await ffmpeg.probe(it.path);
      } catch {
        /* fall back to the headers */
      }
    }
    return /\.(mkv|webm)$/i.test(it.path) ? transcode.fromMatroska(await mkvStreams(it.path)) : null;
  }

  async function playPlan(it, url) {
    const caps = transcode.parseCaps(url.searchParams.get('caps'));
    const force = url.searchParams.get('force') === '1';
    const pick = url.searchParams.get('audio'); // the ordinal of the sound track the viewer chose, if any
    const audio = pick != null && /^\d{1,2}$/.test(pick) ? Number(pick) : null;
    // A file nobody could read still converts when forced: assume one ordinary video and one sound track, so the only
    // reason given is that it wouldn't play (not made-up codec names).
    const info = (await videoInfo(it)) || (force ? { duration: it.duration || 0, video: { codec: 'h264', bitDepth: 8, chroma: '420', height: 0 }, audio: [{ codec: 'aac', channels: 2, isDefault: true, ordinal: 0 }] } : { duration: 0, video: null, audio: [] });
    return transcode.decide(info, caps, { force, audio });
  }

  const prefsFile = path.join(dataDir, 'prefs.json');
  let prefs = {};
  try {
    prefs = JSON.parse(await fsp.readFile(prefsFile, 'utf8'));
  } catch {
    /* defaults */
  }
  let prefsTimer = null;
  const savePrefs = () => {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => fsp.writeFile(prefsFile, JSON.stringify(prefs)).catch(() => {}), 500);
  };

  // ---- tidy folder names (see tidy.js): renaming folders changes every file id inside them, so what is keyed by an id follows
  const tidy = new Tidy({
    lib,
    dataDir,
    busy: () => (enricher.state.active ? 'Wait for the artwork lookup to finish first' : songs.snapshot().active ? 'Wait for the song lookup to finish first' : ''),
    migrate: async (idMap) => {
      migratePrefs(prefs, idMap);
      savePrefs();
      for (const f of await fsp.readdir(subsDir).catch(() => [])) { // cached subtitles are named <id>.<track>.<mtime>.json
        const dot = f.indexOf('.');
        const to = dot > 0 ? idMap.get(f.slice(0, dot)) : null;
        if (to) await fsp.rename(path.join(subsDir, f), path.join(subsDir, to + f.slice(dot))).catch(() => {});
      }
      for (const old of idMap.keys()) embeddedTracks.delete(old);
    },
  });

  let boundPort = port;
  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);

  // Everything here is local-only. Rejecting unexpected Host/Origin headers stops DNS-rebinding
  // and cross-site requests from a web page the user happens to have open.
  function guard(req) {
    if (!allowedHosts().has(req.headers.host || '')) return false;
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) return false;
    return true;
  }

  async function api(req, res, url) {
    const route = url.pathname;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && !/^(application\/json|image\/)/.test(req.headers['content-type'] || '')) {
      return send(res, 415, { error: 'Unsupported content type' });
    }
    if (route === '/api/library' && method === 'GET') {
      const status = { rev: lib.rev, scanning: lib.scanning, progress: lib.progress, fetch: enricher.state, tmdb: !!getTmdbKey() };
      if (Number(url.searchParams.get('rev')) === lib.rev) return send(res, 200, { ...status, unchanged: true });
      // `lite`: just the progress, without the whole library. A scan changes the library every second or so, and
      // sending every item each time (megabytes, for a big collection) is wasted work for what is only a progress bar.
      if (url.searchParams.get('lite') === '1') return send(res, 200, { ...status, lite: true });
      return send(res, 200, libraryPayload());
    }
    if (/^\/api\/meta\/(fetch|clear|candidates|apply|key|write|undo)$/.test(route) && method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 << 20)).toString() || '{}');
      const fail = (e) => send(res, e.code === 'NO_KEY' || e.code === 'BAD_KEY' ? 400 : 502, { error: e.message, code: e.code });
      const ids = Array.isArray(body.ids) ? body.ids.filter((i) => /^[0-9a-f]{8,32}$/.test(i)) : [];
      const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
      const year = Number(body.year) || undefined;

      if (route === '/api/meta/fetch') return send(res, 200, { ok: true, queued: enricher.enqueue(cleanTargets(body.targets), { force: !!body.force, write: !!body.write }) });
      // Save fetched details into the files (pending = everything fetched but not yet saved), or undo that for some tracks.
      if (route === '/api/meta/write') return send(res, 200, { ok: true, ...(await writeback.tracks(body.pending ? writeback.pending() : ids, { force: !body.pending })) });
      if (route === '/api/meta/undo') return send(res, 200, { ok: true, ...(await writeback.undo(ids)) });
      if (route === '/api/meta/clear') {
        await lib.clearFetched(ids);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/meta/candidates') {
        const q = body.type === 'album' ? { artist: text(body.artist), album: text(body.album), trackCount: Number(body.trackCount) || 0 } : body.type === 'show' ? { name: text(body.name), year } : { title: text(body.title), year };
        try {
          return send(res, 200, { candidates: await enricher.candidates(body.type, q) });
        } catch (e) {
          return fail(e);
        }
      }
      if (route === '/api/meta/apply') {
        const ref = body.ref && typeof body.ref === 'object' ? body.ref : null;
        if (!ref || typeof ref.provider !== 'string') return send(res, 400, { error: 'Missing reference' });
        const episodes = (Array.isArray(body.episodes) ? body.episodes : []).filter((e) => /^[0-9a-f]{8,32}$/.test(e?.id)).map((e) => ({ id: e.id, season: Number(e.season) || 0, episode: Number(e.episode) || 0 }));
        try {
          return send(res, 200, { ok: true, ...(await enricher.apply({ type: body.type, ref, ids, episodes, write: !!body.write })) });
        } catch (e) {
          return fail(e);
        }
      }
      if (route === '/api/meta/key') {
        const key = text(body.key).trim();
        if (key) {
          try {
            if (!(await providers.testTmdbKey(key))) return send(res, 400, { error: 'TMDB rejected that key', code: 'BAD_KEY' });
          } catch (e) {
            return fail(e);
          }
        }
        tmdbKey = key;
        if (key) await fsp.writeFile(keyFile, key, { mode: 0o600 });
        else await fsp.rm(keyFile, { force: true });
        return send(res, 200, { ok: true, tmdb: !!getTmdbKey() });
      }
    }
    // Per-song identification: look songs up (a job the page polls), then save the proposals the user approved.
    if (route === '/api/songs' && method === 'GET') return send(res, 200, songs.snapshot());
    if (/^\/api\/songs\/(identify|cancel|apply)$/.test(route) && method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 << 20)).toString() || '{}');
      if (route === '/api/songs/cancel') {
        songs.cancel();
        return send(res, 200, { ok: true });
      }
      if (route === '/api/songs/identify') {
        const ids = Array.isArray(body.ids) ? body.ids.filter((i) => /^[0-9a-f]{8,32}$/.test(i)).slice(0, 5000) : [];
        return send(res, 200, { ok: true, queued: songs.start(ids) });
      }
      try {
        return send(res, 200, { ok: true, ...(await songs.apply(body.changes)) });
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }
    // Tidy folder names: a plan (changes nothing), applying the approved parts of it, and undoing a batch.
    if (route === '/api/tidy/undo' && method === 'GET') return send(res, 200, { batches: await tidy.history() });
    if (/^\/api\/tidy\/(plan|apply|undo)$/.test(route) && method === 'POST') {
      const body = JSON.parse((await readBody(req, 4 << 20)).toString() || '{}');
      try {
        if (route === '/api/tidy/plan') return send(res, 200, { plans: await tidy.plan(body.targets) });
        if (route === '/api/tidy/apply') return send(res, 200, { ok: true, ...(await tidy.apply(body.targets)) });
        return send(res, 200, { ok: true, ...(await tidy.undo(String(body.id || ''))) });
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }
    if (route === '/api/ffmpeg' && method === 'GET') return send(res, 200, await ffmpeg.status());
    if (route === '/api/ffmpeg/install' && method === 'POST') {
      try {
        await ffmpeg.install();
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      return send(res, 200, await ffmpeg.status());
    }
    if (route === '/api/ffmpeg/remove' && method === 'POST') {
      await ffmpeg.remove();
      return send(res, 200, await ffmpeg.status());
    }
    const play = /^\/api\/play\/([0-9a-f]{8,32})$/.exec(route);
    if (play && method === 'GET') {
      const it = lib.get(play[1]);
      if (!it || it.kind !== 'video') return send(res, 404, { error: 'Not a video' });
      const plan = await playPlan(it, url);
      return send(res, 200, {
        mode: plan.mode, switched: plan.switched, hasVideo: plan.hasVideo, reasons: plan.reasons, description: plan.mode === 'direct' ? '' : transcode.describe(plan),
        duration: plan.duration || it.duration || 0, ffmpeg: await ffmpeg.status(),
      });
    }
    // The sound tracks a video has (languages, formats), for the player's audio picker. Empty when they can't be read.
    const audioRoute = /^\/api\/audio\/([0-9a-f]{8,32})$/.exec(route);
    if (audioRoute && method === 'GET') {
      const it = lib.get(audioRoute[1]);
      if (!it || it.kind !== 'video') return send(res, 404, { error: 'Not a video' });
      const tracks = transcode.audioList(await videoInfo(it).catch(() => null)).map(({ rawLang, ...t }) => ({ ...t, lang: subtitles.normalizeLang(rawLang) }));
      return send(res, 200, { tracks });
    }
    if (route === '/api/prefs') {
      if (method === 'GET') return send(res, 200, prefs);
      if (method === 'PUT') {
        mergePrefs(prefs, JSON.parse((await readBody(req, 1 << 20)).toString() || '{}'));
        savePrefs();
        return send(res, 200, { ok: true });
      }
    }
    const subs = /^\/api\/subs\/([0-9a-f]{8,32})(?:\/([fe]\d{1,5}))?$/.exec(route);
    if (subs && method === 'GET') {
      const it = lib.get(subs[1]);
      if (!it || it.kind !== 'video') return send(res, 404, { error: 'Not a video' });
      const sources = await subtitleSources(it);
      // The page only ever names a track key; file paths stay on the server.
      if (!subs[2]) return send(res, 200, { tracks: sources.map(({ file, number, ...track }) => track) });
      const src = sources.find((s) => s.key === subs[2]);
      if (!src || !src.supported) return send(res, 404, { error: 'No such subtitle track' });
      return send(res, 200, { cues: await subtitleCues(it, src) });
    }
    if (route === '/api/fs' && method === 'GET') return send(res, 200, await listDir(url.searchParams.get('path') || ''));
    if (route === '/api/roots') {
      const body = JSON.parse((await readBody(req, 1 << 16)).toString() || '{}');
      if (method === 'POST') {
        try {
          return send(res, 200, { ok: true, path: await lib.addRoot(String(body.path || ''), body.photos === true) });
        } catch (e) {
          return send(res, 400, { error: e.code === 'ENOENT' ? 'Folder not found' : e.message });
        }
      }
      if (method === 'DELETE') {
        lib.removeRoot(String(body.path || ''), body.photos === true);
        return send(res, 200, { ok: true });
      }
    }
    if (route === '/api/scan' && method === 'POST') {
      lib.scan();
      return send(res, 200, { ok: true });
    }
    const meta = /^\/api\/meta\/([0-9a-f]+)$/.exec(route);
    if (meta && method === 'POST') {
      const ok = await lib.setMeta(meta[1], JSON.parse((await readBody(req, 1 << 16)).toString() || '{}'));
      return send(res, ok ? 200 : 404, { ok });
    }
    return send(res, 404, { error: 'Unknown endpoint' });
  }

  async function handle(req, res) {
    if (!guard(req)) return send(res, 403, 'Forbidden');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    const url = new URL(req.url, 'http://local');
    url.pathname = pathname;
    if (pathname.startsWith('/api/')) return api(req, res, url);

    const media = /^\/media\/([0-9a-f]+)$/.exec(pathname);
    if (media) {
      const it = lib.get(media[1]);
      return it ? serveFile(req, res, it.path, mimeOf(it.path), { 'Cache-Control': 'no-cache' }) : send(res, 404, 'Not found');
    }

    // A video converted on the fly: ?t= is where to start (the page restarts the stream to seek), ?caps= what the page can decode.
    const convert = /^\/convert\/([0-9a-f]{8,32})$/.exec(pathname);
    if (convert && req.method === 'GET') {
      const it = lib.get(convert[1]);
      if (!it || it.kind !== 'video') return send(res, 404, 'Not found');
      const plan = await playPlan(it, url);
      const t = Number(url.searchParams.get('t'));
      const start = Number.isFinite(t) && t > 0 ? Math.min(t, Math.max(0, (plan.duration || it.duration || Infinity) - 1)) : 0;
      return ffmpeg.stream(it.path, plan, start, res);
    }

    const cover = /^\/cover\/([0-9a-f]+)$/.exec(pathname);
    if (cover) {
      if (req.method === 'PUT') {
        const ok = await lib.setThumb(cover[1], await readBody(req, 4 << 20), {
          duration: Number(url.searchParams.get('duration')),
          width: Number(url.searchParams.get('width')),
          height: Number(url.searchParams.get('height')),
          size: Number(url.searchParams.get('size')),
        });
        return send(res, ok ? 200 : 404, { ok });
      }
      const c = await lib.cover(cover[1]);
      return c ? serveFile(req, res, c.file, c.mime, { 'Cache-Control': 'private, max-age=3600' }) : send(res, 404, 'No cover');
    }

    // Static UI
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(webDir, rel));
    if (!file.startsWith(webDir + path.sep) && file !== webDir) return send(res, 403, 'Forbidden');
    return serveFile(req, res, file, mimeOf(file), { 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    });
  });

  // Try the preferred port, then walk upward, then let the OS choose.
  const listen = (p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  let attempt = port;
  for (let i = 0; ; i++) {
    try {
      await listen(attempt);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      attempt = port && i < 20 ? attempt + 1 : 0;
    }
  }
  boundPort = server.address().port;

  lib.watch(); // and keep it fresh: changes to the folders trigger a rescan
  lib.scan(); // refresh in the background so the UI shows the cached library immediately

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    lib,
    close: async () => {
      ffmpeg.shutdown(); // stop any conversion and download, or the server can't finish closing
      lib.close(); // stop watching folders
      await lib.saveNow();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startServer };

if (require.main === module) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
  };
  const dataDir = path.resolve(arg('data', process.env.FLOWDECK_DATA || path.join(os.homedir(), '.flowdeck')));
  startServer({ port: Number(arg('port', 4173)), dataDir, webDir: path.join(__dirname, '..', 'web') })
    .then((s) => {
      console.log(`Flowdeck running at ${s.url}`);
      console.log(`Library data: ${dataDir}`);
      if (process.argv.includes('--open')) {
        const cmd = process.platform === 'win32' ? `start "" "${s.url}"` : process.platform === 'darwin' ? `open "${s.url}"` : `xdg-open "${s.url}"`;
        require('child_process').exec(cmd);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

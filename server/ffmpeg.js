'use strict';
// ffmpeg for converting videos the player can't decode: finding it, asking it about a file, streaming a
// conversion to the page, and (on Windows) downloading it once with the user's say-so.
//
// Flowdeck never bundles ffmpeg. It uses, in order: a folder named by FLOWDECK_FFMPEG, its own copy in
// <data>/ffmpeg/bin, then whatever is on the PATH.
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { fromFfprobe, buildArgs } = require('./transcode');
const { listZip, extractEntry } = require('./zip');

// The one place a download may come from: gyan.dev's "essentials" Windows build, which includes ffprobe and libx264.
// Its checksum comes from the same site, over HTTPS, and a mismatch throws the download away.
const SOURCE = {
  zip: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  sha: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256',
  hosts: new Set(['www.gyan.dev', 'gyan.dev', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']),
  maxBytes: 400 * 1024 * 1024,
  approxMB: 115,
};
const MAX_STREAMS = 3; // a seek starts a new conversion while the old one is being cancelled; more than this means something is wrong
const BUSY = new Set(['downloading', 'verifying', 'extracting']);

class Ffmpeg {
  constructor({ dataDir, spawn = cp.spawn, execFile = cp.execFile, fetch = globalThis.fetch, platform = process.platform, env = process.env, source = SOURCE } = {}) {
    this.dir = path.join(dataDir, 'ffmpeg');
    this.binDir = path.join(this.dir, 'bin');
    this.spawn = spawn;
    this.execFile = execFile;
    this.fetch = fetch;
    this.platform = platform;
    this.env = env;
    this.source = source;
    this.ext = platform === 'win32' ? '.exe' : '';
    this.found = null;
    this.missAt = 0;
    this.job = null;
    this.abort = null;
    this.streams = new Set();
    this.probes = new Map();
    this.zscale = undefined;
  }

  _exec(bin, args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      this.execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
  }

  async _version(bin) {
    try {
      return /version\s+(\S+)/.exec(await this._exec(bin, ['-version'], 8000))?.[1] || '';
    } catch {
      return '';
    }
  }

  /** { ffmpeg, ffprobe, source, version } for the copy that will be used, or null. */
  async locate() {
    if (this.found) return this.found;
    if (this.missAt && Date.now() - this.missAt < 15000) return null;
    const folders = [];
    if (this.env.FLOWDECK_FFMPEG) folders.push({ dir: this.env.FLOWDECK_FFMPEG, source: 'folder' });
    folders.push({ dir: this.binDir, source: 'flowdeck' });
    for (const { dir, source } of folders) {
      const ffmpeg = path.join(dir, `ffmpeg${this.ext}`);
      const ffprobe = path.join(dir, `ffprobe${this.ext}`);
      if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) continue;
      const version = await this._version(ffmpeg);
      if (version) return (this.found = { ffmpeg, ffprobe, source, version });
    }
    const version = await this._version('ffmpeg');
    if (version && (await this._version('ffprobe'))) return (this.found = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'path', version });
    this.missAt = Date.now();
    return null;
  }

  /** { state: 'ready' | 'missing' | 'busy' | 'error', ... } for the setup screen. */
  async status() {
    if (this.job && BUSY.has(this.job.state)) return { state: 'busy', phase: this.job.state, done: this.job.done, total: this.job.total, approxMB: this.source.approxMB };
    const f = await this.locate();
    if (f) return { state: 'ready', version: f.version, source: f.source, canRemove: f.source === 'flowdeck' };
    return {
      state: this.job?.state === 'error' ? 'error' : 'missing',
      error: this.job?.error || '', canInstall: this.platform === 'win32', approxMB: this.source.approxMB,
    };
  }

  /** What a file contains, in the shape transcode.decide() wants. Cached per file version. */
  async probe(file) {
    const f = await this.locate();
    if (!f) throw new Error('ffmpeg is not installed');
    const st = await fsp.stat(file);
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (this.probes.has(key)) return this.probes.get(key);
    const out = await this._exec(f.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 25000);
    const info = fromFfprobe(JSON.parse(out));
    // HDR in a Matroska file is often only labelled inside the picture itself. For 10-bit video whose stream header
    // doesn't say how it is encoded, look at the first frame too.
    if (info.video && !info.video.transfer && info.video.bitDepth > 8) {
      try {
        const frames = JSON.parse(await this._exec(f.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=color_transfer', '-of', 'json', file], 25000));
        const transfer = frames.frames?.[0]?.color_transfer;
        if (transfer && transfer !== 'unknown') info.video.transfer = transfer;
      } catch {
        /* leave it unknown: the picture is still converted, just not tone-mapped */
      }
    }
    if (this.probes.size > 200) this.probes.delete(this.probes.keys().next().value);
    this.probes.set(key, info);
    return info;
  }

  async hasZscale() {
    if (this.zscale !== undefined) return this.zscale;
    const f = await this.locate();
    try {
      this.zscale = f ? /\bzscale\b/.test(await this._exec(f.ffmpeg, ['-hide_banner', '-filters'], 10000)) : false;
    } catch {
      this.zscale = false;
    }
    return this.zscale;
  }

  /**
   * Convert `file` according to `plan`, from `start` seconds, into the HTTP response as a fragmented MP4.
   * Resolves when the conversion ends. Rejects (with a status) if it fails before sending anything, so the caller
   * can answer with a proper error. If the page goes away, ffmpeg is stopped.
   */
  async stream(file, plan, start, res) {
    const f = await this.locate();
    if (!f) throw Object.assign(new Error('ffmpeg is not installed'), { status: 503 });
    const args = buildArgs(plan, file, start, { zscale: plan.hdr ? await this.hasZscale() : false });
    while (this.streams.size >= MAX_STREAMS) this.stop(this.streams.values().next().value);
    const child = this.spawn(f.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.streams.add(child);
    let started = false;
    let said = '';
    child.stderr.on('data', (d) => { said = (said + d).slice(-2000); });
    const stopWhenGone = () => this.stop(child);
    res.on('close', stopWhenGone);
    return new Promise((resolve, reject) => {
      const finish = (code, spawnError) => {
        this.streams.delete(child);
        res.off('close', stopWhenGone);
        if (started) {
          res.end();
          return resolve();
        }
        const lines = said.trim().split(/\r?\n/).filter(Boolean);
        reject(Object.assign(new Error(spawnError?.message || lines.at(-1) || `ffmpeg stopped (code ${code})`), { status: 502 }));
      };
      child.stdout.on('data', (chunk) => {
        if (!started) {
          started = true;
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Content-Type-Options': 'nosniff' });
        }
        if (!res.write(chunk)) {
          child.stdout.pause();
          res.once('drain', () => child.stdout.resume());
        }
      });
      child.once('error', (e) => finish(-1, e));
      child.once('close', (code) => finish(code));
    });
  }

  stop(child) {
    this.streams.delete(child);
    try {
      if (child.exitCode === null && !child.killed) child.kill();
    } catch {
      /* already gone */
    }
  }

  // ------------------------------------------------------------- download

  /** Start downloading ffmpeg in the background; progress shows in status(). */
  async install() {
    if (this.platform !== 'win32') throw new Error('Automatic download is only for Windows. Install ffmpeg with your package manager, then restart Flowdeck.');
    if (this.job && BUSY.has(this.job.state)) return;
    const job = { state: 'downloading', done: 0, total: 0, error: '' };
    this.job = job; // claimed before anything is awaited, so a second call in the same moment sees it
    if (await this.locate()) {
      this.job = null;
      return;
    }
    this.abort = new AbortController();
    this._install(job, this.abort.signal).catch((e) => {
      job.state = 'error';
      job.error = e.name === 'AbortError' ? 'Cancelled' : e.message;
    });
  }

  /** Fetch one URL from an allowed host, following redirects only to allowed hosts. */
  async _get(url, signal, hops = 0) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !this.source.hosts.has(u.hostname)) throw new Error(`Refusing to download from ${u.hostname}`);
    const res = await this.fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Flowdeck' } });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      if (hops >= 4) throw new Error('Too many redirects');
      return this._get(new URL(next, url).href, signal, hops + 1);
    }
    if (!res.ok) throw new Error(`The download server answered ${res.status}`);
    return res;
  }

  async _install(job, signal) {
    await fsp.mkdir(this.dir, { recursive: true });
    const partial = path.join(this.dir, 'download.partial');
    const { maxBytes } = this.source;
    try {
      const sumText = await (await this._get(this.source.sha, signal)).text();
      const expected = /\b[a-f0-9]{64}\b/i.exec(sumText)?.[0]?.toLowerCase();
      if (!expected) throw new Error("Couldn't read the download's published checksum");

      const res = await this._get(this.source.zip, signal);
      job.total = Number(res.headers.get('content-length')) || 0;
      if (job.total > maxBytes) throw new Error('The download is larger than expected');
      const hash = crypto.createHash('sha256');
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (src) {
          for await (const chunk of src) {
            job.done += chunk.length;
            if (job.done > maxBytes) throw new Error('The download is larger than expected');
            hash.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(partial),
        { signal },
      );

      job.state = 'verifying';
      if (hash.digest('hex') !== expected) throw new Error("The download didn't match its published checksum, so it was thrown away");

      job.state = 'extracting';
      const entries = await listZip(partial);
      await fsp.mkdir(this.binDir, { recursive: true });
      for (const name of ['ffmpeg', 'ffprobe']) {
        const entry = entries.find((e) => e.name.toLowerCase().endsWith(`/bin/${name}.exe`) || e.name.toLowerCase() === `bin/${name}.exe`);
        if (!entry) throw new Error(`${name}.exe wasn't in the download`);
        const dest = path.join(this.binDir, `${name}${this.ext}`);
        await extractEntry(partial, entry, `${dest}.new`);
        await fsp.rename(`${dest}.new`, dest);
      }
      this.found = null;
      this.missAt = 0;
      this.zscale = undefined;
      if (!(await this.locate())) {
        await fsp.rm(this.binDir, { recursive: true, force: true });
        throw new Error("The downloaded ffmpeg wouldn't start on this PC");
      }
      job.state = 'done';
    } finally {
      await fsp.rm(partial, { force: true }).catch(() => {});
      await fsp.rm(path.join(this.binDir, 'ffmpeg.exe.new'), { force: true }).catch(() => {});
      await fsp.rm(path.join(this.binDir, 'ffprobe.exe.new'), { force: true }).catch(() => {});
    }
  }

  /** Delete Flowdeck's own copy (never one found on the PATH or named by FLOWDECK_FFMPEG). */
  async remove() {
    for (const c of [...this.streams]) this.stop(c);
    await fsp.rm(this.dir, { recursive: true, force: true });
    this.found = null;
    this.missAt = 0;
    this.zscale = undefined;
    this.job = null;
  }

  shutdown() {
    this.abort?.abort();
    for (const c of [...this.streams]) this.stop(c);
  }
}

module.exports = { Ffmpeg, SOURCE };

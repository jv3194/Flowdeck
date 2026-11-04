'use strict';
// Finding ffmpeg, streaming a conversion, and the download-and-verify installer, all with fakes: the suite
// never runs ffmpeg and never touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const zlib = require('zlib');
const { Ffmpeg } = require('../server/ffmpeg');
const { listZip, extractEntry } = require('../server/zip');
const { decide } = require('../server/transcode');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-ffmpeg-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = path.join(tmp, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- a zip builder (the reader's counterpart)

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const body = e.method === 0 ? data : zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.method === 0 ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.claimSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([local, name, body]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.method === 0 ? 0 : 8, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.claimSize ?? data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    locals.push(entry);
    offset += entry.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

test('zip: lists entries and extracts exact bytes, deflated or stored', async () => {
  const big = crypto.randomBytes(300000);
  const file = path.join(fresh(), 'a.zip');
  fs.writeFileSync(file, makeZip([
    { name: 'ffmpeg-7.1-essentials_build/bin/ffmpeg.exe', data: big },
    { name: 'ffmpeg-7.1-essentials_build/bin/ffprobe.exe', data: 'PROBE', method: 0 },
    { name: 'ffmpeg-7.1-essentials_build/README.txt', data: 'hi' },
  ]));
  const entries = await listZip(file);
  assert.deepEqual(entries.map((e) => e.name), ['ffmpeg-7.1-essentials_build/bin/ffmpeg.exe', 'ffmpeg-7.1-essentials_build/bin/ffprobe.exe', 'ffmpeg-7.1-essentials_build/README.txt']);
  const out = path.join(path.dirname(file), 'out.bin');
  await extractEntry(file, entries[0], out);
  assert.ok(fs.readFileSync(out).equals(big));
  await extractEntry(file, entries[1], out);
  assert.equal(fs.readFileSync(out, 'utf8'), 'PROBE');
});

test('zip: damaged, mislabelled and non-zip files are refused', async () => {
  const dir = fresh();
  const junk = path.join(dir, 'junk.zip');
  fs.writeFileSync(junk, 'this is not a zip file at all');
  await assert.rejects(listZip(junk), /Not a zip/);
  const liar = path.join(dir, 'liar.zip');
  fs.writeFileSync(liar, makeZip([{ name: 'bin/x.exe', data: Buffer.alloc(5000, 1), claimSize: 10 }]));
  const [e] = await listZip(liar);
  await assert.rejects(extractEntry(liar, e, path.join(dir, 'x')), /larger than it says/);
  const short = path.join(dir, 'short.zip');
  fs.writeFileSync(short, makeZip([{ name: 'bin/x.exe', data: Buffer.alloc(10, 1), claimSize: 5000 }]));
  const [s] = await listZip(short);
  await assert.rejects(extractEntry(short, s, path.join(dir, 'y')), /shorter than it says/);
  await assert.rejects(extractEntry(short, { ...s, method: 12 }, path.join(dir, 'z')), /Unsupported/);
});

// ---------------------------------------------------------------- fakes

const VERSION = 'ffmpeg version 7.1-test Copyright (c) the FFmpeg developers\n';
/** execFile that answers `-version` for the given binaries and fails for anything else. */
const execFor = (...bins) => {
  const calls = [];
  const fn = (bin, args, opts, cb) => {
    calls.push([bin, ...args]);
    if (bins.includes(bin) || (bins.includes('*') && fs.existsSync(bin))) cb(null, VERSION);
    else cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  };
  fn.calls = calls;
  return fn;
};
const touch = (dir, ...names) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'x');
};

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.head = null;
    this.chunks = [];
    this.ended = false;
  }
  writeHead(status, headers) { this.head = { status, headers }; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end() { this.ended = true; this.emit('close'); }
}

/** A stand-in for a spawned ffmpeg: say what it prints and how it ends. */
function fakeChild({ out = [], err = '', code = 0, hang = false, spawnError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => { child.exitCode = 1; child.stdout.end(); child.emit('close', 1); });
  };
  setImmediate(() => {
    if (spawnError) return child.emit('error', spawnError);
    if (err) child.stderr.write(err);
    for (const chunk of out) child.stdout.write(chunk);
    if (!hang) setImmediate(() => { child.exitCode = code; child.stdout.end(); child.emit('close', code); });
  });
  return child;
}

const PLAN = decide({ duration: 100, video: { codec: 'hevc', bitDepth: 10, chroma: '420', height: 1080 }, audio: [{ codec: 'eac3', channels: 6, isDefault: true, ordinal: 0 }] });

// ---------------------------------------------------------------- finding it

test('locate: a named folder first, then Flowdeck\'s own copy, then the PATH; otherwise nothing, and it does not keep asking', async () => {
  const data = fresh();
  const named = path.join(fresh(), 'tools');
  touch(named, 'ffmpeg.exe', 'ffprobe.exe');
  touch(path.join(data, 'ffmpeg', 'bin'), 'ffmpeg.exe', 'ffprobe.exe');
  const exec = execFor('*', 'ffmpeg', 'ffprobe');
  let f = await new Ffmpeg({ dataDir: data, execFile: exec, platform: 'win32', env: { FLOWDECK_FFMPEG: named } }).locate();
  assert.equal(f.source, 'folder');
  assert.equal(f.version, '7.1-test');
  f = await new Ffmpeg({ dataDir: data, execFile: exec, platform: 'win32', env: {} }).locate();
  assert.equal(f.source, 'flowdeck');

  const empty = fresh();
  f = await new Ffmpeg({ dataDir: empty, execFile: execFor('ffmpeg', 'ffprobe'), platform: 'win32', env: {} }).locate();
  assert.equal(f.source, 'path');

  const none = execFor();
  const ff = new Ffmpeg({ dataDir: fresh(), execFile: none, platform: 'win32', env: {} });
  assert.equal(await ff.locate(), null);
  const asked = none.calls.length;
  assert.equal(await ff.locate(), null);
  assert.equal(none.calls.length, asked, 'a recent "not found" is remembered');
  assert.equal(await new Ffmpeg({ dataDir: fresh(), execFile: execFor('ffmpeg'), platform: 'win32', env: {} }).locate(), null, 'ffprobe is needed too');
});

test('status: missing (with whether it can be downloaded here), ready, and the PATH copy cannot be removed by Flowdeck', async () => {
  const win = new Ffmpeg({ dataDir: fresh(), execFile: execFor(), platform: 'win32', env: {} });
  assert.deepEqual(await win.status(), { state: 'missing', error: '', canInstall: true, approxMB: 115 });
  assert.equal((await new Ffmpeg({ dataDir: fresh(), execFile: execFor(), platform: 'linux', env: {} }).status()).canInstall, false);
  const onPath = new Ffmpeg({ dataDir: fresh(), execFile: execFor('ffmpeg', 'ffprobe'), platform: 'linux', env: {} });
  assert.deepEqual(await onPath.status(), { state: 'ready', version: '7.1-test', source: 'path', canRemove: false });
});

test('probe: runs ffprobe once per file version and returns the normalised streams', async () => {
  const data = fresh();
  touch(path.join(data, 'ffmpeg', 'bin'), 'ffmpeg.exe', 'ffprobe.exe');
  const calls = [];
  const exec = (bin, args, opts, cb) => {
    calls.push(args);
    if (args[0] === '-version') return cb(null, VERSION);
    if (args.includes('-show_entries')) return cb(null, JSON.stringify({ frames: [{ color_transfer: 'smpte2084' }] })); // what the first picture says about itself
    cb(null, JSON.stringify({ format: { duration: '60' }, streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'dts', channels: 6 }] }));
  };
  const ff = new Ffmpeg({ dataDir: data, execFile: exec, platform: 'win32', env: {} });
  const movie = path.join(fresh(), 'movie.mkv');
  fs.writeFileSync(movie, 'x');
  const info = await ff.probe(movie);
  assert.equal(info.video.bitDepth, 10);
  assert.equal(info.video.transfer, 'smpte2084', 'HDR labelled only inside the picture is still noticed (10-bit with no label in the header)');
  assert.equal(info.audio[0].codec, 'dts');
  const asked = () => calls.filter((a) => a[0] !== '-version').length;
  assert.equal(asked(), 2, 'one question about the file, one about its first picture');
  await ff.probe(movie);
  assert.equal(asked(), 2, 'cached');
  assert.ok(calls.find((a) => a.includes(movie)), 'the path is passed as one argument');
  fs.writeFileSync(movie, 'a different file now');
  await ff.probe(movie);
  assert.equal(asked(), 4, 'a changed file is probed again');
});

// ---------------------------------------------------------------- streaming

function located(spawn) {
  const data = fresh();
  touch(path.join(data, 'ffmpeg', 'bin'), 'ffmpeg.exe', 'ffprobe.exe');
  return new Ffmpeg({ dataDir: data, execFile: execFor('*'), spawn, platform: 'win32', env: {} });
}

test('stream: headers wait for the first bytes, then everything is passed along and the response ends', async () => {
  const spawned = [];
  const ff = located((bin, args, opts) => { spawned.push({ bin, args, opts }); return fakeChild({ out: [Buffer.from('AAA'), Buffer.from('BBB')] }); });
  const res = new FakeRes();
  await ff.stream('C:\\v\\movie.mkv', PLAN, 42, res);
  assert.equal(res.head.status, 200);
  assert.equal(res.head.headers['Content-Type'], 'video/mp4');
  assert.equal(res.head.headers['Accept-Ranges'], 'none');
  assert.equal(Buffer.concat(res.chunks).toString(), 'AAABBB');
  assert.ok(res.ended);
  assert.ok(spawned[0].bin.endsWith('ffmpeg.exe'));
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.ok(spawned[0].args.includes('C:\\v\\movie.mkv'));
  assert.equal(spawned[0].args[spawned[0].args.indexOf('-ss') + 1], '42.000');
  assert.equal(ff.streams.size, 0);
});

test('stream: a failure before any output rejects with ffmpeg\'s own last message, and nothing has been sent', async () => {
  const ff = located(() => fakeChild({ err: 'some banner\nError opening input: Invalid data found when processing input\n', code: 1 }));
  const res = new FakeRes();
  await assert.rejects(ff.stream('x.mkv', PLAN, 0, res), (e) => e.status === 502 && /Invalid data found/.test(e.message));
  assert.equal(res.head, null);
  const gone = located(() => fakeChild({ spawnError: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }));
  await assert.rejects(gone.stream('x.mkv', PLAN, 0, new FakeRes()), /EACCES/);
  const none = new Ffmpeg({ dataDir: fresh(), execFile: execFor(), platform: 'win32', env: {} });
  await assert.rejects(none.stream('x.mkv', PLAN, 0, new FakeRes()), (e) => e.status === 503);
});

test('stream: when the page goes away (a seek, or leaving the video) ffmpeg is stopped', async () => {
  let child;
  const ff = located(() => (child = fakeChild({ out: [Buffer.from('x')], hang: true })));
  const res = new FakeRes();
  const done = ff.stream('x.mkv', PLAN, 0, res);
  await sleep(30);
  assert.equal(child.killed, false);
  res.emit('close');
  await done.catch(() => {});
  assert.equal(child.killed, true);
  assert.equal(ff.streams.size, 0);
});

test('stream: no more than a few conversions at once; the oldest is stopped first', async () => {
  const kids = [];
  const ff = located(() => { const c = fakeChild({ out: [Buffer.from('x')], hang: true }); kids.push(c); return c; });
  const jobs = [];
  for (let i = 0; i < 5; i++) { jobs.push(ff.stream('x.mkv', PLAN, i, new FakeRes()).catch(() => {})); await sleep(5); }
  await sleep(30);
  assert.deepEqual(kids.map((k) => k.killed), [true, true, false, false, false]);
  ff.shutdown();
  await Promise.all(jobs);
  assert.ok(kids.every((k) => k.killed));
});

// ---------------------------------------------------------------- installing

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SHA_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256';
const ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

/** A fetch that serves a table of URL -> () => Response, and records what was asked for. */
function fakeFetch(table) {
  const asked = [];
  const fn = async (url, init) => {
    asked.push({ url, init });
    const make = table[url];
    if (!make) return new Response('nope', { status: 404 });
    return make();
  };
  fn.asked = asked;
  return fn;
}

const goodZip = () => makeZip([
  { name: 'ffmpeg-7.1-essentials_build/bin/ffmpeg.exe', data: 'FFMPEG-BYTES' },
  { name: 'ffmpeg-7.1-essentials_build/bin/ffprobe.exe', data: 'FFPROBE-BYTES' },
  { name: '../../escape.txt', data: 'must never be written' },
]);

async function settle(ff) {
  for (let i = 0; i < 200; i++) {
    const s = await ff.status();
    if (s.state !== 'busy') return s;
    await sleep(10);
  }
  throw new Error('install never finished');
}

test('install: downloads, checks the published SHA-256, extracts only ffmpeg and ffprobe, and ends up ready', async () => {
  const zip = goodZip();
  const fetch = fakeFetch({
    [SHA_URL]: () => new Response(`${sha(zip)}\n`),
    [ZIP_URL]: () => new Response(zip, { headers: { 'content-length': String(zip.length) } }),
  });
  const data = fresh();
  const ff = new Ffmpeg({ dataDir: data, fetch, execFile: execFor('*'), platform: 'win32', env: {} });
  assert.equal((await ff.status()).state, 'missing');
  await ff.install();
  const status = await settle(ff);
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.source, 'flowdeck');
  assert.equal(status.canRemove, true);
  const bin = path.join(data, 'ffmpeg', 'bin');
  assert.equal(fs.readFileSync(path.join(bin, 'ffmpeg.exe'), 'utf8'), 'FFMPEG-BYTES');
  assert.equal(fs.readFileSync(path.join(bin, 'ffprobe.exe'), 'utf8'), 'FFPROBE-BYTES');
  assert.deepEqual(fs.readdirSync(path.join(data, 'ffmpeg')).sort(), ['bin'], 'no partial download left behind');
  assert.deepEqual(fs.readdirSync(bin).sort(), ['ffmpeg.exe', 'ffprobe.exe']);
  assert.equal(fs.existsSync(path.join(data, '..', 'escape.txt')), false, 'a hostile entry name goes nowhere');
  assert.ok(fetch.asked.every((a) => a.init.redirect === 'manual'), 'redirects are never followed blindly');

  await ff.remove();
  assert.equal(fs.existsSync(path.join(data, 'ffmpeg')), false);
  assert.equal((await new Ffmpeg({ dataDir: data, execFile: execFor(), platform: 'win32', env: {} }).status()).state, 'missing');
});

test('install: a download that does not match its published checksum is thrown away', async () => {
  const zip = goodZip();
  const fetch = fakeFetch({
    [SHA_URL]: () => new Response(`${sha(Buffer.from('something else'))}  ffmpeg-release-essentials.zip`),
    [ZIP_URL]: () => new Response(zip),
  });
  const data = fresh();
  const ff = new Ffmpeg({ dataDir: data, fetch, execFile: execFor('*'), platform: 'win32', env: {} });
  await ff.install();
  const s = await settle(ff);
  assert.equal(s.state, 'error');
  assert.match(s.error, /checksum/);
  assert.equal(fs.existsSync(path.join(data, 'ffmpeg', 'bin')), false, 'nothing from it was installed');
  assert.deepEqual(fs.readdirSync(path.join(data, 'ffmpeg')), [], 'and the file itself is gone');
});

test('install: only HTTPS from the allowed hosts, redirects included; an unreadable checksum or oversize file is refused', async () => {
  const zip = goodZip();
  const run = async (table, extra = {}) => {
    const ff = new Ffmpeg({ dataDir: fresh(), fetch: fakeFetch(table), execFile: execFor('*'), platform: 'win32', env: {}, ...extra });
    await ff.install();
    return settle(ff);
  };
  const good = { [SHA_URL]: () => new Response(sha(zip)) };

  let s = await run({ ...good, [ZIP_URL]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/ffmpeg.zip' } }) });
  assert.match(s.error, /Refusing to download from evil\.example/);
  s = await run({ ...good, [ZIP_URL]: () => new Response(null, { status: 302, headers: { location: 'http://www.gyan.dev/ffmpeg.zip' } }) });
  assert.match(s.error, /Refusing/, 'plain http is refused even on an allowed host');
  s = await run({ ...good, [ZIP_URL]: () => new Response(null, { status: 302, headers: { location: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/x.zip' } }), 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/x.zip': () => new Response(zip) });
  assert.equal(s.state, 'ready', 'a redirect to an allowed host is followed');
  s = await run({ [SHA_URL]: () => new Response('<html>not a checksum</html>'), [ZIP_URL]: () => new Response(zip) });
  assert.match(s.error, /checksum/);
  s = await run({ ...good, [ZIP_URL]: () => new Response(zip, { headers: { 'content-length': String(999 * 1024 * 1024) } }) });
  assert.match(s.error, /larger than expected/);
  s = await run({ ...good, [ZIP_URL]: () => new Response('gone', { status: 404 }) });
  assert.match(s.error, /404/);
  s = await run({ ...good, [ZIP_URL]: () => new Response(zip) }, { execFile: execFor() });
  assert.match(s.error, /wouldn't start/, 'a download that cannot run is removed, not kept');
});

test('install: only on Windows, only once at a time, and not at all when ffmpeg is already there', async () => {
  const linux = new Ffmpeg({ dataDir: fresh(), execFile: execFor(), platform: 'linux', env: {} });
  await assert.rejects(linux.install(), /only for Windows/);

  const zip = goodZip();
  const fetch = fakeFetch({ [SHA_URL]: () => new Response(sha(zip)), [ZIP_URL]: () => new Response(zip) });
  const ff = new Ffmpeg({ dataDir: fresh(), fetch, execFile: execFor('*'), platform: 'win32', env: {} });
  await Promise.all([ff.install(), ff.install()]);
  await settle(ff);
  assert.equal(fetch.asked.filter((a) => a.url === ZIP_URL).length, 1, 'one download, not two');

  const have = fakeFetch({});
  const there = new Ffmpeg({ dataDir: fresh(), fetch: have, execFile: execFor('ffmpeg', 'ffprobe'), platform: 'win32', env: {} });
  await there.install();
  assert.equal(have.asked.length, 0, 'nothing is downloaded when ffmpeg is already installed');
});

'use strict';
// The conversion endpoints, against real files in a temp library and a stand-in for ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startServer } = require('../server/index');
const { Ffmpeg } = require('../server/ffmpeg');
const { mkv, cluster, simpleBlock } = require('./helpers/mkv-builder');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-convert-http-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hvcc = (depth) => { const b = Buffer.alloc(23); b[0] = 1; b[16] = 0xfd; b[17] = 0xf8 | (depth - 8); return b; };
const media = path.join(tmp, 'media');
const put = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(media, rel)), { recursive: true });
  fs.writeFileSync(path.join(media, rel), data);
};
// 2 hours, HEVC 10-bit with E-AC-3 sound
put('Film.2022.mkv', mkv({
  duration: 7200000,
  tracks: [
    { number: 1, type: 1, codec: 'V_MPEGH/ISO/HEVC', priv: hvcc(10), video: { width: 3840, height: 2160, transfer: 16 } },
    { number: 2, type: 2, codec: 'A_EAC3', lang: 'eng', audio: { channels: 6 } },
  ],
  clusters: [cluster(0, simpleBlock(1, 0, 'v'))],
}));
// an ordinary H.264 + AAC file
put('Plain.2020.mkv', mkv({
  duration: 60000,
  tracks: [{ number: 1, type: 1, codec: 'V_MPEG4/ISO/AVC', priv: Buffer.from([1, 100, 0, 40, 0xff]), video: { width: 1280, height: 720 } }, { number: 2, type: 2, codec: 'A_AAC', audio: { channels: 2 } }],
  clusters: [cluster(0, simpleBlock(1, 0, 'v'))],
}));
put('Clip.2021.mp4', Buffer.alloc(100, 3)); // not Matroska: nothing to read without ffmpeg
put('song.mp3', Buffer.alloc(64, 2));

/** What stands in for ffmpeg: it answers the questions the server asks and records what it was told to convert. */
function stub({ ready = false } = {}) {
  const calls = { stream: [], install: 0, remove: 0 };
  return {
    calls,
    locate: async () => (ready ? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'path', version: '9.9' } : null),
    status: async () => (ready ? { state: 'ready', version: '9.9', source: 'path', canRemove: false } : { state: 'missing', error: '', canInstall: true, approxMB: 100 }),
    probe: async () => { throw new Error('should not be called when not ready'); },
    stream: async (file, plan, start, res) => {
      calls.stream.push({ file: path.basename(file), plan, start });
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end('FAKE-MP4');
    },
    install: async () => { calls.install++; },
    remove: async () => { calls.remove++; },
    shutdown() {},
  };
}

async function boot(ffmpeg) {
  const srv = await startServer({ port: 0, dataDir: path.join(tmp, `data${Math.random().toString(36).slice(2)}`), webDir: path.join(__dirname, '..', 'web'), ffmpeg });
  const api = (p, init) => fetch(srv.url + p.replace(/^\//, ''), init);
  await api('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: media }) });
  while (srv.lib.scanning) await new Promise((r) => setTimeout(r, 20));
  const idOf = (name) => [...srv.lib.items.values()].find((i) => i.path.endsWith(name)).id;
  return { srv, api, idOf };
}

test('play plan: judged from the file\'s own headers when ffmpeg is not installed', async () => {
  const { srv, api, idOf } = await boot(stub());
  try {
    let r = await (await api(`/api/play/${idOf('Film.2022.mkv')}?caps=hevc8`)).json();
    assert.equal(r.mode, 'transcode');
    assert.deepEqual(r.reasons, [{ kind: 'video', text: 'HEVC 10-bit' }, { kind: 'audio', text: 'E-AC-3 (Dolby Digital Plus)' }]);
    assert.equal(r.description, 'Converting video for playback (video HEVC 10-bit, audio E-AC-3 (Dolby Digital Plus))');
    assert.equal(r.duration, 7200);
    assert.equal(r.ffmpeg.state, 'missing');
    assert.equal(r.ffmpeg.canInstall, true);

    r = await (await api(`/api/play/${idOf('Film.2022.mkv')}?caps=hevc8,hevc10,eac3`)).json();
    assert.equal(r.mode, 'direct', 'what the page can decode is respected');
    assert.equal(r.description, '');

    r = await (await api(`/api/play/${idOf('Plain.2020.mkv')}?caps=`)).json();
    assert.equal(r.mode, 'direct');
    r = await (await api(`/api/play/${idOf('Clip.2021.mp4')}`)).json();
    assert.equal(r.mode, 'direct', 'an MP4 cannot be judged without ffmpeg, so it is tried as it is');
    r = await (await api(`/api/play/${idOf('Plain.2020.mkv')}?force=1`)).json();
    assert.equal(r.mode, 'transcode', 'force converts a file that failed although it looked fine');
    r = await (await api(`/api/play/${idOf('Clip.2021.mp4')}?force=1`)).json();
    assert.equal(r.mode, 'transcode', 'and works even for a file nothing could read');
    assert.deepEqual(r.reasons, [{ kind: 'video', text: "it wouldn't play as it is", forced: true }], 'with no invented codec names');
    assert.equal(r.description, "Converting video for playback (it wouldn't play as it is)");

    assert.equal((await api(`/api/play/${idOf('song.mp3')}`)).status, 404, 'only videos');
    assert.equal((await api('/api/play/0123456789abcdef')).status, 404);
    assert.equal((await api('/api/play/not-an-id')).status, 404);
  } finally {
    await srv.close();
  }
});

test('convert: starts the stream where asked, from a plan the server worked out itself', async () => {
  const ff = stub();
  const { srv, api, idOf } = await boot(ff);
  try {
    const film = idOf('Film.2022.mkv');
    const r = await api(`/convert/${film}?t=90.5&caps=hevc8`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'FAKE-MP4');
    const [call] = ff.calls.stream;
    assert.equal(call.file, 'Film.2022.mkv');
    assert.equal(call.start, 90.5);
    assert.equal(call.plan.mode, 'transcode');
    assert.equal(call.plan.video, 'h264');
    assert.equal(call.plan.audio, 'aac');
    assert.equal(call.plan.channels, 6);

    for (const t of ['abc', '-5', 'NaN', '']) { await api(`/convert/${film}?t=${t}`); assert.equal(ff.calls.stream.at(-1).start, 0, `t=${t}`); }
    await api(`/convert/${film}?t=99999`);
    assert.equal(ff.calls.stream.at(-1).start, 7199, 'never past the end');

    await api(`/convert/${film}?t=10&caps=hevc8,hevc10,eac3`);
    assert.equal(ff.calls.stream.at(-1).plan.mode, 'direct', 'the same plan the page was told');

    assert.equal((await api(`/convert/${idOf('song.mp3')}`)).status, 404);
    assert.equal((await api('/convert/zzzz')).status, 404);
    assert.equal((await api(`/convert/${film}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, 'GET only');
  } finally {
    await srv.close();
  }
});

test('with the real manager and no ffmpeg: converting says so plainly, and nothing is created on disk', async () => {
  const dataDir = path.join(tmp, 'data-real-manager');
  const none = (bin, args, opts, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  const { srv, api, idOf } = await boot(new Ffmpeg({ dataDir, execFile: none, platform: 'linux', env: {} }));
  try {
    const r = await api(`/convert/${idOf('Film.2022.mkv')}?caps=hevc8`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /ffmpeg is not installed/);
    const status = await (await api('/api/ffmpeg')).json();
    assert.equal(status.state, 'missing');
    const install = await api('/api/ffmpeg/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(install.status, 400, 'not on this platform');
    assert.match((await install.json()).error, /Windows/);
    assert.equal(fs.existsSync(path.join(dataDir, 'ffmpeg')), false, 'no folder is made until something is downloaded');
  } finally {
    await srv.close();
  }
});

test('setup endpoints: status, install and remove go through the manager, and need a JSON request', async () => {
  const ff = stub({ ready: true });
  const { srv, api, idOf } = await boot(ff);
  try {
    assert.equal((await (await api('/api/ffmpeg')).json()).state, 'ready');
    const json = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    assert.equal((await api('/api/ffmpeg/install', json)).status, 200);
    assert.equal((await api('/api/ffmpeg/remove', json)).status, 200);
    assert.deepEqual([ff.calls.install, ff.calls.remove], [1, 1]);
    assert.equal((await api('/api/ffmpeg/install', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415, 'a web page cannot trigger a download with a plain form post');
    assert.equal((await api('/api/ffmpeg/install')).status, 404, 'GET does nothing');
    assert.equal(ff.calls.install, 1);
  } finally {
    await srv.close();
  }
});

test('a page on another site, or a rebinding attack, cannot reach the conversion endpoints', async () => {
  const ff = stub();
  const { srv, idOf } = await boot(ff);
  try {
    const film = idOf('Film.2022.mkv');
    const raw = (p, headers) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: srv.port, path: p, headers }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert.equal(await raw(`/convert/${film}`, { Host: 'evil.example' }), 403);
    assert.equal(await raw(`/api/play/${film}`, { Host: 'evil.example' }), 403);
    assert.equal(await raw(`/convert/${film}`, { Host: `127.0.0.1:${srv.port}`, Origin: 'https://evil.example' }), 403);
    assert.equal(ff.calls.stream.length, 0, 'ffmpeg was never started for them');
  } finally {
    await srv.close();
  }
});

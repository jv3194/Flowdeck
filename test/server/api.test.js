'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer } = require('../../server');
const { tmp, touch, until } = require('../support.js');

// A stand-in for ffmpeg that reports a file with three sound tracks, so the player's endpoints can be tested without ffmpeg.
const info = {
  duration: 7200,
  video: { codec: 'h264', bitDepth: 8, chroma: '420', height: 1080, width: 1920, transfer: '' },
  audio: [
    { codec: 'aac', channels: 2, lang: 'eng', name: '', isDefault: true, ordinal: 0 },
    { codec: 'aac', channels: 6, lang: 'spa', name: 'Latino', isDefault: false, ordinal: 1 },
    { codec: 'ac3', channels: 6, lang: 'fra', name: 'Commentary', isDefault: false, ordinal: 2 },
  ],
};
const stubFfmpeg = { locate: async () => ({}), probe: async () => info, status: async () => ({ state: 'ready' }), shutdown() {} };

/** A running server over a temporary library: music, a video and a photo, with helpers for talking to it. */
async function boot() {
  const t = tmp();
  touch(path.join(t.dir, 'media', 'Artist', 'Album', '01 - Song.mp3'), '0123456789');
  touch(path.join(t.dir, 'media', 'Movie (2020).mkv'), 'video');
  touch(path.join(t.dir, 'media', 'stray.jpg'), 'notaphoto');
  touch(path.join(t.dir, 'pics', 'Trip', 'a.jpg'), 'photo');
  const srv = await startServer({ port: 0, dataDir: path.join(t.dir, 'data'), webDir: path.join(__dirname, '..', '..', 'web'), ffmpeg: stubFfmpeg });
  const call = (method, p, body, headers = {}) => fetch(srv.url + p.replace(/^\//, ''), { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = {
    srv, t, media: path.join(t.dir, 'media'), pics: path.join(t.dir, 'pics'),
    get: async (p) => (await call('GET', p)).json(),
    post: (p, body) => call('POST', p, body),
    call,
    async library() { return api.get('/api/library'); },
    async ready(count) { await until(async () => { const l = await api.library(); return !l.scanning && l.items.length >= count; }); return api.library(); },
    /** A raw request, for the cases `fetch` would tidy up (odd Host headers, odd paths). */
    raw: (options) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, ...options }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
      req.on('error', reject);
      req.end();
    }),
    async close() {
      await until(() => !srv.lib.scanning).catch(() => {}); // a scan that is still running would try to save into the folder about to be deleted
      await srv.close();
      t.cleanup();
    },
  };
  return api;
}

test('the prefs API cannot be used to pollute Object.prototype', async () => {
  const s = await boot();
  try {
    const r = await s.call('PUT', '/api/prefs', JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"ok":1}'));
    assert.equal(r.status, 200);
    // JSON.parse above made "__proto__" an own key, exactly as the server's parser does with the request body
    await s.call('PUT', '/api/prefs', undefined, { 'content-type': 'application/json' });
    const raw = await fetch(s.srv.url + 'api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"polluted":"yes"},"ok":2}' });
    assert.equal(raw.status, 200);
    assert.equal({}.polluted, undefined);
    assert.equal({}.polluted2, undefined);
    assert.equal((await s.get('/api/prefs')).ok, 2);
  } finally {
    await s.close();
  }
});

test('prefs merge deeply, and null deletes a key', async () => {
  const s = await boot();
  try {
    await s.call('PUT', '/api/prefs', { sort: { music: 'title' }, progress: { a: 10, b: 20 } });
    await s.call('PUT', '/api/prefs', { sort: { video: 'added' }, progress: { a: null } });
    const p = await s.get('/api/prefs');
    assert.deepEqual([p.sort, p.progress], [{ music: 'title', video: 'added' }, { b: 20 }]);
  } finally {
    await s.close();
  }
});

test('requests with a foreign Host or Origin are refused (DNS rebinding and cross-site requests)', async () => {
  const s = await boot();
  try {
    assert.equal((await s.raw({ path: '/api/library', headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await s.raw({ path: '/api/library', headers: { Host: `127.0.0.1:${s.srv.port}`, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.raw({ path: '/api/library', headers: { Host: `127.0.0.1:${s.srv.port}`, Origin: `http://127.0.0.1:${s.srv.port}` } })).status, 200);
    assert.equal((await s.raw({ path: '/api/library', headers: { Host: `localhost:${s.srv.port}` } })).status, 200);
  } finally {
    await s.close();
  }
});

test('state-changing requests must be JSON, so a plain cross-site form cannot make them', async () => {
  const s = await boot();
  try {
    const r = await fetch(s.srv.url + 'api/scan', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(r.status, 415);
    assert.equal((await s.post('/api/scan', {})).status, 200);
  } finally {
    await s.close();
  }
});

test('the static files cannot be escaped with dot-dot paths, and unknown endpoints are 404', async () => {
  const s = await boot();
  try {
    // The URL parser folds some of these into plain in-folder paths (so web/package.json may be served); what must never
    // happen is that anything from outside the web folder, such as the app's own package.json, comes back.
    const webPackage = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'package.json'), 'utf8');
    // "%2f" survives the URL parser and is decoded afterwards, so these really do reach the files one folder up
    // (the app's package.json and the server's source): only the server's own check keeps them out.
    for (const p of ['/..%2fpackage.json', '/..%2fserver%2findex.js', '/..%2f..%2fapp%2fpackage.json', '/..%5cpackage.json', '/js%2f..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/js/../../package.json']) {
      const r = await s.raw({ path: p, headers: { Host: `127.0.0.1:${s.srv.port}` } });
      assert.ok(r.status !== 200 || r.body.toString() === webPackage, `${p} -> ${r.status}`);
      const text = r.body.toString();
      assert.ok(!text.includes('productName') && !text.includes('startServer'), `${p} leaked a file from outside the web folder`);
    }
    assert.equal((await s.raw({ path: '/', headers: { Host: `127.0.0.1:${s.srv.port}` } })).status, 200);
    assert.equal((await s.call('GET', '/api/nope')).status, 404);
  } finally {
    await s.close();
  }
});

test('folders: music/video folders and photo folders feed their own shelves only', async () => {
  const s = await boot();
  try {
    assert.equal((await s.post('/api/roots', { path: s.media })).status, 200);
    let lib = await s.ready(2);
    assert.deepEqual(lib.items.map((i) => i.kind).sort(), ['audio', 'video']);
    assert.equal((await s.post('/api/roots', { path: s.pics, photos: true })).status, 200);
    lib = await s.ready(3);
    assert.deepEqual([lib.roots, lib.photoRoots], [[s.media], [s.pics]]);
    assert.deepEqual(lib.items.map((i) => i.kind).sort(), ['audio', 'image', 'video']);
    assert.equal((await s.call('DELETE', '/api/roots', { path: s.pics, photos: true })).status, 200);
    lib = await s.library();
    assert.deepEqual([lib.photoRoots, lib.items.some((i) => i.kind === 'image')], [[], false]);
    assert.equal((await s.post('/api/roots', { path: path.join(s.t.dir, 'missing') })).status, 400);
  } finally {
    await s.close();
  }
});

test('library polling: unchanged when nothing moved, and a progress-only reply when asked', async () => {
  const s = await boot();
  try {
    await s.post('/api/roots', { path: s.media });
    const lib = await s.ready(2);
    const same = await s.get(`/api/library?rev=${lib.rev}`);
    assert.deepEqual([same.unchanged, same.items], [true, undefined]);
    const lite = await s.get(`/api/library?rev=${lib.rev - 1}&lite=1`);
    assert.deepEqual([lite.lite, lite.items, lite.scanning, lite.rev], [true, undefined, false, lib.rev]);
    const full = await s.get(`/api/library?rev=${lib.rev - 1}`);
    assert.equal(full.items.length, 2);
  } finally {
    await s.close();
  }
});

test('media files are served with byte ranges, which seeking needs', async () => {
  const s = await boot();
  try {
    await s.post('/api/roots', { path: s.media });
    const lib = await s.ready(2);
    const song = lib.items.find((i) => i.kind === 'audio');
    const partial = await s.call('GET', `/media/${song.id}`, undefined, { Range: 'bytes=2-5' });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), '2345');
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    const tail = await s.call('GET', `/media/${song.id}`, undefined, { Range: 'bytes=-3' });
    assert.equal(await tail.text(), '789');
    assert.equal((await s.call('GET', `/media/${song.id}`, undefined, { Range: 'bytes=50-60' })).status, 416);
    assert.equal(await (await s.call('GET', `/media/${song.id}`)).text(), '0123456789');
    assert.equal((await s.call('GET', '/media/0123456789abcdef')).status, 404);
  } finally {
    await s.close();
  }
});

test('a thumbnail uploaded by the page is stored and served back', async () => {
  const s = await boot();
  try {
    await s.post('/api/roots', { path: s.pics, photos: true });
    const lib = await s.ready(1);
    const id = lib.items[0].id;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50, 7)]);
    const put = await fetch(`${s.srv.url}cover/${id}?width=640&height=480`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
    assert.equal(put.status, 200);
    const got = await fetch(`${s.srv.url}cover/${id}`);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg);
    const after = (await s.library()).items.find((i) => i.id === id);
    assert.deepEqual([after.cover, after.width, after.height], [1, 640, 480]);
  } finally {
    await s.close();
  }
});

test('sound tracks: the list, and plans that switch tracks', async () => {
  const s = await boot();
  try {
    await s.post('/api/roots', { path: s.media });
    const lib = await s.ready(2);
    const id = lib.items.find((i) => i.kind === 'video').id;
    const { tracks } = await s.get(`/api/audio/${id}`);
    assert.deepEqual(tracks.map((t) => [t.ordinal, t.lang, t.isDefault, t.codec]), [[0, 'en', true, 'AAC'], [1, 'es', false, 'AAC'], [2, 'fr', false, 'AC-3 (Dolby Digital)']]);

    const plan = async (q) => s.get(`/api/play/${id}?caps=${q}`);
    assert.deepEqual([(await plan('')).mode, (await plan('')).switched], ['direct', false]);
    const spanish = await plan('&audio=1');
    assert.deepEqual([spanish.mode, spanish.switched, spanish.description], ['remux', true, 'Switching the sound track']);
    const french = await plan('&audio=2');
    assert.deepEqual([french.mode, french.reasons.length], ['remux', 1]);
    assert.equal((await plan('&audio=99')).mode, 'direct');
    assert.equal((await plan('&audio=abc')).mode, 'direct');

    assert.equal((await s.call('GET', `/api/audio/${'0'.repeat(16)}`)).status, 404);
    const song = lib.items.find((i) => i.kind === 'audio');
    assert.equal((await s.call('GET', `/api/audio/${song.id}`)).status, 404, 'only videos have sound tracks to choose');
  } finally {
    await s.close();
  }
});

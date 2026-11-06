'use strict';
// The tidy endpoints over HTTP, against a server on a throwaway library: what the page may ask for, what it gets back,
// and that the preferences and caches keyed by file id follow a renamed folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer } = require('../../server');
const { tmp, touch, until } = require('../support.js');

const stubFfmpeg = { locate: async () => null, status: async () => ({ state: 'missing' }), shutdown() {} };

async function boot(files) {
  const t = tmp();
  const media = path.join(t.dir, 'media');
  for (const f of files) touch(path.join(media, ...f.split('/')));
  const dataDir = path.join(t.dir, 'data');
  const srv = await startServer({ port: 0, dataDir, webDir: path.join(__dirname, '..', '..', 'web'), ffmpeg: stubFfmpeg });
  const call = (method, p, body, headers = {}) => fetch(srv.url + p.replace(/^\//, ''), { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  await call('POST', '/api/roots', { path: media });
  await until(() => srv.lib.items.size === files.length && !srv.lib.scanning);
  const here = (rel) => path.join(media, ...rel.split('/'));
  return {
    srv, t, media, dataDir, call, here,
    id: (rel) => [...srv.lib.items.values()].find((i) => i.path === here(rel)).id,
    json: async (method, p, body) => { const r = await call(method, p, body); return { status: r.status, body: await r.json() }; },
    exists: (rel) => fs.existsSync(here(rel)),
    ls: (rel = '') => fs.readdirSync(here(rel)).sort(),
    raw: (options) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, ...options }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end('{}');
    }),
    async close() {
      await until(() => !srv.lib.scanning).catch(() => {});
      await srv.close();
      t.cleanup();
    },
  };
}

test('plan changes nothing; apply renames the folder and the id-keyed preferences and caches follow it; undo reverses both', async () => {
  const s = await boot(['Heat.1995.1080p-GRP/Heat.mkv', 'Ronin.1998/ronin.mkv']);
  try {
    const old = s.id('Heat.1995.1080p-GRP/Heat.mkv');
    const target = { ids: [old], kind: 'movie', title: 'Heat', year: 1995 };
    await s.call('PUT', '/api/prefs', { progress: { [old]: 1234 }, watched: { [old]: 99 }, subDelay: { [old]: 0.5 }, focus: { video: old } });
    touch(path.join(s.dataDir, 'subs', `${old}.3.${s.srv.lib.get(old).mtime}.json`), '[]');

    const plan = await s.json('POST', '/api/tidy/plan', { targets: [target] });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.plans[0].status, 'ready');
    assert.equal(plan.body.plans[0].to, s.here('Heat (1995)'));
    assert.ok(s.exists('Heat.1995.1080p-GRP/Heat.mkv'), 'planning moved nothing');

    const done = await s.json('POST', '/api/tidy/apply', { targets: [target] });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.ok, done.body.folders, done.body.failed], [true, 1, []]);
    assert.deepEqual(s.ls(), ['Heat (1995)', 'Ronin.1998']);
    const fresh = s.id('Heat (1995)/Heat.mkv');
    assert.deepEqual(done.body.idMap, { [old]: fresh });

    const prefs = (await s.json('GET', '/api/prefs')).body;
    assert.deepEqual([prefs.progress[fresh], prefs.watched[fresh], prefs.subDelay[fresh], prefs.focus.video], [1234, 99, 0.5, fresh], 'where the viewer got to, and the rest, carried across');
    assert.equal(prefs.progress[old], undefined);
    const subs = fs.readdirSync(path.join(s.dataDir, 'subs'));
    assert.ok(subs.some((f) => f.startsWith(`${fresh}.3.`)) && !subs.some((f) => f.startsWith(`${old}.`)), 'cached subtitles follow too');

    const list = await s.json('GET', '/api/tidy/undo');
    assert.equal(list.body.batches.length, 1);
    assert.equal(list.body.batches[0].label, 'Heat (1995)');
    const undone = await s.json('POST', '/api/tidy/undo', { id: done.body.batch });
    assert.deepEqual([undone.status, undone.body.undone, undone.body.failed], [200, 1, []]);
    assert.deepEqual(s.ls(), ['Heat.1995.1080p-GRP', 'Ronin.1998']);
    const back = (await s.json('GET', '/api/prefs')).body;
    assert.equal(back.progress[old], 1234, 'and back again');
    assert.equal(back.focus.video, old);
    assert.deepEqual((await s.json('GET', '/api/tidy/undo')).body.batches, []);
  } finally {
    await s.close();
  }
});

test('the endpoints check what they are given', async () => {
  const s = await boot(['Heat.1995/heat.mkv']);
  try {
    const odd = await s.json('POST', '/api/tidy/plan', { targets: 'not a list' });
    assert.deepEqual(odd.body.plans, []);
    const hostile = await s.json('POST', '/api/tidy/plan', { targets: [{ ids: ['../../Windows', 42, null], kind: 'movie', title: 'x', year: 2000 }, { ids: ['0123456789abcdef'], kind: 'movie', title: 'Ghost' }] });
    assert.equal(hostile.body.plans.length, 2);
    assert.ok(hostile.body.plans.every((p) => p.status === 'blocked' && /no longer in the library/.test(p.reason)), 'unknown ids are refused, never looked up on disk');
    assert.equal((await s.json('POST', '/api/tidy/undo', { id: '../../etc' })).status, 404);
    assert.equal((await s.json('POST', '/api/tidy/undo', {})).status, 404);
    assert.equal((await s.call('POST', '/api/tidy/apply', undefined, { 'content-type': 'text/plain' })).status, 415, 'a web page cannot trigger a rename with a plain form post');
    assert.equal((await s.call('GET', '/api/tidy/apply')).status, 404, 'applying is POST only');
    assert.equal((await s.call('GET', '/api/tidy/plan')).status, 404);
    assert.deepEqual(s.ls(), ['Heat.1995']);
  } finally {
    await s.close();
  }
});

test('a page on another site, or a rebinding attack, cannot ask for a rename', async () => {
  const s = await boot(['Heat.1995/heat.mkv']);
  try {
    const body = { 'content-type': 'application/json', 'content-length': 2 };
    assert.equal(await s.raw({ method: 'POST', path: '/api/tidy/apply', headers: { ...body, Host: 'evil.example' } }), 403);
    assert.equal(await s.raw({ method: 'POST', path: '/api/tidy/apply', headers: { ...body, Host: `127.0.0.1:${s.srv.port}`, Origin: 'https://evil.example' } }), 403);
    assert.equal(await s.raw({ method: 'GET', path: '/api/tidy/undo', headers: { Host: 'evil.example' } }), 403);
    assert.deepEqual(s.ls(), ['Heat.1995']);
  } finally {
    await s.close();
  }
});

test('the library catches up by itself afterwards, with the renamed folder and nothing forgotten', async () => {
  const s = await boot(['Heat.1995-GRP/Heat.mkv']);
  try {
    s.srv.lib.watchDelay = 150;
    const old = s.id('Heat.1995-GRP/Heat.mkv');
    s.srv.lib.get(old).fetched = { src: 'tmdb', at: 1, found: true };
    await s.json('POST', '/api/tidy/apply', { targets: [{ ids: [old], kind: 'movie', title: 'Heat', year: 1995 }] });
    await new Promise((r) => setTimeout(r, 600)); // long enough for the watcher's rescan
    await until(() => !s.srv.lib.scanning);
    const lib = await (await s.call('GET', '/api/library')).json();
    assert.equal(lib.items.length, 1);
    assert.equal(lib.items[0].dir, s.here('Heat (1995)'));
    assert.equal(lib.items[0].fetched, 2, 'the looked-up details are still there');
  } finally {
    await s.close();
  }
});

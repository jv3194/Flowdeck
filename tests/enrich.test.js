'use strict';
// Library + Enricher + HTTP endpoints, driven by fake providers (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../server/library');
const { Enricher, cleanTargets } = require('../server/enrich');
const { startServer } = require('../server/index');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-enrich-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mp3 = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));
function makeMedia(name, files) {
  const root = path.join(tmp, name);
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  }
  return root;
}
async function scanned(root, dataName) {
  const lib = new Library(path.join(tmp, dataName));
  await lib.addRoot(root);
  while (lib.scanning) await new Promise((r) => setTimeout(r, 20));
  return lib;
}
const idOf = (lib, pred) => [...lib.items.values()].find(pred).id;
const settle = async (en) => { while (en.state.active) await new Promise((r) => setTimeout(r, 10)); return en.state; };

/** Fake providers: same surface as createProviders, each call recorded. */
function fakeProviders(over = {}) {
  const calls = [];
  const rec = (n, v) => async (...a) => { calls.push(n); return typeof v === 'function' ? v(...a) : v; };
  const p = {
    mbAlbums: rec('mb', []), itunesAlbums: rec('itunes', []), albumCandidates: rec('albumCandidates', []), releaseGroupInfo: rec('groupInfo', null),
    resolveAlbum: rec('resolveAlbum', { title: 'T', artUrls: ['https://coverartarchive.org/a'] }),
    movieCandidates: rec('movies', []), resolveMovie: rec('resolveMovie', {}), showCandidates: rec('shows', []), resolveShow: rec('resolveShow', {}),
    showEpisodes: rec('episodes', []), firstImage: rec('image', { data: PNG, mime: 'image/png' }), downloadImage: rec('dl', null), testTmdbKey: rec('key', true),
    ...over,
  };
  p.calls = calls;
  return p;
}
const cand = (score, data) => ({ ref: { provider: 'x', id: 1 }, title: data.title, score, data });

test('cleanTargets keeps well-formed targets and drops junk', () => {
  const ok = 'abcdef0123456789';
  const out = cleanTargets([
    { type: 'album', ids: [ok], artist: 'A', album: 'B' },
    { type: 'album', ids: ['../x'], album: 'B' },
    { type: 'album', ids: [ok], album: '' },
    { type: 'movie', id: ok, title: 'Heat', year: '1995' },
    { type: 'movie', id: 'zz', title: 'Heat' },
    { type: 'show', show: 'Fargo', episodes: [{ id: ok, season: 1, episode: 2 }, { id: 'nope' }] },
    { type: 'show', show: 'Empty', episodes: [] },
    { type: 'wat' }, null, 'str',
  ]);
  assert.deepEqual(out.map((t) => t.type), ['album', 'movie', 'show']);
  assert.equal(out[1].year, 1995);
  assert.equal(out[2].episodes.length, 1);
  assert.deepEqual(cleanTargets('nope'), []);
});

test('album: art lands on the first track, year/genre only fill gaps, and the cover is served with a bumped version', async () => {
  const root = makeMedia('music1', { 'Daft Punk/Discovery/01 - One More Time.mp3': mp3, 'Daft Punk/Discovery/02 - Aerodynamic.mp3': mp3 });
  const lib = await scanned(root, 'd1');
  const ids = [...lib.items.values()].sort((a, b) => a.path.localeCompare(b.path)).map((i) => i.id);
  const p = fakeProviders({ mbAlbums: async () => [cand(0.97, { title: 'Discovery', artist: 'Daft Punk', year: 2001, artUrls: ['https://coverartarchive.org/x'] })] });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'album', ids, artist: 'Daft Punk', album: 'Discovery' }]);
  const st = await settle(en);
  assert.deepEqual([st.found, st.missed, st.failed], [1, 0, 0]);
  const [a, b] = ids.map((i) => lib.toClient(lib.get(i)));
  assert.equal(a.cover, 1);
  assert.equal(b.cover, 0, 'only the first track carries the art');
  assert.equal(a.cv, 1);
  assert.equal(a.year, 2001);
  assert.equal(b.year, 2001);
  assert.equal(a.fetched, 2);
  const served = await lib.cover(ids[0]);
  assert.deepEqual(fs.readFileSync(served.file), PNG);
  assert.equal(served.mime, 'image/png');
  assert.ok(!p.calls.includes('itunes'), 'a good MusicBrainz hit with art needs no fallback');

  // Already looked up: a second bulk run skips it; force redoes it.
  en.enqueue([{ type: 'album', ids, artist: 'Daft Punk', album: 'Discovery' }]);
  assert.equal((await settle(en)).skipped, 1);
});

test('album: the year is the first release, not the date of whichever pressing matched', async () => {
  const root = makeMedia('music-year', { 'Pink Floyd/Dark Side/01 - a.mp3': mp3 });
  const lib = await scanned(root, 'd-year');
  const ids = [...lib.items.keys()];
  const group = '48117b90-a16e-34ca-a514-19c702df1158';
  const p = fakeProviders({
    mbAlbums: async () => [{ ...cand(0.97, { title: 'Dark Side', year: 2011, artUrls: ['https://coverartarchive.org/x'] }), ref: { provider: 'musicbrainz', release: 'r', group } }],
    releaseGroupInfo: async (g) => (g === group ? { year: 1973, genre: 'Rock' } : null),
  });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'album', ids, artist: 'Pink Floyd', album: 'Dark Side' }]);
  await settle(en);
  const c = lib.toClient(lib.get(ids[0]));
  assert.deepEqual([c.year, c.genre], [1973, 'Rock'], 'the album-level year and genre win over the pressing');
});

test('album: falls back to iTunes when MusicBrainz has no art, merging the year', async () => {
  const root = makeMedia('music2', { 'X/Y/01 - a.mp3': mp3 });
  const lib = await scanned(root, 'd2');
  const ids = [...lib.items.keys()];
  const p = fakeProviders({
    mbAlbums: async () => [cand(0.9, { title: 'Y', year: 1999, artUrls: ['https://coverartarchive.org/none'] })],
    itunesAlbums: async () => [cand(0.9, { title: 'Y', year: 2000, genre: 'Rock', artUrls: ['https://is1-ssl.mzstatic.com/z/600x600bb.jpg'] })],
    firstImage: async (urls) => (urls[0].includes('mzstatic') ? { data: PNG, mime: 'image/png' } : null),
  });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'album', ids, artist: 'X', album: 'Y' }]);
  await settle(en);
  const c = lib.toClient(lib.get(ids[0]));
  assert.deepEqual([c.cover, c.year, c.genre], [1, 1999, 'Rock']);
  assert.equal(lib.get(ids[0]).fetched.src, 'MusicBrainz + iTunes');
});

test('album: no confident match is remembered so bulk runs stop retrying it', async () => {
  const root = makeMedia('music3', { 'Nobody/Nothing/01 - a.mp3': mp3 });
  const lib = await scanned(root, 'd3');
  const ids = [...lib.items.keys()];
  const p = fakeProviders({ mbAlbums: async () => [cand(0.4, { title: 'other', artUrls: [] })] });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'album', ids, artist: 'Nobody', album: 'Nothing' }]);
  assert.equal((await settle(en)).missed, 1);
  assert.equal(lib.toClient(lib.get(ids[0])).fetched, 1);
  en.enqueue([{ type: 'album', ids, artist: 'Nobody', album: 'Nothing' }]);
  assert.equal((await settle(en)).skipped, 1);
  en.enqueue([{ type: 'album', ids, artist: 'Nobody', album: 'Nothing' }], { force: true });
  assert.equal((await settle(en)).missed, 1, 'force looks again');
});

test('movie: poster + metadata stored; the poster is what /cover serves, ahead of any video-frame thumbnail', async () => {
  const root = makeMedia('movies', { 'The.Matrix.1999.1080p.BluRay.mkv': Buffer.alloc(2048, 1) });
  const lib = await scanned(root, 'd4');
  const id = [...lib.items.keys()][0];
  assert.deepEqual(lib.toClient(lib.get(id)).parsed, { type: 'movie', title: 'The Matrix', year: 1999 });
  await lib.setThumb(id, Buffer.from([0xff, 0xd8, 0xff, 1]), { width: 1920, height: 1080 }); // a frame thumbnail already exists
  const p = fakeProviders({ movieCandidates: async () => [cand(0.95, { title: 'The Matrix', year: 1999, summary: 'Neo.', rating: 8.2, genres: ['Action'], artUrls: ['https://image.tmdb.org/t/p/w500/a.jpg'] })] });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'movie', id, title: 'The Matrix', year: 1999 }]);
  assert.equal((await settle(en)).found, 1);
  const c = lib.toClient(lib.get(id));
  assert.deepEqual([c.poster, c.fetched, c.meta.title, c.meta.summary, c.meta.rating, c.meta.genres, c.meta.src], [1, 2, 'The Matrix', 'Neo.', 8.2, ['Action'], 'TMDB']);
  assert.ok(c.cv >= 2);
  assert.deepEqual(fs.readFileSync((await lib.cover(id)).file), PNG);
});

test('movie: a missing key aborts the remaining movies but not the albums queued with them', async () => {
  const root = makeMedia('mixed', { 'A.2001.mkv': Buffer.alloc(100), 'B.2002.mkv': Buffer.alloc(100), 'Art/Alb/01 - t.mp3': mp3 });
  const lib = await scanned(root, 'd5');
  const byName = (n) => idOf(lib, (i) => i.path.includes(n));
  const err = Object.assign(new Error('Movies need a free TMDB API key'), { code: 'NO_KEY' });
  let movieLookups = 0;
  const p = fakeProviders({ movieCandidates: async () => { movieLookups++; throw err; }, mbAlbums: async () => [cand(0.99, { title: 'Alb', artUrls: ['https://coverartarchive.org/q'] })] });
  const en = new Enricher(lib, p);
  en.enqueue([
    { type: 'movie', id: byName('A.2001'), title: 'A', year: 2001 },
    { type: 'album', ids: [byName('01 - t')], artist: 'Art', album: 'Alb' },
    { type: 'movie', id: byName('B.2002'), title: 'B', year: 2002 },
  ]);
  const st = await settle(en);
  assert.equal(st.noKey, true);
  assert.equal(st.found, 1, 'the album still completed');
  assert.equal(st.done, st.total, 'skipped movies still count toward progress');
  assert.equal(movieLookups, 1, 'only one movie lookup was attempted');
});

test('offline: three failures in a row stop the run instead of grinding through the queue', async () => {
  const root = makeMedia('offline', Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`Art${n}/Alb${n}/01 - t.mp3`, mp3])));
  const lib = await scanned(root, 'd6');
  const off = Object.assign(new Error("Can't reach musicbrainz.org"), { code: 'OFFLINE' });
  const p = fakeProviders({ mbAlbums: async () => { throw off; }, itunesAlbums: async () => { throw off; } });
  const en = new Enricher(lib, p);
  en.enqueue([...lib.items.values()].map((it, i) => ({ type: 'album', ids: [it.id], artist: `Art${i}`, album: `Alb${i}` })));
  const st = await settle(en);
  assert.equal(st.offline, true);
  assert.equal(st.failed, 3);
  assert.equal(st.done, 5);
});

test('show: poster once, show details and per-episode titles on every episode', async () => {
  const root = makeMedia('shows', {
    'Fargo/Season 1/Fargo.S01E01.720p.mkv': Buffer.alloc(100), 'Fargo/Season 1/Fargo.S01E02.720p.mkv': Buffer.alloc(100),
  });
  const lib = await scanned(root, 'd7');
  const eps = [...lib.items.values()].map((it) => ({ id: it.id, season: it.parsed.season, episode: it.parsed.episode })).sort((a, b) => a.episode - b.episode);
  assert.deepEqual(eps.map((e) => [e.season, e.episode]), [[1, 1], [1, 2]]);
  const p = fakeProviders({
    showCandidates: async () => [cand(0.99, { id: 5, name: 'Fargo', year: 2014, summary: 'Crime.', genres: ['Drama'], network: 'FX', rating: 8.9, artUrls: ['https://static.tvmaze.com/o.jpg'] })],
    showEpisodes: async () => [{ season: 1, episode: 1, title: 'The Crocodile\'s Dilemma', airdate: '2014-04-15', runtime: 68, summary: 'Lester.' }],
  });
  const en = new Enricher(lib, p);
  en.enqueue([{ type: 'show', show: 'Fargo', year: 2014, episodes: eps }]);
  assert.equal((await settle(en)).found, 1);
  const [a, b] = eps.map((e) => lib.toClient(lib.get(e.id)));
  assert.deepEqual([a.poster, b.poster], [1, 0]);
  assert.equal(a.meta.show.name, 'Fargo');
  assert.equal(b.meta.show.network, 'FX');
  assert.equal(a.meta.epTitle, "The Crocodile's Dilemma");
  assert.equal(b.meta.epTitle, undefined, 'episodes the service does not list still get the show details');
});

test('clearFetched removes the poster, metadata and filled-in tags, and keeps the files', async () => {
  const root = makeMedia('clear', { 'Art/Alb/01 - t.mp3': mp3 });
  const lib = await scanned(root, 'd8');
  const id = [...lib.items.keys()][0];
  await lib.applyAlbum([id], { year: 1990, genre: 'Jazz', image: { data: PNG, mime: 'image/png' }, src: 'iTunes' });
  assert.equal(lib.toClient(lib.get(id)).cover, 1);
  const file = (await lib.cover(id)).file;
  await lib.clearFetched([id]);
  const c = lib.toClient(lib.get(id));
  assert.deepEqual([c.cover, c.year, c.genre, c.fetched], [0, undefined, undefined, 0]);
  assert.equal(fs.existsSync(file), false, 'the cover file is gone by the time clearFetched resolves');
  assert.equal(fs.existsSync(lib.get(id).path), true);
});

test('http: endpoints validate input, never echo the TMDB key, and re-resolve refs server-side', async () => {
  const root = makeMedia('http', { 'Art/Alb/01 - t.mp3': mp3 });
  const calls = [];
  const providers = fakeProviders({
    albumCandidates: async (q) => { calls.push(['candidates', q]); return [{ ...cand(0.9, { title: 'Alb' }), subtitle: 's', thumb: 'http://insecure.example/t.jpg' }, { ...cand(0.8, { title: 'Alb2' }), thumb: 'https://is1-ssl.mzstatic.com/t.jpg' }]; },
    resolveAlbum: async (ref) => { calls.push(['resolve', ref]); return { title: 'Alb', year: 2005, artUrls: ['https://coverartarchive.org/z'] }; },
    testTmdbKey: async (k) => k === 'goodkey',
  });
  const dataDir = path.join(tmp, 'd-http');
  const srv = await startServer({ port: 0, dataDir, webDir: path.join(__dirname, '..', 'web'), providers });
  try {
    const post = (route, body, headers = {}) => fetch(srv.url + route.slice(1), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await post('/api/roots', { path: root });
    while (srv.lib.scanning) await new Promise((r) => setTimeout(r, 20));
    const id = [...srv.lib.items.keys()][0];

    let r = await post('/api/meta/candidates', { type: 'album', artist: 'Art', album: 'Alb', trackCount: 1 });
    const cands = (await r.json()).candidates;
    assert.equal(cands.length, 2);
    assert.equal(cands[0].thumb, undefined, 'non-https thumbnails are dropped');
    assert.ok(cands[1].thumb.startsWith('https://'));
    assert.equal('data' in cands[0], false, 'server-side data is not exposed');

    r = await post('/api/meta/apply', { type: 'album', ids: [id, '../etc'], ref: { provider: 'itunes', id: 3 } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ['resolve', { provider: 'itunes', id: 3 }]);
    assert.equal((await (await fetch(`${srv.url}api/library`)).json()).items[0].year, 2005);
    assert.equal((await post('/api/meta/apply', { type: 'album', ids: [id] })).status, 400, 'a ref is required');

    r = await post('/api/meta/fetch', { targets: [{ type: 'album', ids: ['../x'], album: 'q' }, { type: 'album', ids: [id], artist: 'Art', album: 'Alb' }] });
    assert.equal((await r.json()).queued, 1, 'invalid targets are dropped');

    assert.equal((await post('/api/meta/key', { key: 'badkey' })).status, 400);
    r = await post('/api/meta/key', { key: 'goodkey' });
    assert.equal((await r.json()).tmdb, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'tmdb.key'), 'utf8'), 'goodkey');
    const lib = await (await fetch(`${srv.url}api/library`)).json();
    assert.equal(lib.tmdb, true);
    assert.equal(lib.version, require('../package.json').version, 'the About screen shows the real version');
    assert.ok(!JSON.stringify(lib).includes('goodkey'), 'the key never goes back to the page');
    assert.ok(!JSON.stringify(await (await fetch(`${srv.url}api/prefs`)).json()).includes('goodkey'));
    r = await post('/api/meta/key', { key: '' });
    assert.equal((await r.json()).tmdb, false);
    assert.equal(fs.existsSync(path.join(dataDir, 'tmdb.key')), false);

    assert.equal((await post('/api/meta/fetch', { targets: [] }, { Origin: 'http://evil.example' })).status, 403, 'cross-origin requests are refused');
    const old = await post(`/api/meta/${id}`, { duration: 12 });
    assert.equal(old.status, 200, 'the older per-item metadata route still works');
  } finally {
    await srv.close();
  }
});

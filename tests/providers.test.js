'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviders } = require('../server/providers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

/** A fake fetch: routes are [substring, handler(url, init) -> body | Response-like] checked in order. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [needle, handler] of routes) {
      if (!u.includes(needle)) continue;
      const out = await handler(u, init);
      if (out && out.__res) return out.__res;
      return respond(200, out);
    }
    return respond(404, null);
  };
  fn.calls = calls;
  return fn;
}
function respond(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : null;
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? (buf ? { 'content-length': String(buf.length) }[k.toLowerCase()] : null) ?? null },
    json: async () => body,
    arrayBuffer: async () => (buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) : new ArrayBuffer(0)),
  };
}
const res = (status, body, headers) => ({ __res: respond(status, body, headers) });
const make = (routes, extra = {}) => {
  const fetch = fakeFetch(routes);
  return { p: createProviders({ fetch, gaps: {}, retryMs: 1, ...extra }), fetch };
};

const mbReleases = {
  releases: [
    { id: '488477d8-10b4-47fe-a482-549f011406a5', title: 'Discovery', status: 'Official', date: '2001-03-12', 'track-count': 14, 'artist-credit': [{ name: 'Daft Punk' }], 'release-group': { id: '48117b90-a16e-34ca-a514-19c702df1158' } },
    { id: '11111111-4b0f-4a6f-9d3b-000000000001', title: 'Discovery', status: 'Official', date: '2001-03-13', 'track-count': 14, 'artist-credit': [{ name: 'Daft Punk' }], 'release-group': { id: '48117b90-a16e-34ca-a514-19c702df1158' } },
    { id: '22222222-4b0f-4a6f-9d3b-000000000002', title: 'Discovery Live', status: 'Bootleg', date: '2004', 'track-count': 20, 'artist-credit': [{ name: 'Daft Punk' }], 'release-group': { id: '33333333-4b0f-4a6f-9d3b-000000000003' } },
  ],
};

test('musicbrainz: one candidate per release group, best first, with art URLs', async () => {
  const { p, fetch } = make([['musicbrainz.org/ws/2/release/?', () => mbReleases]]);
  const c = await p.mbAlbums({ artist: 'Daft Punk', album: 'Discovery', trackCount: 14 });
  assert.equal(c.length, 2);
  assert.equal(c[0].title, 'Discovery');
  assert.ok(c[0].score > 0.95);
  assert.ok(c[1].score < c[0].score);
  assert.equal(c[0].year, 2001);
  assert.equal(c[0].data.artUrls[0], 'https://coverartarchive.org/release-group/48117b90-a16e-34ca-a514-19c702df1158/front-500');
  const q = decodeURIComponent(new URL(fetch.calls[0].url).searchParams.get('query'));
  assert.equal(q, 'release:"Discovery" AND artist:"Daft Punk"');
  assert.match(fetch.calls[0].init.headers['User-Agent'], /^Flowdeck\//);
});

test('musicbrainz: the candidate year is the earliest pressing, not the best-scoring reissue', async () => {
  const rg = { id: '48117b90-a16e-34ca-a514-19c702df1158' };
  const rel = (id, date, title) => ({ id, title, status: 'Official', date, 'artist-credit': [{ name: 'Daft Punk' }], 'release-group': rg });
  const { p } = make([['musicbrainz.org', () => ({ releases: [rel('a', '2021-05-01', 'Discovery'), rel('b', '2001-03-12', 'Discovery (Japan)'), rel('c', '', 'Discovery')] })]]);
  const [c] = await p.mbAlbums({ artist: 'Daft Punk', album: 'Discovery' });
  assert.equal(c.year, 2001);
  assert.equal(c.data.year, 2001);
  assert.match(c.subtitle, /2001/);
});

test('musicbrainz: quotes in the album name are escaped in the Lucene query', async () => {
  const { p, fetch } = make([['musicbrainz.org', () => ({ releases: [] })]]);
  await p.mbAlbums({ artist: '', album: 'The "Best" of' });
  assert.equal(decodeURIComponent(new URL(fetch.calls[0].url).searchParams.get('query')), 'release:"The \\"Best\\" of"');
});

test('itunes: artwork is upsized and the artist weighs in on the score', async () => {
  const hit = (name, artist) => ({ collectionId: 7, collectionName: name, artistName: artist, releaseDate: '2013-05-17T07:00:00Z', primaryGenreName: 'Pop', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/y.jpg/100x100bb.jpg' });
  const { p } = make([['itunes.apple.com/search', () => ({ results: [hit('Random Access Memories', 'Daft Punk'), hit('Random Access Memories', 'Tribute Band')] })]]);
  const c = await p.itunesAlbums({ artist: 'Daft Punk', album: 'Random Access Memories' });
  assert.equal(c[0].subtitle.startsWith('Daft Punk'), true);
  assert.ok(c[0].score > c[1].score);
  assert.equal(c[0].data.artUrls[0], 'https://is1-ssl.mzstatic.com/image/thumb/x/y.jpg/600x600bb.jpg');
  assert.equal(c[0].data.genre, 'Pop');
});

test('albumCandidates survives one source failing, but not both', async () => {
  const ok = make([['musicbrainz.org', () => mbReleases], ['itunes.apple.com', () => res(500, null)]]);
  assert.ok((await ok.p.albumCandidates({ artist: 'Daft Punk', album: 'Discovery' })).length >= 1);
  const down = make([['musicbrainz.org', () => res(500, null)], ['itunes.apple.com', () => res(500, null)]]);
  await assert.rejects(down.p.albumCandidates({ artist: 'x', album: 'y' }));
});

test('resolveAlbum refuses references that are not UUIDs', async () => {
  const { p, fetch } = make([]);
  await assert.rejects(p.resolveAlbum({ provider: 'musicbrainz', release: '../../etc', group: null }), /Bad reference/);
  assert.equal(fetch.calls.length, 0);
});

test('resolveAlbum (musicbrainz) picks the most-voted genre', async () => {
  const id = '488477d8-10b4-47fe-a482-549f011406a5';
  const { p } = make([[`/release/${id}`, () => ({ title: 'Discovery', date: '2001-03-12', 'artist-credit': [{ name: 'Daft Punk' }], genres: [{ name: 'house', count: 3 }, { name: 'electronic', count: 9 }] })]]);
  const d = await p.resolveAlbum({ provider: 'musicbrainz', release: id, group: null });
  assert.deepEqual([d.title, d.artist, d.year, d.genre], ['Discovery', 'Daft Punk', 2001, 'Electronic']);
});

test('releaseGroupInfo reads the first release year and the most-voted genre, and refuses non-UUIDs', async () => {
  const group = '48117b90-a16e-34ca-a514-19c702df1158';
  const { p, fetch } = make([[`/release-group/${group}`, () => ({ 'first-release-date': '1973-03-01', genres: [{ name: 'prog rock', count: 2 }, { name: 'rock', count: 9 }] })]]);
  assert.deepEqual(await p.releaseGroupInfo(group), { year: 1973, genre: 'Rock' });
  assert.match(fetch.calls[0].url, /inc=genres/);
  assert.equal(await p.releaseGroupInfo('../x'), null);
  assert.equal(fetch.calls.length, 1, 'no request for a bad id');
  const bare = make([['/release-group/', () => ({})]]);
  assert.deepEqual(await bare.p.releaseGroupInfo(group), { year: undefined, genre: undefined });
  const gone = make([['/release-group/', () => res(404, null)]]);
  assert.equal(await gone.p.releaseGroupInfo(group), null);
});

test('movies: a missing key is a distinct error, and the year breaks ties', async () => {
  const none = make([]);
  await assert.rejects(none.p.movieCandidates({ title: 'Heat', year: 1995 }), (e) => e.code === 'NO_KEY');

  const results = [
    { id: 1, title: 'Heat', release_date: '1986-01-01', overview: 'Old one', poster_path: '/a.jpg', vote_average: 5.1, genre_ids: [28] },
    { id: 2, title: 'Heat', release_date: '1995-12-15', overview: 'Cops and robbers', poster_path: '/b.jpg', vote_average: 8.04, genre_ids: [28, 80] },
  ];
  const { p, fetch } = make([['/genre/movie/list', () => ({ genres: [{ id: 28, name: 'Action' }, { id: 80, name: 'Crime' }] })], ['/search/movie', () => ({ results })]], { getTmdbKey: () => 'abc123' });
  const c = await p.movieCandidates({ title: 'Heat', year: 1995 });
  assert.equal(c[0].ref.id, 2);
  assert.ok(c[0].score > c[1].score);
  assert.deepEqual(c[0].data.genres, ['Action', 'Crime']);
  assert.equal(c[0].data.rating, 8);
  assert.equal(c[0].data.artUrls[0], 'https://image.tmdb.org/t/p/w500/b.jpg');
  assert.match(fetch.calls.find((x) => x.url.includes('/search/movie')).url, /api_key=abc123/);
});

test('movies: a v4 bearer token goes in the header, not the URL', async () => {
  const { p, fetch } = make([['/search/movie', () => ({ results: [] })]], { getTmdbKey: () => 'eyJhbGciOi.payload.sig' });
  await p.movieCandidates({ title: 'x' });
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer eyJhbGciOi.payload.sig');
  assert.ok(!fetch.calls[0].url.includes('api_key'));
});

test('movies: retries without the year when the filtered search is empty', async () => {
  let n = 0;
  const { p } = make([['/genre/movie/list', () => ({ genres: [] })], ['/search/movie', (u) => (n++ === 0 ? { results: [] } : { results: [{ id: 9, title: 'Alien', release_date: '1979-05-25', genre_ids: [] }] })]], { getTmdbKey: () => 'k' });
  const c = await p.movieCandidates({ title: 'Alien', year: 1980 });
  assert.equal(c[0].title, 'Alien');
  assert.equal(n, 2);
});

test('tmdb key check: 200 is valid, 401 is rejected', async () => {
  const good = make([['/configuration', () => ({ images: {} })]]);
  assert.equal(await good.p.testTmdbKey('k'), true);
  const bad = make([['/configuration', () => res(401, { status_code: 7 })]]);
  assert.equal(await bad.p.testTmdbKey('k'), false);
});

test('shows: html is stripped from summaries and episodes are mapped', async () => {
  const show = { id: 169, name: 'Breaking Bad', premiered: '2008-01-20', genres: ['Drama', 'Crime'], summary: '<p><b>Walter</b> White &amp; friends.</p>', rating: { average: 9.2 }, network: { name: 'AMC' }, image: { medium: 'https://static.tvmaze.com/m.jpg', original: 'https://static.tvmaze.com/o.jpg' } };
  const { p } = make([
    ['/search/shows', () => [{ score: 1, show }, { score: 0.4, show: { ...show, id: 2, name: 'Breaking Bad: Original Minisodes', premiered: '2009-02-17' } }]],
    ['/shows/169/episodes', () => [{ season: 1, number: 2, name: "Cat's in the Bag...", airdate: '2008-01-27', runtime: 60, summary: '<p>Walt and Jesse <i>clean up</i>.</p>' }]],
  ]);
  const c = await p.showCandidates({ name: 'Breaking Bad', year: 2008 });
  assert.equal(c[0].ref.id, 169);
  assert.equal(c[0].data.summary, 'Walter White & friends.');
  assert.equal(c[0].data.network, 'AMC');
  assert.deepEqual(c[0].data.artUrls, ['https://static.tvmaze.com/o.jpg', 'https://static.tvmaze.com/m.jpg']);
  assert.ok(c[0].score > c[1].score);
  const eps = await p.showEpisodes(169);
  assert.deepEqual(eps[0], { season: 1, episode: 2, title: "Cat's in the Bag...", airdate: '2008-01-27', runtime: 60, summary: 'Walt and Jesse clean up.' });
});

test('downloadImage: only https from allow-listed hosts, and redirects are re-checked', async () => {
  const { p } = make([
    ['coverartarchive.org/release-group/ok', () => res(307, null, { location: 'https://ia800000.us.archive.org/img.png' })],
    ['ia800000.us.archive.org', () => PNG],
    ['coverartarchive.org/release-group/evil', () => res(302, null, { location: 'http://127.0.0.1:9999/secret' })],
    ['coverartarchive.org/release-group/escape', () => res(302, null, { location: 'https://evil.example.com/x.png' })],
    ['coverartarchive.org/release-group/none', () => res(404, null)],
    ['static.tvmaze.com/text', () => Buffer.from('<html>not an image</html>')],
  ]);
  const img = await p.downloadImage('https://coverartarchive.org/release-group/ok/front-500');
  assert.equal(img.mime, 'image/png');
  assert.equal(img.data.length, PNG.length);
  await assert.rejects(p.downloadImage('http://coverartarchive.org/x'), /not allowed/);
  await assert.rejects(p.downloadImage('https://evil.example.com/x.png'), /not allowed/);
  await assert.rejects(p.downloadImage('https://coverartarchive.org/release-group/evil/front-500'), /not allowed/);
  await assert.rejects(p.downloadImage('https://coverartarchive.org/release-group/escape/front-500'), /not allowed/);
  await assert.rejects(p.downloadImage('https://notmzstatic.com/x.png'), /not allowed/);
  assert.equal(await p.downloadImage('https://coverartarchive.org/release-group/none/front-500'), null);
  assert.equal(await p.downloadImage('https://static.tvmaze.com/text'), null, 'non-image bytes are rejected');
});

test('firstImage skips URLs without art and returns the next one', async () => {
  const { p } = make([['/front-500', () => res(404, null)], ['static.tvmaze.com/o.png', () => PNG]]);
  const img = await p.firstImage(['https://coverartarchive.org/release-group/a/front-500', 'https://static.tvmaze.com/o.png']);
  assert.equal(img.mime, 'image/png');
  assert.equal(await p.firstImage([]), null);
});

test('requests to one host are spaced by its gap; a 503 is retried; a dead network is reported as OFFLINE', async () => {
  const stamps = [];
  const spaced = make([['api.tvmaze.com', () => { stamps.push(Date.now()); return []; }]], { gaps: { 'api.tvmaze.com': 60 } });
  const t0 = Date.now();
  await Promise.all([spaced.p.showCandidates({ name: 'a' }), spaced.p.showCandidates({ name: 'b' }), spaced.p.showCandidates({ name: 'c' })]);
  // Measured from a fixed start: timers can fire late under load but never early, so these bounds can't flake.
  assert.ok(stamps[1] - t0 >= 55 && stamps[2] - t0 >= 115, `calls at +${stamps.map((s) => s - t0).join(', +')}ms`);

  let tries = 0;
  const flaky = make([['musicbrainz.org', () => (++tries < 3 ? res(503, null) : { releases: [] })]]);
  assert.deepEqual(await flaky.p.mbAlbums({ album: 'x' }), []);
  assert.equal(tries, 3);

  const offline = createProviders({ fetch: async () => { throw new TypeError('fetch failed'); }, gaps: {} });
  await assert.rejects(offline.showCandidates({ name: 'x' }), (e) => e.code === 'OFFLINE');
});

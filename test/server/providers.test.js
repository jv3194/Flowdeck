'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviders, ACCEPT } = require('../../server/providers.js');
const { Enricher, cleanTargets } = require('../../server/enrich.js');

// A fetch that answers from a table of [url-substring, handler] pairs, and remembers what it was asked.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    url = String(url);
    calls.push(url);
    for (const [part, answer] of routes) {
      if (!url.includes(part)) continue;
      const a = typeof answer === 'function' ? answer(url, opts) : answer;
      if (a instanceof Error) throw a;
      return { ok: a.status ? a.status < 400 : true, status: a.status || 200, headers: new Map(Object.entries(a.headers || {})) && { get: (k) => (a.headers || {})[k.toLowerCase()] ?? null }, json: async () => a.body, arrayBuffer: async () => a.bytes, text: async () => a.text };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => ({ status, body });
const providers = (routes, opts = {}) => createProviders({ fetch: fakeFetch(routes), gaps: {}, retryMs: 1, ...opts });

const itunes = (results) => ['itunes.apple.com/search', json({ results })];
const film = (id, name, date, extra = {}) => ({ trackId: id, trackName: name, releaseDate: date, longDescription: `About ${name}`, primaryGenreName: 'Drama', trackTimeMillis: 6_000_000, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/x/100x100bb.jpg', ...extra });
const tmdbRoutes = (results) => [['/genre/movie/list', json({ genres: [{ id: 1, name: 'Drama' }] })], ['/search/movie', json({ results })]];

test('movies without a TMDB key come from iTunes alone, with art, genre and runtime', async () => {
  const p = providers([itunes([film(1, 'Dune', '2021-10-22T07:00:00Z')])]);
  const [best] = await p.movieCandidates({ title: 'Dune', year: 2021 });
  assert.deepEqual([best.ref.provider, best.title, best.year, best.score], ['itunes', 'Dune', 2021, 1]);
  assert.deepEqual([best.data.genres, best.data.runtime], [['Drama'], 100]);
  assert.match(best.data.artUrls[0], /1000x1000bb\.jpg$/);
});

test('with a key, TMDB leads, an iTunes copy of the same film is dropped, and ratings come from TMDB', async () => {
  const p = providers([
    ...tmdbRoutes([{ id: 603, title: 'The Matrix', release_date: '1999-03-30', vote_average: 8.24, genre_ids: [1], poster_path: '/p.jpg' }]),
    itunes([film(7, 'The Matrix', '1999-03-31T07:00:00Z'), film(8, 'The Matrix Reloaded', '2003-05-15T07:00:00Z')]),
  ], { getTmdbKey: () => 'key' });
  const list = await p.movieCandidates({ title: 'The Matrix', year: 1999 });
  assert.deepEqual(list.map((c) => `${c.ref.provider}:${c.title}`), ['tmdb:The Matrix', 'itunes:The Matrix Reloaded']);
  assert.equal(list[0].data.rating, 8.2);
});

test('a rejected TMDB key does not stop movies: iTunes still answers', async () => {
  const p = providers([['themoviedb', json({}, 401)], itunes([film(1, 'Dune', '2021-10-22T07:00:00Z')])], { getTmdbKey: () => 'bad' });
  assert.equal((await p.movieCandidates({ title: 'Dune' }))[0].ref.provider, 'itunes');
});

test('movies fail only when every source failed, and say so', async () => {
  const offline = Object.assign(new Error('x'), { code: 'OFFLINE' });
  await assert.rejects(providers([['itunes', new Error('network down')]]).movieCandidates({ title: 'Dune' }), (e) => e.code === 'OFFLINE');
});

test('a year that disagrees with a film sinks its score; a one-year slip hurts less', async () => {
  const p = providers([itunes([film(1, 'Heat', '1995-12-15T08:00:00Z'), film(2, 'Heat', '2013-06-28T07:00:00Z')])]);
  const list = await p.movieCandidates({ title: 'Heat', year: 1995 });
  assert.deepEqual(list.map((c) => c.year), [1995, 2013]);
  assert.ok(list[0].score >= ACCEPT.movie && list[1].score < ACCEPT.movie);
});

test('resolving a picked movie works for both sources', async () => {
  const p = providers([
    ['/movie/603', json({ title: 'The Matrix', release_date: '1999-03-30', overview: 'Neo.', vote_average: 8.2, genres: [{ name: 'Action' }], runtime: 136, poster_path: '/p.jpg' })],
    ['itunes.apple.com/lookup', json({ results: [film(9, 'Dune', '2021-10-22T07:00:00Z')] })],
  ], { getTmdbKey: () => 'key' });
  assert.deepEqual(await p.resolveMovie({ provider: 'tmdb', id: 603 }), { title: 'The Matrix', year: 1999, summary: 'Neo.', rating: 8.2, genres: ['Action'], runtime: 136, artUrls: ['https://image.tmdb.org/t/p/w780/p.jpg'] });
  assert.equal((await p.resolveMovie({ provider: 'itunes', id: 9 })).title, 'Dune');
  await assert.rejects(p.resolveMovie({ provider: 'nope', id: 1 }), /Unknown source/);
});

test('images only come from allowed hosts over https, and redirects are checked too', async () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);
  const p = providers([
    ['good.mzstatic.com', { status: 200, bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.length), headers: {} }],
    ['hop.mzstatic.com', { status: 302, headers: { location: 'https://evil.example/x.png' } }],
  ]);
  const img = await p.downloadImage('https://good.mzstatic.com/a.png');
  assert.equal(img.mime, 'image/png');
  await assert.rejects(p.downloadImage('https://evil.example/a.png'), /not allowed/);
  await assert.rejects(p.downloadImage('http://good.mzstatic.com/a.png'), /not allowed/);
  await assert.rejects(p.downloadImage('https://hop.mzstatic.com/a.png'), /not allowed/);
});

test('a reference sent back by the page can never make the server fetch a URL of its choosing', async () => {
  const p = providers([['musicbrainz.org', json({})]]);
  await assert.rejects(p.resolveAlbum({ provider: 'musicbrainz', release: 'https://evil.example/x', group: null }), /Bad reference/);
});

// ----------------------------------------------------------------------------- the enricher

function movieEnricher(films) {
  const events = [];
  const lib = { get: (id) => ({ id }), markTried: (ids) => events.push(['missed', ids]), applyMovie: async (id, a) => events.push([a.meta.title, a.meta.year, a.src]) };
  const p = providers([itunes(films), ['mzstatic.com', { status: 404 }]]); // the poster download finds nothing: the details are still applied
  return { enricher: new Enricher(lib, p), events };
}

test('an unattended movie lookup applies a good match and records where it came from', async () => {
  const { enricher, events } = movieEnricher([film(1, 'Dune', '2021-10-22T07:00:00Z')]);
  assert.equal(await enricher.movie({ id: 'a', title: 'Dune', year: 2021 }), 'found');
  assert.deepEqual(events, [['Dune', 2021, 'iTunes']]);
});

test('a name like "Wonder Woman 1984" is retried with the number as part of the title', async () => {
  const { enricher, events } = movieEnricher([film(1, 'Wonder Woman', '2017-06-02T07:00:00Z'), film(2, 'Wonder Woman 1984', '2020-12-25T08:00:00Z')]);
  assert.equal(await enricher.movie({ id: 'a', title: 'Wonder Woman', year: 1984 }), 'found');
  assert.deepEqual(events, [['Wonder Woman 1984', 2020, 'iTunes']]);
});

test('nothing close enough is recorded as tried, so bulk runs do not keep retrying it', async () => {
  const { enricher, events } = movieEnricher([film(1, 'Something Else Entirely', '1999-01-01T00:00:00Z')]);
  assert.equal(await enricher.movie({ id: 'b', title: 'Nothing Like This', year: 1999 }), 'missed');
  assert.deepEqual(events, [['missed', ['b']]]);
});

test('targets from the page are validated: bad ids are dropped, text is limited', () => {
  const out = cleanTargets([
    { type: 'movie', id: 'abcdef0123456789', title: 'x'.repeat(1000), year: '2001' },
    { type: 'movie', id: '../../etc', title: 'Bad id' },
    { type: 'album', ids: ['abcdef0123456789', 'nothex!'], album: 'Mixed ids' },
    { type: 'show', show: 'Show', episodes: [{ id: 'abcdef0123456789', season: '2', episode: 3 }, { id: 'zz' }] },
    { type: 'mystery' },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title.length, 300);
  assert.equal(out[0].year, 2001);
  assert.deepEqual(out[1].episodes, [{ id: 'abcdef0123456789', season: 2, episode: 3 }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWatchState, buildCollections } from '../../web/js/library.js';
import { buildIndex, fold, search } from '../../web/js/search.js';

bindWatchState(() => ({}));

const tr = (id, title, artist, album, albumArtist, year, dir) => ({ id, kind: 'audio', ext: 'mp3', name: title, title, artist, album, albumArtist, track: 1, disc: 1, year, genre: 'Rock', duration: 200, added: 1, dir, cover: 0, cv: 0, fetched: 0 });
const vid = (id, title, parsed, over = {}) => ({ id, kind: 'video', ext: 'mkv', name: title, title, parsed, fetched: 2, poster: 1, cover: 1, cv: 0, size: 1, mtime: 1, added: 1, dir: 'D:\\V', duration: 7200, ...over });
const photo = (id, name, dir) => ({ id, kind: 'image', ext: 'jpg', name, title: name, size: 1, mtime: new Date('2023-07-01').getTime(), added: 1, dir, cover: 0, cv: 0 });

const items = [
  tr('t1', 'Paranoid Android', 'Radiohead', 'OK Computer', 'Radiohead', 1997, 'M\\OK'), tr('t2', 'Karma Police', 'Radiohead', 'OK Computer', 'Radiohead', 1997, 'M\\OK'),
  tr('t3', 'Everything In Its Right Place', 'Radiohead', 'Kid A', 'Radiohead', 2000, 'M\\KidA'), tr('t4', 'Come Together', 'The Beatles', 'Abbey Road', 'The Beatles', 1969, 'M\\AR'),
  tr('t5', 'Halo', 'Beyoncé', 'I Am... Sasha Fierce', 'Beyoncé', 2008, 'M\\IA'),
  ...Array.from({ length: 20 }, (_, i) => tr(`g${i}`, `Song ${i}`, `Band ${i}`, 'Greatest Hits', '', 2000 + i, `M\\GH${i}`)),
  vid('m1', 'Dune', { type: 'movie', title: 'Dune', year: 2021 }, { meta: { genres: ['Science Fiction'], year: 2021 } }),
  vid('m2', 'Wonder Woman', { type: 'movie', title: 'Wonder Woman' }), vid('m3', 'Wonder Woman 1984', { type: 'movie', title: 'Wonder Woman 1984' }),
  ...[1, 2].map((n) => vid(`e${n}`, `Pilot ${n}`, { type: 'episode', show: 'Doctor Who', title: 'Doctor Who', season: 1, episode: n, year: 2005 })),
  vid('k1', 'IMG_2043', { type: 'clip', title: 'IMG 2043' }, { fetched: 0, poster: 0 }),
  photo('p1', 'DSC001', 'D:\\Pictures\\Holiday 2023'), photo('p2', 'DSC002', 'D:\\Pictures\\Holiday 2023'), photo('p3', 'Birthday', 'D:\\Pictures\\Family'),
];
const docs = buildIndex(buildCollections(items));
const flat = (q) => search(docs, q).groups.flatMap((g) => g.items.map((d) => `${d.kind}:${d.title}`));

test('every word of the query has to match, in any order', () => {
  assert.deepEqual(flat('karma police'), ['track:Karma Police']);
  assert.deepEqual(flat('police karma'), ['track:Karma Police']);
  assert.deepEqual(flat('karma xyz'), []);
});

test('partial words match from the start of a word; short fragments inside a word only from three letters', () => {
  assert.deepEqual(flat('karma pol'), ['track:Karma Police']);
  assert.deepEqual(flat('omp'), ['album:OK Computer'], 'the substring "omp" finds the album title');
  assert.deepEqual(flat('ok'), ['album:OK Computer']);
  assert.deepEqual(flat('mp'), [], 'two letters mid-word are too loose to match');
});

test('accents, case and punctuation do not matter', () => {
  assert.equal(fold('  Beyoncé!! '), 'beyonce');
  assert.deepEqual(flat('BEYONCE'), ['album:I Am... Sasha Fierce', 'track:Halo']);
});

test('the artist, year and genre also match, narrowing the results', () => {
  const artist = flat('radiohead');
  assert.ok(artist.includes('album:OK Computer') && artist.includes('album:Kid A') && artist.includes('track:Karma Police'));
  assert.deepEqual(flat('radiohead 1997'), ['album:OK Computer']);
  assert.deepEqual(flat('dune science'), ['movie:Dune']);
});

test('searching an album name finds the album, not every song on it', () => {
  assert.ok(!flat('ok computer').some((r) => r.startsWith('track:')));
});

test('an exact title ranks above a longer one that contains it', () => {
  assert.deepEqual(flat('wonder woman'), ['movie:Wonder Woman', 'movie:Wonder Woman 1984']);
  assert.deepEqual(flat('wonder woman 1984'), ['movie:Wonder Woman 1984']);
});

test('shows, clips, photo folders and photos are all found, albums first', () => {
  assert.deepEqual(flat('doctor who'), ['show:Doctor Who']);
  assert.deepEqual(flat('img'), ['clip:IMG 2043']);
  assert.deepEqual(flat('holiday'), ['folder:Holiday 2023', 'photo:DSC001', 'photo:DSC002']);
});

test('long result lists are cut per group, with the real total kept for the heading', () => {
  const { groups } = search(docs, 'greatest hits');
  const albums = groups.find((g) => g.id === 'album');
  assert.deepEqual([albums.items.length, albums.total], [6, 20]);
  assert.equal(groups.find((g) => g.id === 'track'), undefined);
});

test('blank queries and nonsense find nothing; every hit points at something that can be opened', () => {
  assert.deepEqual(search(docs, '   '), { groups: [], total: 0 });
  assert.equal(search(docs, 'xyzzy').total, 0);
  for (const g of search(docs, 'radiohead').groups) for (const d of g.items) assert.ok(d.entry && d.shelf, d.title);
  assert.deepEqual(search(docs, 'karma').groups[0].items[0].track.id, 't2');
});

test('the index builds over a big library and one search stays fast', () => {
  const big = Array.from({ length: 50000 }, (_, i) => ({ kind: 'track', title: `Track ${i}`, t: fold(`Track number ${i} of the collection`), o: fold(`Artist ${i % 500} Album ${i % 2000}`) }));
  const t0 = performance.now();
  const { total } = search(big, 'artist 77 album');
  assert.ok(total > 0);
  assert.ok(performance.now() - t0 < 1000, 'a search over 50,000 songs should take well under a second');
});

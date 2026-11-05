import test from 'node:test';
import assert from 'node:assert/strict';
import { baseCategory, bindWatchState, buildCollections, buildContinue, describe, entryIds, FINISHED, isFinished, isSpoken, isSpokenTrack, jumpLabel, lookupTarget, nextEpisode, noCoverArt, noOnlineArt, watchInfo } from '../../web/js/library.js';
import { fmtBytes, fmtLong, fmtTime } from '../../web/js/util.js';

// ------------------------------------------------------------------ fixtures

const prefs = { progress: {}, watched: {}, lastPlayed: {} };
bindWatchState(() => prefs);
const reset = () => { for (const k of Object.keys(prefs)) prefs[k] = {}; };

const track = (id, over = {}) => ({ id, kind: 'audio', ext: 'mp3', name: `Track ${id}`, title: `Track ${id}`, artist: 'Artist', album: 'Album', albumArtist: '', track: 1, disc: 1, year: 2000, genre: 'Rock', duration: 200, added: 1, dir: 'M\\Artist\\Album', cover: 0, cv: 0, fetched: 0, ...over });
const video = (id, title, parsed, over = {}) => ({ id, kind: 'video', ext: 'mkv', name: title, title, parsed, fetched: 2, poster: 1, cover: 1, cv: 0, size: 1, mtime: 1, added: 1, dir: 'D:\\V', duration: 7200, ...over });
const movie = (title, over) => video(title, title, { type: 'movie', title }, over);
const episode = (show, n, over = {}) => video(`${show}-${n}`, `${show} ${n}`, { type: 'episode', show, title: show, season: 1, episode: n }, { duration: 2400, ...over });
const photo = (id, name, dir, mtime = '2023-07-01', over = {}) => ({ id, kind: 'image', ext: 'jpg', name, title: name, size: 1, mtime: new Date(mtime).getTime(), added: 1, dir, cover: 0, cv: 0, ...over });
const titles = (list) => list.map((e) => e.title);

// -------------------------------------------------------------------- music

test('albums: tracks are ordered by disc then track, and CD1/CD2 folders are one album', () => {
  const cols = buildCollections([
    track('b', { track: 2, disc: 1, dir: 'M\\X\\CD1' }), track('a', { track: 1, disc: 1, dir: 'M\\X\\CD1' }),
    track('d', { track: 1, disc: 2, dir: 'M\\X\\CD2' }), track('c', { track: 3, disc: 1, dir: 'M\\X\\CD1' }),
  ]);
  assert.equal(cols.music.length, 1);
  assert.deepEqual(cols.music[0].tracks.map((t) => t.id), ['a', 'b', 'c', 'd']);
});

test('albums: a mix of artists without an album artist is "Various Artists"; one album artist overrides', () => {
  const mixed = buildCollections([track('1', { artist: 'A', dir: 'M\\V' }), track('2', { artist: 'B', dir: 'M\\V' })]).music[0];
  assert.deepEqual([mixed.artist, mixed.variousArtists], ['Various Artists', true]);
  const compilation = buildCollections([track('1', { artist: 'A', albumArtist: 'Label', dir: 'M\\V' }), track('2', { artist: 'B', albumArtist: 'Label', dir: 'M\\V' })]).music[0];
  assert.deepEqual([compilation.artist, compilation.variousArtists], ['Label', false]);
});

test('albums: same title by different artists, or in different folders, stay separate', () => {
  const cols = buildCollections([
    track('1', { albumArtist: 'A', album: 'Greatest Hits' }), track('2', { albumArtist: 'B', album: 'Greatest Hits' }),
    track('3', { album: 'Untitled', dir: 'M\\one' }), track('4', { album: 'Untitled', dir: 'M\\two' }),
  ]);
  assert.equal(cols.music.length, 4);
});

test('albums: art, year and genre come from whichever track has them, and shelves can be sorted', () => {
  const cols = buildCollections([track('1', { year: undefined, genre: undefined, cover: 0 }), track('2', { year: 1997, genre: 'Pop', cover: 1, cv: 4 })]);
  const a = cols.music[0];
  assert.deepEqual([a.year, a.genre, a.coverId, a.coverV], [1997, 'Pop', '2', 4]);
  const two = buildCollections([track('1', { album: 'B', albumArtist: 'Z', added: 5, dir: 'M\\1' }), track('2', { album: 'A', albumArtist: 'Y', added: 9, dir: 'M\\2' })], { music: 'added' });
  assert.deepEqual(titles(two.music), ['A', 'B']);
  assert.deepEqual(titles(buildCollections([track('1', { album: 'B', albumArtist: 'Z', dir: 'M\\1' }), track('2', { album: 'A', albumArtist: 'Y', dir: 'M\\2' })], { music: 'title' }).music), ['A', 'B']);
});

// ------------------------------------------------------------------- videos

test('videos: movies are separate entries, episodes gather into one show per name', () => {
  const cols = buildCollections([movie('Dune'), episode('Doctor Who', 2), episode('Doctor Who', 1), episode('The Doctor Who', 3)]);
  const shows = [...cols.video, ...cols.unmatched].filter((e) => e.kind === 'show');
  assert.equal(shows.length, 1, '"The" is ignored when grouping');
  assert.deepEqual(shows[0].episodes.map((e) => e.parsed.episode), [1, 2, 3]);
  assert.equal(shows[0].episodes[0].displayTitle, 'Doctor Who · S01E01');
});

test('videos: the looked-up show name wins, so differently spelled files land in one show', () => {
  const meta = { show: { name: 'Doctor Who' }, src: 'TVMaze' };
  const cols = buildCollections([episode('Doctor Who', 1, { meta }), episode('doctor.who', 2, { meta })]);
  assert.equal([...cols.video, ...cols.unmatched].filter((e) => e.kind === 'show').length, 1);
});

test('videos with no online artwork get their own shelf; ones not yet looked up stay in Videos', () => {
  const cols = buildCollections([
    movie('Matched', { fetched: 2, poster: 1 }),
    movie('Missed', { fetched: 1, poster: 0 }),
    movie('Pending', { fetched: 0, poster: 0 }),
    movie('Details only', { fetched: 2, poster: 0 }),
    video('clip', 'IMG_1', { type: 'clip', title: 'IMG 1' }, { fetched: 0, poster: 0 }),
    episode('Lost Show', 1, { fetched: 1, poster: 0 }),
    episode('Found Show', 1, { fetched: 2, poster: 1 }),
  ]);
  assert.deepEqual(titles(cols.video).sort(), ['Found Show', 'Matched', 'Pending']);
  assert.deepEqual(titles(cols.unmatched).sort(), ['Details only', 'IMG 1', 'Lost Show', 'Missed']);
  assert.equal(noOnlineArt(cols.video.find((e) => e.title === 'Matched')), false);
});

test('a movie shows its looked-up title and year; the shelf sorts by name, recency or length', () => {
  const m = buildCollections([movie('raw name', { meta: { title: 'Real Title', year: 2001 } })]).video[0];
  assert.deepEqual([m.title, m.displayTitle], ['Real Title', 'Real Title (2001)']);
  const by = (sort) => titles(buildCollections([movie('B', { added: 1, duration: 10 }), movie('A', { added: 5, duration: 99 }), movie('C', { added: 3, duration: 50 })], { video: sort }).video);
  assert.deepEqual([by('title'), by('added'), by('duration')], [['A', 'B', 'C'], ['A', 'C', 'B'], ['A', 'C', 'B']]);
});

test('the Continue and No artwork shelves behave as Videos in every way that depends on the kind of shelf', () => {
  assert.deepEqual(['continue', 'unmatched', 'video', 'music', 'photo', 'albums'].map(baseCategory), ['video', 'video', 'video', 'music', 'photo', 'albums']);
  const e = buildCollections([movie('Dune', { parsed: { type: 'movie', title: 'Dune', year: 2021 } })]).video[0];
  assert.deepEqual(lookupTarget('continue', e), lookupTarget('video', e));
  assert.deepEqual(lookupTarget('video', e), { type: 'movie', id: 'Dune', title: 'Dune', year: 2021 });
  assert.equal(lookupTarget('video', buildCollections([video('c', 'c', { type: 'clip', title: 'c' }, { fetched: 0, poster: 0 })]).unmatched[0]), null);
  assert.equal(lookupTarget('photo', photo('p', 'p', 'D')), null);
});

// ----------------------------------------------------------------- watching

test('a video counts as finished near the end, but never because it is short or just started', () => {
  assert.equal(FINISHED, 0.92);
  assert.deepEqual([[6700, 7200], [5000, 7200], [7190, 7200], [0, 7200], [25, 30], [8, 9], [3, 5]].map(([t, l]) => isFinished(t, l)), [true, false, true, false, true, false, false]);
});

test('Continue: unfinished movies and part-watched shows, most recently played first; finished and untouched ones are left out', () => {
  reset();
  const cols = buildCollections([
    movie('Half Seen'), movie('Done'), movie('Untouched'),
    ...[1, 2, 3, 4].map((n) => episode('Mid Show', n)), ...[1, 2].map((n) => episode('Finished Show', n)), ...[1, 2, 3].map((n) => episode('Playing Show', n)),
    video('k1', 'IMG_1', { type: 'clip', title: 'IMG 1' }, { fetched: 0, poster: 0 }),
  ]);
  Object.assign(prefs.progress, { 'Half Seen': 1800, 'Playing Show-2': 600, k1: 90 });
  Object.assign(prefs.lastPlayed, { 'Half Seen': 1000, 'Playing Show-2': 2000, k1: 3000, 'Mid Show-2': 200 });
  Object.assign(prefs.watched, { Done: 500, 'Mid Show-1': 100, 'Mid Show-2': 200, 'Finished Show-1': 300, 'Finished Show-2': 310 });
  assert.deepEqual(titles(buildContinue(cols)), ['IMG 1', 'Playing Show', 'Half Seen', 'Mid Show']);
  // marking the rest of Mid Show watched takes it off the shelf
  prefs.watched['Mid Show-3'] = prefs.watched['Mid Show-4'] = 400;
  assert.deepEqual(titles(buildContinue(cols)), ['IMG 1', 'Playing Show', 'Half Seen']);
});

test('which episode plays next: the one in progress, else the one after the latest finished, else the first unwatched, else the start', () => {
  reset();
  const show = (name) => buildCollections([1, 2, 3, 4].map((n) => episode(name, n))).video.find((e) => e.kind === 'show');
  const s = show('S');
  assert.equal(nextEpisode(s), 0);
  prefs.watched['S-1'] = 100; prefs.watched['S-2'] = 200;
  assert.equal(nextEpisode(s), 2);
  prefs.progress['S-4'] = 50; prefs.lastPlayed['S-4'] = 9;
  assert.equal(nextEpisode(s), 3, 'an episode in progress comes first');
  delete prefs.progress['S-4'];
  prefs.watched['S-3'] = 300; prefs.watched['S-4'] = 400;
  assert.equal(nextEpisode(s), 0, 'everything watched: start again');
  delete prefs.watched['S-2'];
  assert.equal(nextEpisode(s), 1, 'with a gap behind the latest, the first unwatched one');
});

test('cards say how far through a movie or show you are, and what is next', () => {
  reset();
  const cols = buildCollections([movie('Half Seen'), movie('Done'), ...[1, 2, 3].map((n) => episode('Mid Show', n))]);
  prefs.progress['Half Seen'] = 1800;
  prefs.watched.Done = 1; prefs.watched['Mid Show-1'] = 1;
  const by = (t) => cols.video.find((e) => e.title === t);
  const half = describe('continue', by('Half Seen'));
  assert.deepEqual([half.progress, half.watched, half.subtitle], [0.25, false, 'Resume at 30:00 of 2:00:00']);
  assert.deepEqual([describe('video', by('Done')).watched, describe('video', by('Done')).chips[0]], [true, 'Watched']);
  const mid = describe('continue', by('Mid Show'));
  assert.deepEqual([+mid.progress.toFixed(2), mid.subtitle], [0.33, 'Up next: S01E02']);
  assert.deepEqual(watchInfo(by('Mid Show')).watched, false);
});

test('watching a movie again does not show the finished tick while it is part-way through', () => {
  reset();
  const m = buildCollections([movie('Again')]).video[0];
  prefs.watched.Again = 1; prefs.progress.Again = 600;
  assert.deepEqual([describe('video', m).watched, describe('video', m).progress > 0], [false, true]);
});

// -------------------------------------------------------------------- photos

test('photo albums: one per folder, ordered by name, same-named folders kept apart, newest first', () => {
  const cols = buildCollections([
    photo('a1', 'IMG_0002', 'D:\\P\\Holiday 2023', '2023-07-10'), photo('a2', 'IMG_0001', 'D:\\P\\Holiday 2023', '2023-07-09', { cover: 1, cv: 3 }), photo('a3', 'IMG_0010', 'D:\\P\\Holiday 2023', '2023-08-02'),
    photo('b1', 'Cake', 'D:\\P\\Family\\Birthday', '2024-01-05'), photo('c1', 'Scan', 'D:\\P\\Birthday', '2019-03-10'),
  ]);
  assert.equal(cols.photo.length, 5, 'the Photos shelf stays flat');
  assert.deepEqual(cols.albums.map((a) => `${a.title}@${a.parent}`), ['Birthday@Family', 'Holiday 2023@P', 'Birthday@P']);
  const holiday = cols.albums.find((a) => a.title === 'Holiday 2023');
  assert.deepEqual(holiday.photos.map((p) => p.name), ['IMG_0001', 'IMG_0002', 'IMG_0010']);
  assert.equal(holiday.coverPhoto.id, 'a2', 'the cover is a photo that already has a thumbnail');
  const d = describe('albums', holiday);
  assert.deepEqual([d.title, d.subtitle, d.cover, d.chips[0]], ['Holiday 2023', 'in P', '/cover/a2?v=3', '3 photos']);
  assert.equal(describe('albums', cols.albums[0]).cover, null, 'no thumbnail yet: a placeholder, not a full-size photo');
  assert.deepEqual(titles(buildCollections([photo('1', 'x', 'D:\\Z'), photo('2', 'y', 'D:\\A')], { albums: 'title' }).albums), ['A', 'Z']);
});

test('photos sort by modified time or name', () => {
  const items = [photo('1', 'b', 'D', '2020-01-01'), photo('2', 'a', 'D', '2022-01-01')];
  assert.deepEqual(buildCollections(items).photo.map((p) => p.name), ['a', 'b']);
  assert.deepEqual(buildCollections(items, { photo: 'title' }).photo.map((p) => p.name), ['a', 'b']);
  assert.deepEqual(buildCollections([photo('1', 'z', 'D', '2024-01-01'), photo('2', 'a', 'D', '2020-01-01')], { photo: 'date' }).photo.map((p) => p.name), ['z', 'a']);
});

// --------------------------------------------------------------- small pieces

test('type-to-jump uses the artist when music is sorted by artist, the title otherwise', () => {
  const album = { artist: 'Radiohead', title: 'Kid A' };
  assert.equal(jumpLabel('music', 'artist', album), 'Radiohead');
  assert.equal(jumpLabel('music', 'title', album), 'Kid A');
  assert.equal(jumpLabel('video', 'title', { title: 'Dune' }), 'Dune');
});

test('removing a shelf entry clears all of its files: every track of an album, every episode of a show', () => {
  const cols = buildCollections([track('1'), track('2'), episode('S', 1), episode('S', 2)]);
  assert.deepEqual(entryIds('music', cols.music[0]).sort(), ['1', '2']);
  assert.deepEqual(entryIds('video', cols.video.find((e) => e.kind === 'show')).sort(), ['S-1', 'S-2']);
});

test('durations and sizes are written for people, with no "1 hr 60 min"', () => {
  assert.deepEqual([7185, 3590, 5400, 7140, 59, 0, NaN].map(fmtLong), ['2 hr 0 min', '1 hr 0 min', '1 hr 30 min', '1 hr 59 min', '1 min', '', '']);
  assert.deepEqual([0, 59, 61, 3661, -1, NaN].map(fmtTime), ['0:00', '0:59', '1:01', '1:01:01', '–:––', '–:––']);
  assert.deepEqual([0, 500, 1536, 5_000_000, 3e9].map(fmtBytes), ['', '500 B', '2 KB', '4.8 MB', '2.8 GB']);
});

test('albums with no cover art get their own shelf, but only once there is nothing more to find', () => {
  const cols = buildCollections([
    track('1', { album: 'Has Art', dir: 'M/A', cover: 1, cv: 2 }),
    track('2', { album: 'Looked Up', dir: 'M/B', fetched: 1 }), // looked up, nothing found
    track('3', { album: 'Waiting', dir: 'M/C', fetched: 0 }), // not looked up yet: stays in Music
    track('4', { album: '', dir: 'M/D' }), // no album tag: nothing to look up
    track('5', { album: 'Found Online', dir: 'M/E', fetched: 2, cover: 1, cv: 1 }),
  ]);
  assert.deepEqual(cols.music.map((a) => a.title).sort(), ['Found Online', 'Has Art', 'Waiting']);
  assert.deepEqual(cols.nocover.map((a) => a.title).sort(), ['Looked Up', 'Unknown Album']);
  assert.equal(cols.music.length + cols.nocover.length, 5, 'no album is on both shelves, or neither');
  assert.equal(noCoverArt(cols.nocover[0]), true);
  assert.equal(noCoverArt(cols.music[0]), false);
});

test('the No cover art shelf behaves like Music: same cards, lookups, sorts and ids', () => {
  assert.equal(baseCategory('nocover'), 'music');
  const [a] = buildCollections([track('1', { album: 'Quiet', dir: 'M/Q', fetched: 1 })], { nocover: 'title' }).nocover;
  assert.equal(describe('nocover', a).title, 'Quiet');
  assert.equal(describe('nocover', a).cover, null);
  assert.deepEqual(lookupTarget('nocover', a), lookupTarget('music', a));
  assert.deepEqual(entryIds('nocover', a), a.ids);
  assert.equal(jumpLabel('nocover', 'artist', a), a.artist);
});

test('an album moves shelves when its cover appears, and back when it is lost', () => {
  const noArt = [track('1', { album: 'Mover', dir: 'M/M', fetched: 1 })];
  assert.equal(buildCollections(noArt).nocover.length, 1);
  const withArt = [track('1', { album: 'Mover', dir: 'M/M', fetched: 2, cover: 1, cv: 1 })];
  const cols = buildCollections(withArt);
  assert.deepEqual([cols.music.length, cols.nocover.length], [1, 0]);
});

test('audiobooks and podcasts are told apart from music by file type, genre or folder name, and nothing else', () => {
  const t = (over) => track('x', over);
  assert.equal(isSpokenTrack(t({ ext: 'm4b' })), true);
  assert.equal(isSpokenTrack(t({ genre: 'Audiobook' })), true);
  assert.equal(isSpokenTrack(t({ genre: 'Podcast' })), true);
  assert.equal(isSpokenTrack(t({ genre: 'Spoken Word' })), true);
  assert.equal(isSpokenTrack(t({ dir: 'F:\\Audio\\Audiobooks\\Dune' })), true, 'a Windows folder path');
  assert.equal(isSpokenTrack(t({ dir: '/home/me/Podcasts/Show' })), true, 'a Unix folder path');
  assert.equal(isSpokenTrack(t({ dir: 'F:\\Music\\Podcast Hits', genre: 'Pop' })), false, 'only a whole folder name counts');
  assert.equal(isSpokenTrack(t({ genre: 'Speechless Rock' })), false, 'only whole words count');
  assert.equal(isSpokenTrack(t({ genre: 'Rock', ext: 'mp3', duration: 40000 })), false, 'a long track is not enough');
});

test('the Spoken shelf keeps audiobooks and podcasts out of Music and No cover art, and behaves like Music', () => {
  const cols = buildCollections([
    track('1', { album: 'Song Album', dir: 'M/S', cover: 1, cv: 1 }),
    track('2', { album: 'Quiet Album', dir: 'M/Q', fetched: 1 }),
    track('3', { album: 'Dune', artist: 'Frank Herbert', ext: 'm4b', dir: 'M/Books/Dune', fetched: 1 }), // no cover, yet still Spoken
    track('4', { album: 'Dune', artist: 'Frank Herbert', ext: 'm4b', dir: 'M/Books/Dune', track: 2 }),
    track('5', { album: 'Daily Show', artist: 'Host', genre: 'Podcast', dir: 'M/Pod' }),
  ]);
  assert.deepEqual(cols.spoken.map((a) => a.title).sort(), ['Daily Show', 'Dune']);
  assert.deepEqual(cols.music.map((a) => a.title), ['Song Album']);
  assert.deepEqual(cols.nocover.map((a) => a.title), ['Quiet Album']);
  assert.equal(baseCategory('spoken'), 'music');
  assert.deepEqual(lookupTarget('spoken', cols.spoken.find((a) => a.title === 'Dune')).album, 'Dune');
  const mixed = buildCollections([track('1', { album: 'Mixed', dir: 'M/X', ext: 'm4b' }), track('2', { album: 'Mixed', dir: 'M/X' }), track('3', { album: 'Mixed', dir: 'M/X' })]);
  assert.deepEqual([mixed.spoken.length, mixed.music.length + mixed.nocover.length], [0, 1], 'an album is spoken only when most of its tracks are');
  assert.equal(isSpoken(cols.spoken[0]), true);
});

test('music can be grouped by folder and tags, by tags alone (one album spread over folders), or by artist', () => {
  const items = [
    track('1', { album: 'Split', artist: 'Band', dir: 'M/Band/Disc A', track: 1 }),
    track('2', { album: 'Split', artist: 'Band', dir: 'M/Other place', track: 2 }),
    track('3', { album: '', artist: 'Band', dir: 'M/Loose', track: 1, title: 'Single' }),
    track('4', { album: 'Solo', artist: 'Singer', dir: 'M/Singer', track: 1 }),
  ];
  const titles = (cols) => cols.music.concat(cols.nocover).map((a) => a.title).sort();
  const byFolder = buildCollections(items);
  assert.equal(byFolder.music.concat(byFolder.nocover).length, 4, 'the default keeps folders apart: the split album is two albums');
  const byTags = buildCollections(items, {}, { group: 'tags' });
  assert.deepEqual(titles(byTags), ['Solo', 'Split', 'Unknown Album'], 'ignoring folders: one Split with both tracks, and the loose track by its artist');
  assert.equal(byTags.music.find((a) => a.title === 'Split').tracks.length, 2);
  const byArtist = buildCollections(items, {}, { group: 'artist' });
  assert.deepEqual(titles(byArtist), ['Band', 'Singer']);
  const band = byArtist.music.find((a) => a.title === 'Band');
  assert.equal(band.tracks.length, 3);
  assert.equal(band.artist, '2 albums', 'albums are counted, the loose track has no album');
  assert.deepEqual(band.ids, band.tracks.map((t) => t.id));
  assert.equal(describe('music', band).title, 'Band');
  assert.equal(lookupTarget('music', band), null, 'an artist is not looked up as an album');
  assert.equal(byArtist.nocover.length, 0, 'artists are never moved to No cover art');
  assert.deepEqual(buildCollections(items, {}, { group: 'nonsense' }).music.length + buildCollections(items, {}, { group: 'nonsense' }).nocover.length, 4, 'an unknown mode is the default');
});

test('artists are sorted by name, not by the album count that is shown under them', () => {
  const items = [track('1', { artist: 'Zed', album: 'A' }), track('2', { artist: 'Abe', album: 'A', dir: 'M/2' }), track('3', { artist: 'Abe', album: 'B', dir: 'M/3' })];
  const cols = buildCollections(items, { music: 'artist' }, { group: 'artist' });
  assert.deepEqual(cols.music.map((a) => a.title), ['Abe', 'Zed']);
  assert.equal(jumpLabel('music', 'artist', cols.music[0]), 'Abe');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeTags } = require('../../server/tagwrite.js');
const { readTags } = require('../../server/tags.js');
const { WriteBack } = require('../../server/writeback.js');
const { Library } = require('../../server/library.js');
const { createProviders } = require('../../server/providers.js');
const { SongIdentifier, parseName, songQuery, sameAs } = require('../../server/songs.js');
const { tmp, scanned } = require('../support.js');

const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const audio = () => crypto.randomBytes(3000);

function mp3(file, frames, body = audio()) {
  const tag = Buffer.concat(frames.map(([id, text]) => {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), data]);
  }));
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synchsafe(tag.length), tag, body]));
  return body;
}

function flacWith(file, comments, body = audio()) {
  const le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const vendor = Buffer.from('test');
  const vc = Buffer.concat([le(vendor.length), vendor, le(comments.length), ...comments.map((c) => Buffer.concat([le(Buffer.byteLength(c)), Buffer.from(c)]))]);
  const head = (type, last, len) => Buffer.from([(last ? 0x80 : 0) | type, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC'), head(0, false, 34), Buffer.alloc(34), head(4, true, vc.length), vc, body]));
  return body;
}

const bodyOf = (file, body) => fs.readFileSync(file).subarray(fs.readFileSync(file).length - body.length);

test('MP3: approved fields replace what the file says, other tags stay, and the audio is byte-for-byte the same', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.mp3');
    const body = mp3(file, [['TIT2', 'wrong title'], ['TPE1', 'wrong'], ['TALB', 'Keep Me?'], ['TCOM', 'Composer']]);
    const r = await writeTags(file, { set: { title: 'Right Title', artist: 'Right Artist', album: 'Right Album', track: 3, trackCount: 12, year: 1999, genre: 'Rock' } });
    assert.equal(r.changed, true);
    assert.deepEqual(bodyOf(file, body), body);
    const tags = await readTags(file, 'mp3');
    assert.deepEqual([tags.title, tags.artist, tags.album, tags.track, tags.year, tags.genre], ['Right Title', 'Right Artist', 'Right Album', 3, 1999, 'Rock']);
    assert.ok(fs.readFileSync(file).toString('latin1').includes('Composer'), 'a frame that was not touched is still there');
    const again = await writeTags(file, { set: { title: 'Right Title', artist: 'Right Artist', album: 'Right Album', track: 3, trackCount: 12, year: 1999, genre: 'Rock' } });
    assert.deepEqual([again.changed, again.reason], [false, 'already complete'], 'values that are already right change nothing');
  } finally {
    t.cleanup();
  }
});

test('MP3: unicode titles are written and read back, and empty values never blank a field', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'u.mp3');
    mp3(file, [['TIT2', 'old'], ['TPE1', 'Someone']]);
    await writeTags(file, { set: { title: 'Corazón — Ñandú', artist: '', album: undefined } });
    const tags = await readTags(file, 'mp3');
    assert.equal(tags.title, 'Corazón — Ñandú');
    assert.equal(tags.artist, 'Someone');
  } finally {
    t.cleanup();
  }
});

test('FLAC: approved fields replace the comments (any letter case), and the audio is untouched', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.flac');
    const body = flacWith(file, ['title=wrong', 'ARTIST=wrong', 'Date=1970', 'COMMENT=keep']);
    const r = await writeTags(file, { set: { title: 'Right', artist: 'Band', album: 'Record', track: 2, year: 2001, genre: 'Pop' } });
    assert.equal(r.changed, true);
    assert.deepEqual(bodyOf(file, body), body);
    const tags = await readTags(file, 'flac');
    assert.deepEqual([tags.title, tags.artist, tags.album, tags.track, tags.year, tags.genre], ['Right', 'Band', 'Record', 2, 2001, 'Pop']);
    assert.ok(fs.readFileSync(file).toString('latin1').includes('COMMENT=keep'));
    assert.equal((fs.readFileSync(file).toString('latin1').match(/title=|TITLE=/gi) || []).length, 1, 'the old comment is gone, not duplicated');
  } finally {
    t.cleanup();
  }
});

test('file names become searches: track numbers, underscores and "Artist - Title" are understood, tags win when present', () => {
  assert.deepEqual(parseName('Some Band - Some Song (Official Video) [HD]'), { artist: 'Some Band', title: 'Some Song' });
  assert.deepEqual(parseName('just_a_title'), { artist: '', title: 'just a title' });
  assert.deepEqual(parseName('A - B - C'), { artist: '', title: 'A - B - C' }, 'ambiguous names are not split');
  const it = (over) => ({ path: 'M/Band/Rec/03 - Band - Track.mp3', fileTitle: 'Band - Track', dirArtist: 'Folder Artist', dirAlbum: 'Rec', ...over });
  assert.deepEqual(songQuery(it({})), { title: 'Track', artist: 'Band', album: 'Rec' });
  assert.deepEqual(songQuery(it({ title: 'Tagged', artist: 'Tagger', album: 'Tagged Album' })), { title: 'Tagged', artist: 'Tagger', album: 'Tagged Album' });
  assert.deepEqual(songQuery(it({ fileTitle: 'Only Title' })), { title: 'Only Title', artist: 'Folder Artist', album: 'Rec' }, 'with nothing else the folder names the artist');
  assert.equal(sameAs({ title: 'A', artist: 'B', album: 'C' }, { title: 'a', artist: 'b', album: 'c' }), true);
  assert.equal(sameAs({ title: 'A', artist: 'B', album: 'C' }, { title: 'A', artist: 'B', album: 'D' }), false);
});

test('iTunes song results are scored by how well title and artist match, and a wrong artist cannot look confident', async () => {
  const results = [
    { trackName: 'Karma Police', artistName: 'Radiohead', collectionName: 'OK Computer', trackNumber: 6, trackCount: 12, releaseDate: '1997-05-21T07:00:00Z', primaryGenreName: 'Alternative', artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg' },
    { trackName: 'Karma Police', artistName: 'Some Cover Band', collectionName: 'Tribute', trackNumber: 1, releaseDate: '2010-01-01T00:00:00Z' },
  ];
  const fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results }) });
  const p = createProviders({ fetch, gaps: {}, retryMs: 1 });
  const found = await p.songCandidates({ title: 'Karma Police', artist: 'Radiohead' });
  assert.equal(found[0].artist, 'Radiohead');
  assert.ok(found[0].score >= 0.82 && found[1].score < found[0].score - 0.2);
  assert.deepEqual([found[0].album, found[0].track, found[0].year, found[0].genre], ['OK Computer', 6, 1997, 'Alternative']);
  assert.match(found[0].artUrl, /600x600bb\.jpg$/);
});

// ---- the whole flow: identify, approve, write, undo ----

async function setup(t, candidatesFor) {
  const music = path.join(t.dir, 'music', 'Mixed Folder');
  fs.mkdirSync(music, { recursive: true });
  const bodies = {
    one: mp3(path.join(music, '01 - Karma Police.mp3'), [['TIT2', 'Karma Police'], ['TPE1', 'unknown artist']]),
    two: mp3(path.join(music, 'Blur - Song 2.mp3'), []),
    three: mp3(path.join(music, 'Mystery.mp3'), [['TIT2', 'zzzz not a song']]),
  };
  fs.writeFileSync(path.join(music, 'Voice.m4a'), 'not really audio');
  const lib = new Library(path.join(t.dir, 'data'));
  await lib.addRoot(path.join(t.dir, 'music'));
  await scanned(lib);
  const wb = new WriteBack(lib, path.join(t.dir, 'data'));
  const providers = { songCandidates: async (q) => candidatesFor(q), firstImage: async () => null };
  return { lib, wb, songs: new SongIdentifier(lib, providers, wb), bodies, music };
}

const cand = (over) => ({ title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', track: 6, trackCount: 12, year: 1997, genre: 'Alternative', source: 'iTunes', score: 0.95, ...over });
const finished = async (songs) => { for (let i = 0; i < 400 && songs.state.active; i++) await new Promise((r) => setTimeout(r, 15)); };

test('songs from different artists in one folder are each identified, proposed, and only written once approved', async () => {
  const t = tmp();
  let ctx;
  try {
    ctx = await setup(t, (q) => (/karma/i.test(q.title) ? [cand({})] : /song 2/i.test(q.title) ? [cand({ title: 'Song 2', artist: 'Blur', album: 'Blur', track: 2, year: 1997, genre: 'Rock' })] : []));
    const ids = [...ctx.lib.items.values()].filter((i) => i.kind === 'audio').map((i) => i.id);
    assert.equal(ctx.songs.start(ids), 4);
    await finished(ctx.songs);
    const snap = ctx.songs.snapshot();
    assert.deepEqual([snap.active, snap.done, snap.total], [false, 4, 4]);
    const byName = Object.fromEntries(snap.results.map((r) => [r.name, r]));
    assert.equal(byName['01 - Karma Police.mp3'].status, 'found');
    assert.equal(byName['01 - Karma Police.mp3'].candidates[0].artist, 'Radiohead');
    assert.equal(byName['Blur - Song 2.mp3'].status, 'found', 'a song with no tags is found from its file name');
    assert.equal(byName['Blur - Song 2.mp3'].query.artist, 'Blur');
    assert.equal(byName['Mystery.mp3'].status, 'none');
    assert.equal(byName['Voice.m4a'].writable, false);
    assert.ok(!JSON.stringify(snap).includes('artUrl'), 'artwork addresses stay on the server');

    // Nothing has touched the files yet.
    const one = [...ctx.lib.items.values()].find((i) => i.fileTitle === 'Karma Police');
    assert.equal((await readTags(one.path, 'mp3')).artist, 'unknown artist');

    const out = await ctx.songs.apply([{ id: one.id, pick: 0 }, { id: byName['Blur - Song 2.mp3'].id, pick: 0 }]);
    assert.deepEqual([out.wrote, out.failed], [2, 0]);
    const tags = await readTags(one.path, 'mp3');
    assert.deepEqual([tags.title, tags.artist, tags.album, tags.track, tags.year, tags.genre], ['Karma Police', 'Radiohead', 'OK Computer', 6, 1997, 'Alternative']);
    assert.equal(bodyOf(one.path, ctx.bodies.one).equals(ctx.bodies.one), true, 'the audio is untouched');
    assert.equal(ctx.lib.toClient(ctx.lib.get(one.id)).artist, 'Radiohead', 'the library shows the new details at once');
    assert.equal(ctx.songs.results.get(one.id).status, 'applied');

    // Undo puts the first song's tags back exactly.
    const undone = await ctx.wb.undo([one.id]);
    assert.equal(undone.restored, 1);
    assert.equal((await readTags(one.path, 'mp3')).artist, 'unknown artist');
    assert.equal(ctx.lib.toClient(ctx.lib.get(one.id)).artist, 'unknown artist');
  } finally {
    ctx?.lib.close?.();
    t.cleanup();
  }
});

test('edited values replace the proposal, nonsense is cleaned, and formats that cannot be tagged are reported, not touched', async () => {
  const t = tmp();
  let ctx;
  try {
    ctx = await setup(t, () => [cand({})]);
    const items = [...ctx.lib.items.values()].filter((i) => i.kind === 'audio');
    ctx.songs.start(items.map((i) => i.id));
    await finished(ctx.songs);
    const two = items.find((i) => i.fileTitle.includes('Song 2'));
    const m4a = items.find((i) => i.path.endsWith('.m4a'));
    const before = fs.readFileSync(m4a.path);
    const out = await ctx.songs.apply([
      { id: two.id, pick: 0, fields: { title: '  My Own Title\u0000  ', track: '7', year: 99999, genre: 'x'.repeat(500) } },
      { id: m4a.id, pick: 0 },
      { id: 'ffffffff', pick: 0 },
    ]);
    assert.deepEqual([out.wrote, out.skipped], [1, 1]);
    assert.match(out.errors[0], /only MP3 and FLAC/);
    assert.deepEqual(fs.readFileSync(m4a.path), before);
    const tags = await readTags(two.path, 'mp3');
    assert.equal(tags.title, 'My Own Title');
    assert.equal(tags.track, 7);
    assert.equal(tags.year, 1997, 'an impossible year is ignored and the proposal stands');
    assert.ok(tags.genre.length <= 60);
  } finally {
    ctx?.lib.close?.();
    t.cleanup();
  }
});

test('a song already carrying the right details is reported as such, and a cancelled run stops', async () => {
  const t = tmp();
  let ctx;
  try {
    ctx = await setup(t, () => [cand({ title: 'Mystery', artist: 'Unknown', album: '' })]);
    const items = [...ctx.lib.items.values()].filter((i) => i.kind === 'audio');
    const same = items.find((i) => i.fileTitle === 'Karma Police');
    await writeTags(same.path, { set: { title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', track: 6, year: 1997, genre: 'Alternative' } });
    await ctx.lib.scan?.();
    ctx.songs.p.songCandidates = async () => [cand({})];
    same.title = 'Karma Police'; same.artist = 'Radiohead'; same.album = 'OK Computer'; same.track = 6; same.year = 1997; same.genre = 'Alternative';
    ctx.songs.start([same.id]);
    await finished(ctx.songs);
    assert.equal(ctx.songs.results.get(same.id).status, 'same');
    ctx.songs.p.songCandidates = async () => { await new Promise((r) => setTimeout(r, 40)); return [cand({})]; };
    ctx.songs.start(items.map((i) => i.id));
    await new Promise((r) => setTimeout(r, 60));
    ctx.songs.cancel();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctx.songs.state.active, false);
    assert.ok(ctx.songs.results.size < items.length, 'it stopped before doing them all');
  } finally {
    ctx?.lib.close?.();
    t.cleanup();
  }
});

test('a weak match is shown as a suggestion, never as a confident answer, and a title-only match is capped', async () => {
  const t = tmp();
  let ctx;
  try {
    ctx = await setup(t, (q) => (q.artist ? [cand({ score: 0.55 })] : [cand({ score: 0.99, artist: 'Someone Else' })]));
    const one = [...ctx.lib.items.values()].find((i) => i.fileTitle === 'Karma Police');
    ctx.songs.start([one.id]);
    await finished(ctx.songs);
    const r = ctx.songs.results.get(one.id);
    assert.equal(r.status, 'found');
    assert.equal(r.confident, false, 'nothing reached the confidence bar, so nothing starts ticked');
    assert.ok(r.candidates.every((c) => c.score <= 0.7), 'a match made on the title alone can never look certain');
  } finally {
    ctx?.lib.close?.();
    t.cleanup();
  }
});

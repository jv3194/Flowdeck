'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTags, restoreHeader } = require('../server/tagwrite');
const { readTags, readPicture } = require('../server/tags');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-tagwrite-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const make = (ext, ...parts) => {
  const file = path.join(tmp, `f${n++}.${ext}`);
  fs.writeFileSync(file, Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))));
  return file;
};
const bytes = (file) => fs.readFileSync(file);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 5)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 9)]);
const ART = { data: JPG, mime: 'image/jpeg' };
const OLD_ART = { data: PNG, mime: 'image/png' };

const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const synchsafe = (v) => Buffer.from([(v >> 21) & 127, (v >> 14) & 127, (v >> 7) & 127, v & 127]);
const audioMp3 = (frames = 40) => Buffer.concat(Array.from({ length: frames }, (_, i) => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, i)])));

const text = (s) => Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
const frame3 = (id, data) => Buffer.concat([Buffer.from(id), be32(data.length), Buffer.alloc(2), data]);
const frame4 = (id, data) => Buffer.concat([Buffer.from(id), synchsafe(data.length), Buffer.alloc(2), data]);
const apic = (img) => Buffer.concat([Buffer.from([0]), Buffer.from(`${img.mime}\0`), Buffer.from([3, 0]), img.data]);
const id3 = (ver, frames, { pad = 200, flags = 0 } = {}) => {
  const body = Buffer.concat([...frames, Buffer.alloc(pad)]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, flags]), synchsafe(body.length), body]);
};

/** Frames of an ID3v2.3/2.4 tag as [id, data]. */
function frames(file, ver = 3) {
  const b = bytes(file);
  const size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
  const out = [];
  for (let p = 10; p + 10 <= 10 + size && b[p] !== 0;) {
    const len = ver === 4 ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127) : b.readUInt32BE(p + 4);
    out.push([b.toString('latin1', p, p + 4), b.subarray(p + 10, p + 10 + len)]);
    p += 10 + len;
  }
  return out;
}
const headerLen = (file) => {
  const b = bytes(file);
  return 10 + (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127));
};

const journalTo = (box) => async (original, newLen) => { box.original = original; box.newLen = newLen; };

test('mp3 without a tag: adds year, genre and art; the audio is byte-identical', async () => {
  const audio = audioMp3();
  const file = make('mp3', audio);
  const r = await writeTags(file, { year: 2001, genre: 'Electronic', image: ART });
  assert.equal(r.changed, true);
  const after = bytes(file);
  assert.equal(after.toString('latin1', 0, 3), 'ID3');
  assert.deepEqual(after.subarray(headerLen(file)), audio, 'every audio byte is unchanged');
  assert.deepEqual(await readTags(file, 'mp3'), { year: 2001, genre: 'Electronic', hasPic: true, duration: (await readTags(file, 'mp3')).duration });
  assert.deepEqual((await readPicture(file, 'mp3')).data, JPG);
  assert.equal(fs.existsSync(`${file}.flowdeck-tmp`), false, 'no temp file left behind');
});

test('running it again changes nothing (idempotent)', async () => {
  const file = make('mp3', audioMp3());
  await writeTags(file, { year: 2001, genre: 'Rock', image: ART });
  const once = bytes(file);
  const r = await writeTags(file, { year: 2001, genre: 'Rock', image: ART });
  assert.deepEqual([r.changed, r.reason], [false, 'already complete']);
  assert.deepEqual(bytes(file), once);
});

test('mp3 with a tag: existing frames survive byte-for-byte, existing values and art are not overwritten', async () => {
  const tag = id3(3, [frame3('TIT2', text('Song')), frame3('TPE1', text('Band')), frame3('TRCK', text('3/9')), frame3('TXXX', Buffer.from('\0custom\0value')), frame3('PRIV', Buffer.from('owner\0\x01\x02')), frame3('APIC', apic(OLD_ART))]);
  const file = make('mp3', tag, audioMp3());
  const before = frames(file);
  const r = await writeTags(file, { year: 2001, genre: 'Pop', image: ART });
  assert.equal(r.changed, true);
  const after = frames(file);
  for (const [id, data] of before) assert.deepEqual(after.find((f) => f[0] === id)[1], data, `${id} is untouched`);
  assert.deepEqual((await readPicture(file, 'mp3')).data, PNG, 'the file already had art, so it is kept');
  const t = await readTags(file, 'mp3');
  assert.deepEqual([t.title, t.artist, t.track, t.year, t.genre], ['Song', 'Band', 3, 2001, 'Pop']);
});

test('values that are already there are never overwritten', async () => {
  const tag = id3(3, [frame3('TIT2', text('Song')), frame3('TYER', text('1999')), frame3('TCON', text('Jazz')), frame3('APIC', apic(OLD_ART))]);
  const file = make('mp3', tag, audioMp3());
  const original = bytes(file);
  const r = await writeTags(file, { year: 2001, genre: 'Rock', image: ART });
  assert.deepEqual([r.changed, r.reason], [false, 'already complete']);
  assert.deepEqual(bytes(file), original);
});

test('replaceArt swaps the picture when the user chose a different one', async () => {
  const tag = id3(3, [frame3('TIT2', text('Song')), frame3('APIC', apic(OLD_ART))]);
  const file = make('mp3', tag, audioMp3());
  await writeTags(file, { image: ART }, { replaceArt: true });
  assert.deepEqual((await readPicture(file, 'mp3')).data, JPG);
  assert.equal(frames(file).filter((f) => f[0] === 'APIC').length, 1);
  assert.equal((await readTags(file, 'mp3')).title, 'Song');
});

test('ID3v2.4: year goes in TDRC and non-Latin text is stored as UTF-8', async () => {
  const file = make('mp3', id3(4, [frame4('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('曲')]))]), audioMp3());
  await writeTags(file, { year: 2010, genre: '音楽' });
  const f = frames(file, 4);
  assert.deepEqual(f.map((x) => x[0]), ['TIT2', 'TDRC', 'TCON']);
  assert.equal(f[2][1][0], 3, 'UTF-8 text encoding');
  const t = await readTags(file, 'mp3');
  assert.deepEqual([t.title, t.year, t.genre], ['曲', 2010, '音楽']);
});

test('ID3v1 at the end of the file is left alone', async () => {
  const v1 = Buffer.alloc(128);
  Buffer.from('TAG').copy(v1);
  Buffer.from('Old Title').copy(v1, 3);
  const file = make('mp3', audioMp3(), v1);
  await writeTags(file, { year: 2001 });
  assert.deepEqual(bytes(file).subarray(-128), v1);
});

test('tags we do not fully understand are skipped, untouched', async () => {
  const cases = {
    'ID3v2.2': Buffer.concat([Buffer.from('ID3'), Buffer.from([2, 0, 0]), synchsafe(20), Buffer.alloc(20)]),
    'unsynchronised': id3(3, [frame3('TIT2', text('x'))], { flags: 0x80 }),
    'damaged frame': id3(3, [Buffer.from('????'), be32(5), Buffer.alloc(7)]),
    'frame longer than the tag': id3(3, [Buffer.concat([Buffer.from('TIT2'), be32(9999), Buffer.alloc(2), Buffer.alloc(4)])], { pad: 0 }),
  };
  for (const [name, tag] of Object.entries(cases)) {
    const file = make('mp3', tag, audioMp3(3));
    const original = bytes(file);
    const r = await writeTags(file, { year: 2001, genre: 'x', image: ART });
    assert.equal(r.changed, false, name);
    assert.match(r.reason, /skipped/, name);
    assert.deepEqual(bytes(file), original, `${name}: file untouched`);
  }
});

test('formats we cannot write are reported, not modified', async () => {
  const file = make('wav', 'RIFF....WAVEdata');
  const original = bytes(file);
  assert.deepEqual(await writeTags(file, { year: 2001, image: ART }), { changed: false, reason: 'format not supported' });
  assert.deepEqual(bytes(file), original);
});

test('absurdly large artwork is ignored rather than embedded', async () => {
  const file = make('mp3', audioMp3(2));
  const r = await writeTags(file, { image: { data: Buffer.alloc(9 * 1024 * 1024, 1), mime: 'image/jpeg' } });
  assert.equal(r.changed, false);
});

// ----------------------------------------------------------------------- FLAC

const flacBlock = (type, last, data) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
const streaminfo = (() => { const b = Buffer.alloc(34); b.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n, 10); return b; })();
const vorbis = (...comments) => Buffer.concat([le32(6), Buffer.from('vendor'), le32(comments.length), ...comments.map((c) => Buffer.concat([le32(Buffer.byteLength(c)), Buffer.from(c)]))]);
const flacAudio = Buffer.alloc(6000).map((_, i) => (i * 31) & 255);
const flac = (...blocks) => Buffer.concat([Buffer.from('fLaC'), ...blocks, flacAudio]);
const flacFile = (...blocks) => make('flac', flac(...blocks));
const flacBlocks = (file) => {
  const b = bytes(file);
  const out = [];
  for (let p = 4, last = false; !last;) {
    last = !!(b[p] & 0x80);
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    out.push({ type: b[p] & 0x7f, last, data: b.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
};

test('flac: adds DATE/GENRE and a front-cover picture, keeps what was there, audio identical', async () => {
  const file = flacFile(flacBlock(0, false, streaminfo), flacBlock(4, false, vorbis('TITLE=Lossless', 'DATE=1999')), flacBlock(1, true, Buffer.alloc(300)));
  const r = await writeTags(file, { year: 2001, genre: 'Rock', image: ART });
  assert.equal(r.changed, true);
  const blocks = flacBlocks(file);
  assert.deepEqual(blocks[0].data, streaminfo, 'STREAMINFO is unchanged and still first');
  assert.deepEqual(blocks.map((b) => b.type), [0, 4, 6, 1]);
  assert.deepEqual(blocks.map((b) => b.last), [false, false, false, true], 'only the final block is flagged last');
  assert.deepEqual(bytes(file).subarray(4 + blocks.reduce((s, b) => s + 4 + b.data.length, 0)), flacAudio);
  const t = await readTags(file, 'flac');
  assert.deepEqual([t.title, t.year, t.genre, t.hasPic], ['Lossless', 1999, 'Rock', true], 'the existing DATE wins');
  assert.deepEqual((await readPicture(file, 'flac')).data, JPG);
});

test('flac without a comment block gets one', async () => {
  const file = flacFile(flacBlock(0, true, streaminfo));
  await writeTags(file, { year: 2001, genre: 'Soul' });
  const t = await readTags(file, 'flac');
  assert.deepEqual([t.year, t.genre], [2001, 'Soul']);
});

test('flac: replaceArt swaps the front cover but keeps other pictures', async () => {
  const picture = (type, img) => Buffer.concat([be32(type), be32(img.mime.length), Buffer.from(img.mime), be32(0), be32(0), be32(0), be32(0), be32(0), be32(img.data.length), img.data]);
  const file = flacFile(flacBlock(0, false, streaminfo), flacBlock(6, false, picture(3, OLD_ART)), flacBlock(6, true, picture(4, OLD_ART)));
  await writeTags(file, { image: ART }, { replaceArt: true });
  const pics = flacBlocks(file).filter((b) => b.type === 6).map((b) => b.data.readUInt32BE(0));
  assert.deepEqual(pics.sort(), [3, 4]);
  assert.deepEqual((await readPicture(file, 'flac')).data, JPG);
});

// --------------------------------------------------------- undo and failure safety

test('undo restores every file exactly as it was, for each way a file can start out', async () => {
  const starts = {
    'mp3, no tag': make('mp3', audioMp3()),
    'mp3, with tag': make('mp3', id3(3, [frame3('TIT2', text('Song')), frame3('TRCK', text('1'))]), audioMp3()),
    'flac': flacFile(flacBlock(0, false, streaminfo), flacBlock(4, false, vorbis('TITLE=x')), flacBlock(1, true, Buffer.alloc(100))),
  };
  for (const [name, file] of Object.entries(starts)) {
    const original = bytes(file);
    const box = {};
    assert.equal((await writeTags(file, { year: 2001, genre: 'Rock', image: ART }, { journal: journalTo(box) })).changed, true, name);
    assert.notDeepEqual(bytes(file), original, name);
    await restoreHeader(file, box.original, box.newLen);
    assert.deepEqual(bytes(file), original, `${name}: byte-for-byte restored`);
  }
});

test('undo refuses when the file has been changed since', async () => {
  const file = make('mp3', audioMp3());
  const box = {};
  await writeTags(file, { year: 2001 }, { journal: journalTo(box) });
  await writeTags(file, { genre: 'Pop' }); // someone (or the app) edited it again
  const edited = bytes(file);
  await assert.rejects(restoreHeader(file, box.original, box.newLen), /changed since/);
  assert.deepEqual(bytes(file), edited, 'left alone');
});

test('if anything fails before the swap, the original is untouched and no temp file remains', async () => {
  const file = make('mp3', id3(3, [frame3('TIT2', text('Song'))]), audioMp3());
  const original = bytes(file);
  await assert.rejects(writeTags(file, { year: 2001 }, { journal: async () => { throw new Error('disk full while saving the undo copy'); } }), /disk full/);
  assert.deepEqual(bytes(file), original);
  assert.equal(fs.existsSync(`${file}.flowdeck-tmp`), false);
});

test('a missing file is an error the caller can report', async () => {
  await assert.rejects(writeTags(path.join(tmp, 'missing.mp3'), { year: 2001 }));
});

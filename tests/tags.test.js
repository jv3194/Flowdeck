'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTags, readPicture } = require('../server/tags');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-tags-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name, ...parts) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))));
  return file;
};

const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

const text = (s, enc = 0) =>
  Buffer.concat([
    Buffer.from([enc]),
    enc === 0 ? Buffer.from(s, 'latin1') : enc === 3 ? Buffer.from(s, 'utf8') : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]),
  ]);
const frame3 = (id, data) => Buffer.concat([Buffer.from(id), be32(data.length), Buffer.from([0, 0]), data]);
const frame4 = (id, data) => Buffer.concat([Buffer.from(id), synchsafe(data.length), Buffer.from([0, 0]), data]);
const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3]), Buffer.from('front\0'), PNG]);
const id3 = (ver, frames, pad = 0) => {
  const body = Buffer.concat([...frames, Buffer.alloc(pad)]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), synchsafe(body.length), body]);
};
// One silent MPEG-1 Layer III 128 kbps / 44.1 kHz frame (417 bytes) repeated.
const mp3Frames = (n) => Buffer.concat(Array.from({ length: n }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));

test('mp3: ID3v2.3 text, track/disc parsing, picture and CBR duration', async () => {
  const file = write(
    'a.mp3',
    id3(3, [frame3('TIT2', text('Hello')), frame3('TPE1', text('Someone')), frame3('TALB', text('The Album')), frame3('TRCK', text('3/12')), frame3('TPOS', text('2/2')), frame3('TYER', text('1999')), frame3('TCON', text('(13)Pop')), frame3('APIC', apic)]),
    mp3Frames(100),
  );
  const t = await readTags(file, 'mp3');
  assert.equal(t.title, 'Hello');
  assert.equal(t.artist, 'Someone');
  assert.equal(t.album, 'The Album');
  assert.equal(t.track, 3);
  assert.equal(t.disc, 2);
  assert.equal(t.year, 1999);
  assert.equal(t.genre, 'Pop');
  assert.equal(t.hasPic, true);
  assert.ok(Math.abs(t.duration - 2.6) < 0.1, `duration ${t.duration}`);
  const pic = await readPicture(file, 'mp3');
  assert.equal(pic.mime, 'image/png');
  assert.deepEqual(pic.data, PNG);
});

test('mp3: ID3v2.4 with UTF-8 and UTF-16 text, picture before text frames', async () => {
  const file = write('b.mp3', id3(4, [frame4('APIC', apic), frame4('TIT2', text('Café ☕', 3)), frame4('TPE1', text('Zoë', 1)), frame4('TDRC', text('2004-05-06', 3))], 64), mp3Frames(10));
  const t = await readTags(file, 'mp3');
  assert.equal(t.title, 'Café ☕');
  assert.equal(t.artist, 'Zoë');
  assert.equal(t.year, 2004);
  assert.equal((await readPicture(file, 'mp3')).data.length, PNG.length);
});

test('mp3: ID3v2.2 frames', async () => {
  const f2 = (id, data) => Buffer.concat([Buffer.from(id), Buffer.from([(data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
  const body = Buffer.concat([f2('TT2', text('Old Tag')), f2('TP1', text('Vintage')), f2('PIC', Buffer.concat([Buffer.from([0]), Buffer.from('PNG'), Buffer.from([3, 0]), PNG]))]);
  const file = write('c.mp3', Buffer.from('ID3'), Buffer.from([2, 0, 0]), synchsafe(body.length), body, mp3Frames(5));
  const t = await readTags(file, 'mp3');
  assert.equal(t.title, 'Old Tag');
  assert.equal(t.artist, 'Vintage');
  assert.equal((await readPicture(file, 'mp3')).mime, 'image/png');
});

test('mp3: Xing header gives exact duration; ID3v1 is the fallback for tags', async () => {
  const first = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(first, 0);
  Buffer.from('Xing').copy(first, 36);
  first.writeUInt32BE(1, 40);
  first.writeUInt32BE(200, 44);
  const v1 = Buffer.alloc(128);
  Buffer.from('TAG').copy(v1, 0);
  Buffer.from('Legacy Song').copy(v1, 3);
  Buffer.from('Legacy Band').copy(v1, 33);
  const file = write('d.mp3', first, mp3Frames(3), v1);
  const t = await readTags(file, 'mp3');
  assert.equal(t.title, 'Legacy Song');
  assert.equal(t.artist, 'Legacy Band');
  assert.ok(Math.abs(t.duration - (200 * 1152) / 44100) < 0.01);
});

test('flac: STREAMINFO duration, Vorbis comments and PICTURE', async () => {
  const info = Buffer.alloc(34);
  const packed = (44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n;
  info.writeBigUInt64BE(packed, 10);
  const comments = ['TITLE=Lossless', 'artist=Band', 'ALBUM=Disc', 'TRACKNUMBER=7', 'DATE=2020-01-01'].map((c) => Buffer.concat([le32(Buffer.byteLength(c)), Buffer.from(c)]));
  const vorbis = Buffer.concat([le32(1), Buffer.from('x'), le32(comments.length), ...comments]);
  const picture = Buffer.concat([be32(3), be32(9), Buffer.from('image/png'), be32(0), be32(1), be32(1), be32(24), be32(0), be32(PNG.length), PNG]);
  const block = (type, last, data) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
  const file = write('e.flac', 'fLaC', block(0, false, info), block(4, false, vorbis), block(6, true, picture), Buffer.alloc(100));
  const t = await readTags(file, 'flac');
  assert.equal(t.title, 'Lossless');
  assert.equal(t.artist, 'Band');
  assert.equal(t.track, 7);
  assert.equal(t.year, 2020);
  assert.equal(t.duration, 10);
  assert.equal(t.hasPic, true);
  assert.deepEqual((await readPicture(file, 'flac')).data, PNG);
});

test('m4a: ilst tags, covr and mvhd duration (moov after mdat)', async () => {
  const atom = (type, ...kids) => {
    const body = Buffer.concat(kids);
    return Buffer.concat([be32(body.length + 8), Buffer.from(type, 'latin1'), body]);
  };
  const data = (flags, payload) => atom('data', be32(flags), be32(0), payload);
  const item = (type, flags, payload) => atom(type, data(flags, payload));
  const mvhd = atom('mvhd', Buffer.concat([Buffer.alloc(4), be32(0), be32(0), be32(1000), be32(90000), Buffer.alloc(80)]));
  const trkn = Buffer.from([0, 0, 0, 4, 0, 10, 0, 0]);
  const ilst = atom('ilst', item('©nam', 1, Buffer.from('Apple Song')), item('©ART', 1, Buffer.from('Fruit')), item('trkn', 0, trkn), item('covr', 14, PNG));
  const moov = atom('moov', mvhd, atom('udta', atom('meta', be32(0), ilst)));
  const file = write('f.m4a', atom('ftyp', Buffer.from('M4A \0\0\0\0')), atom('mdat', Buffer.alloc(500)), moov);
  const t = await readTags(file, 'm4a');
  assert.equal(t.title, 'Apple Song');
  assert.equal(t.artist, 'Fruit');
  assert.equal(t.track, 4);
  assert.equal(t.duration, 90);
  assert.equal(t.hasPic, true);
  assert.deepEqual((await readPicture(file, 'm4a')).data, PNG);
});

test('wav: duration from header', async () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8);
  const file = write('g.wav', 'RIFF', le32(36 + 32000), 'WAVE', 'fmt ', le32(16), fmt, 'data', le32(32000), Buffer.alloc(32000));
  assert.equal((await readTags(file, 'wav')).duration, 2);
});

test('unreadable or truncated files yield empty tags instead of throwing', async () => {
  assert.deepEqual(await readTags(path.join(dir, 'missing.mp3'), 'mp3'), {});
  assert.deepEqual(await readTags(write('trunc.flac', 'fLaC\x00\x00'), 'flac'), {});
  assert.equal(await readPicture(write('nopic.mp3', mp3Frames(2)), 'mp3'), null);
});

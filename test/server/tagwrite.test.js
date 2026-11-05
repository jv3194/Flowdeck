'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeTags, restoreHeader } = require('../../server/tagwrite.js');
const { WriteBack } = require('../../server/writeback.js');
const { tmp, touch } = require('../support.js');

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const audio = () => crypto.randomBytes(3000);

/** An MP3 with an ID3v2.3 tag holding `frames` ([id, text] pairs), followed by `body` standing in for the audio. */
function mp3(file, frames, body = audio(), ver = 3) {
  const parts = frames.map(([id, text]) => {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), data]);
  });
  const tag = Buffer.concat(parts);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), synchsafe(tag.length), tag, body]));
  return body;
}

/** A FLAC with only a STREAMINFO block, then `body` as the audio frames. */
function flac(file, body = audio()) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34), body]));
  return body;
}

const after = (file, headerLen) => fs.readFileSync(file).subarray(headerLen);

test('MP3: year and genre are added, and every audio byte is untouched', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.mp3');
    const body = mp3(file, [['TIT2', 'Song']]);
    const r = await writeTags(file, { year: 1999, genre: 'Rock' });
    assert.equal(r.changed, true);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(bytes.subarray(bytes.length - body.length), body);
    const text = bytes.subarray(0, r.headerLen).toString('latin1');
    assert.ok(text.includes('TYER') && text.includes('1999') && text.includes('TCON') && text.includes('Rock') && text.includes('Song'));
  } finally {
    t.cleanup();
  }
});

test('MP3: values that are already there are never overwritten, and a complete file is left alone', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.mp3');
    mp3(file, [['TYER', '1980'], ['TCON', 'Jazz']]);
    const before = fs.readFileSync(file);
    const r = await writeTags(file, { year: 1999, genre: 'Rock' });
    assert.deepEqual([r.changed, r.reason], [false, 'already complete']);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    t.cleanup();
  }
});

test('MP3: tags the writer does not understand are skipped, not guessed at', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'old.mp3');
    mp3(file, [['TT2', 'Song']], audio(), 2); // ID3v2.2
    const before = fs.readFileSync(file);
    const r = await writeTags(file, { year: 1999 });
    assert.equal(r.changed, false);
    assert.match(r.reason, /skipped/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(await writeTags(path.join(t.dir, 'x.m4a'), { year: 1 }), { changed: false, reason: 'format not supported' });
  } finally {
    t.cleanup();
  }
});

test('FLAC: date and genre are added as comments and the audio is untouched; a second pass finds nothing to do', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.flac');
    const body = flac(file);
    const r = await writeTags(file, { year: 1999, genre: 'Rock' });
    assert.equal(r.changed, true);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(bytes.subarray(bytes.length - body.length), body);
    const head = bytes.subarray(0, r.headerLen).toString('utf8');
    assert.ok(head.includes('DATE=1999') && head.includes('GENRE=Rock'));
    assert.equal((await writeTags(file, { year: 1999, genre: 'Rock' })).reason, 'already complete');
  } finally {
    t.cleanup();
  }
});

test('artwork is embedded only when absent, unless the caller says the user picked it', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.mp3');
    mp3(file, [['TIT2', 'Song']]);
    const png = { data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100, 1)]), mime: 'image/png' };
    assert.equal((await writeTags(file, { image: png })).changed, true);
    assert.equal((await writeTags(file, { image: png })).reason, 'already complete');
    const other = { data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100, 2)]), mime: 'image/png' };
    assert.equal((await writeTags(file, { image: other })).reason, 'already complete', 'existing art is kept by default');
    assert.equal((await writeTags(file, { image: other }, { replaceArt: true })).changed, true);
    assert.equal((await writeTags(file, { image: { data: Buffer.alloc(9 * 1024 * 1024), mime: 'image/png' } })).reason, 'already complete', 'oversized art is ignored');
  } finally {
    t.cleanup();
  }
});

test('restoring puts the original header back byte for byte, but refuses if the file changed since', async () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'a.mp3');
    mp3(file, [['TIT2', 'Song']]);
    const original = fs.readFileSync(file);
    let saved;
    const r = await writeTags(file, { year: 1999 }, { journal: (header, len) => { saved = { header, len }; } });
    assert.notDeepEqual(fs.readFileSync(file), original);
    await restoreHeader(file, saved.header, saved.len);
    assert.deepEqual(fs.readFileSync(file), original);

    await writeTags(file, { year: 1999 }, { journal: (header, len) => { saved = { header, len }; } });
    await writeTags(file, { genre: 'Rock' }); // someone else edits it afterwards
    await assert.rejects(restoreHeader(file, saved.header, saved.len), /has changed/);
  } finally {
    t.cleanup();
  }
});

// ------------------------------------------------------------ the journal, through WriteBack

function setup(t) {
  const song = path.join(t.dir, 'a.mp3');
  mp3(song, []);
  const item = { id: 'abc12345', kind: 'audio', path: song, ext: 'mp3', year: 1999, fetched: { found: true, filled: ['year'], src: 'x' } };
  const lib = { items: new Map([[item.id, item]]), coverDir: t.dir, get: (id) => lib.items.get(id), _touch() {} };
  const wb = new WriteBack(lib, t.dir);
  return { song, item, wb, original: sha(fs.readFileSync(song)), headers: () => fs.readdirSync(path.join(t.dir, 'undo')).filter((f) => f.endsWith('.hdr')).length };
}

test('a write is journalled, and undo restores the file and clears the journal', async () => {
  const t = tmp();
  try {
    const s = setup(t);
    const r = await s.wb.tracks([s.item.id]);
    assert.equal(r.wrote, 1);
    assert.equal(s.wb.entries.length, 1);
    assert.equal(s.headers(), 1);
    assert.notEqual(sha(fs.readFileSync(s.song)), s.original);
    const u = await s.wb.undo([s.item.id]);
    assert.deepEqual(u, { restored: 1, skipped: 0 });
    assert.equal(sha(fs.readFileSync(s.song)), s.original);
    assert.deepEqual([s.wb.entries.length, s.headers()], [0, 0]);
    assert.equal(s.item.fetched.noWrite, true, 'an undone file is not quietly written again');
  } finally {
    t.cleanup();
  }
});

test('if the final swap fails (a locked file) the file is untouched and nothing is left in the journal', async () => {
  const t = tmp();
  const realRename = fs.promises.rename;
  try {
    const s = setup(t);
    fs.promises.rename = async (from, to) => {
      if (String(from).endsWith('.flowdeck-tmp')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return realRename(from, to);
    };
    const r = await s.wb.tracks([s.item.id]);
    assert.deepEqual([r.wrote, r.failed], [0, 1]);
    assert.match(r.errors[0], /in use or read-only/);
    assert.equal(sha(fs.readFileSync(s.song)), s.original);
    assert.deepEqual([s.wb.entries.length, s.headers(), fs.existsSync(`${s.song}.flowdeck-tmp`)], [0, 0, false]);
  } finally {
    fs.promises.rename = realRename;
    t.cleanup();
  }
});

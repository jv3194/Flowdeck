'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkvTracks, mkvCues } = require('../server/mkv');
const { mkv, cluster, unknownCluster, simpleBlock, blockGroup } = require('./helpers/mkv-builder');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-mkv-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const write = (data) => {
  const file = path.join(tmp, `t${n++}.mkv`);
  fs.writeFileSync(file, data);
  return file;
};

const TRACKS = [
  { number: 1, type: 1, codec: 'V_MPEG4/ISO/AVC' },
  { number: 2, type: 2, codec: 'A_AAC', lang: 'eng' },
  { number: 3, type: 17, codec: 'S_TEXT/UTF8', lang: 'eng', name: 'English SDH' },
  { number: 4, type: 17, codec: 'S_TEXT/ASS', lang: 'fre', forced: true },
  { number: 5, type: 17, codec: 'S_HDMV/PGS', lang: 'spa', isDefault: false },
];
const VIDEO = Buffer.alloc(3 * 1024 * 1024, 7); // a big frame: it must be skipped, not read

const sample = () =>
  mkv({
    tracks: TRACKS,
    clusters: [
      cluster(10000, simpleBlock(1, 0, VIDEO), simpleBlock(3, 100, 'Hello'), blockGroup(3, 2000, 'World\n<i>line2</i>', 1500), blockGroup(4, 500, '0,0,Default,,0,0,0,,{\\i1}Ahoy{\\i0}\\Nmatey, friend', 2000)),
      cluster(60000, simpleBlock(2, 0, 'audio'), blockGroup(3, 250, 'Later', 800)),
    ],
  });

test('tracks: only subtitle tracks, with language, flags, codec and whether it is text', async () => {
  const tracks = await mkvTracks(write(sample()));
  assert.deepEqual(tracks, [
    { number: 3, codec: 'TEXT/UTF8', lang: 'en', name: 'English SDH', forced: false, isDefault: true, supported: true },
    { number: 4, codec: 'TEXT/ASS', lang: 'fr', name: '', forced: true, isDefault: true, supported: true },
    { number: 5, codec: 'HDMV/PGS', lang: 'es', name: '', forced: false, isDefault: false, supported: false },
  ]);
});

test('cues: cluster time + block time, durations, text cleaning, large video blocks skipped', async () => {
  const file = write(sample());
  assert.deepEqual(await mkvCues(file, 3), [
    { s: 10.1, e: 12, t: 'Hello' }, // a SimpleBlock has no duration: it runs until the next cue
    { s: 12, e: 13.5, t: 'World\n<i>line2</i>' },
    { s: 60.25, e: 61.05, t: 'Later' },
  ]);
  assert.deepEqual(await mkvCues(file, 4), [{ s: 10.5, e: 12.5, t: '<i>Ahoy</i>\nmatey, friend' }]);
});

test('cues: the timestamp scale is respected', async () => {
  const file = write(mkv({ tracks: TRACKS, scale: 500000, clusters: [cluster(2000, blockGroup(3, 10, 'half-ms ticks', 100))] }));
  assert.deepEqual(await mkvCues(file, 3), [{ s: 1.005, e: 1.055, t: 'half-ms ticks' }]);
});

test('image-based and missing tracks give no cues', async () => {
  const file = write(sample());
  assert.deepEqual(await mkvCues(file, 5), []);
  assert.deepEqual(await mkvCues(file, 99), []);
  assert.deepEqual(await mkvCues(file, 1), [], 'a video track is not a subtitle track');
});

test('unknown-size segment and clusters (as written by live recorders)', async () => {
  const file = write(mkv({
    tracks: TRACKS, unknownSegment: true,
    clusters: [unknownCluster(1000, simpleBlock(1, 0, 'vid'), blockGroup(3, 0, 'one', 500)), unknownCluster(5000, blockGroup(3, 100, 'two', 500)), cluster(9000, blockGroup(3, 0, 'three', 500))],
  }));
  assert.deepEqual((await mkvCues(file, 3)).map((c) => [c.s, c.t]), [[1, 'one'], [5.1, 'two'], [9, 'three']]);
  assert.equal((await mkvTracks(file)).length, 3);
});

test('laced blocks are skipped rather than misread', async () => {
  const file = write(mkv({ tracks: TRACKS, clusters: [cluster(0, simpleBlock(3, 0, 'laced', 0x02), blockGroup(3, 1000, 'fine', 500))] }));
  assert.deepEqual((await mkvCues(file, 3)).map((c) => c.t), ['fine']);
});

test('a truncated file returns what was read instead of failing', async () => {
  const full = sample();
  const cut = full.subarray(0, full.length - 40); // chops the last cluster
  const cues = await mkvCues(write(cut), 3);
  assert.deepEqual(cues.slice(0, 2).map((c) => c.t), ['Hello', 'World\n<i>line2</i>']);
});

test('files that are not Matroska, or are unreadable, yield nothing', async () => {
  assert.deepEqual(await mkvTracks(write(Buffer.from('definitely not a video file'))), []);
  assert.deepEqual(await mkvTracks(write(Buffer.alloc(0))), []);
  assert.deepEqual(await mkvTracks(path.join(tmp, 'missing.mkv')), []);
  assert.deepEqual(await mkvCues(write(Buffer.from('nope')), 3), []);
  await assert.rejects(mkvCues(path.join(tmp, 'missing.mkv'), 3), 'asking for cues from a file that cannot be opened is an error the caller reports');
});

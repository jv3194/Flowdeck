'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../server/transcode.js');

const picture = { codec: 'h264', bitDepth: 8, chroma: '420', height: 1080, width: 1920, transfer: '' };
const aac = { codec: 'aac', channels: 2, lang: 'eng', name: '', isDefault: true, ordinal: 0 };
const three = {
  duration: 7200,
  video: picture,
  audio: [aac, { codec: 'aac', channels: 6, lang: 'spa', name: 'Latino', isDefault: false, ordinal: 1 }, { codec: 'ac3', channels: 6, lang: 'fra', name: 'Commentary', isDefault: false, ordinal: 2 }],
};

test('a file the player can decode is played as it is', () => {
  const plan = T.decide({ duration: 100, video: picture, audio: [aac] });
  assert.deepEqual([plan.mode, plan.video, plan.audio, plan.reasons], ['direct', 'copy', 'copy', []]);
});

test('Dolby audio only needs the sound converted, unless the page says it can decode it', () => {
  const dolby = { duration: 100, video: picture, audio: [{ ...aac, codec: 'ac3' }] };
  const plan = T.decide(dolby);
  assert.deepEqual([plan.mode, plan.video, plan.audio], ['remux', 'copy', 'aac']);
  assert.equal(T.decide(dolby, T.parseCaps('ac3')).mode, 'direct');
});

test('pictures the player cannot decode are converted to H.264', () => {
  const hevc10 = { duration: 100, video: { ...picture, codec: 'hevc', bitDepth: 10 }, audio: [aac] };
  assert.equal(T.decide(hevc10).mode, 'transcode');
  assert.equal(T.decide(hevc10, T.parseCaps('hevc10')).mode, 'direct');
  assert.equal(T.decide({ duration: 1, video: { ...picture, chroma: '4:2:2' }, audio: [aac] }).mode, 'transcode');
  assert.equal(T.decide({ duration: 1, video: { ...picture, codec: 'mpeg2video' }, audio: [aac] }).mode, 'transcode');
});

test('force converts everything and says why', () => {
  const plan = T.decide({ duration: 1, video: picture, audio: [aac] }, new Set(), { force: true });
  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.reasons.at(-1).forced, true);
});

test('capability words the page sends are filtered to the ones we know', () => {
  assert.deepEqual([...T.parseCaps('ac3, dts,bogus,,hevc10')].sort(), ['ac3', 'dts', 'hevc10']);
  assert.equal(T.parseCaps(null).size, 0);
});

test('hasVideo: true with a picture, false for sound only, null when nothing could be read', () => {
  assert.equal(T.decide({ video: picture, audio: [aac] }).hasVideo, true);
  assert.equal(T.decide({ video: null, audio: [aac] }).hasVideo, false);
  assert.equal(T.decide({ video: null, audio: [] }).hasVideo, null);
  assert.equal(T.decide(null).hasVideo, null);
});

test('sound tracks: the usual one plays directly, another needs the file re-muxed, a bad choice is ignored', () => {
  const direct = T.decide(three, new Set(), { audio: 0 });
  assert.deepEqual([direct.mode, direct.switched], ['direct', false]);

  const spanish = T.decide(three, new Set(), { audio: 1 });
  assert.deepEqual([spanish.mode, spanish.switched, spanish.audio, spanish.audioOrdinal, spanish.reasons], ['remux', true, 'copy', 1, []]);

  const french = T.decide(three, new Set(), { audio: 2 }); // Dolby, so it is converted as well
  assert.deepEqual([french.mode, french.switched, french.audio, french.audioOrdinal], ['remux', true, 'aac', 2]);
  assert.equal(french.reasons[0].kind, 'audio');

  assert.equal(T.decide(three, new Set(), { audio: 99 }).mode, 'direct');
});

test('audioList marks the track a player would use on its own', () => {
  const list = T.audioList(three);
  assert.deepEqual(list.map((t) => [t.ordinal, t.isDefault, t.rawLang]), [[0, true, 'eng'], [1, false, 'spa'], [2, false, 'fra']]);
  assert.equal(list[2].codec, 'AC-3 (Dolby Digital)');
  assert.deepEqual(T.audioList(null), []);
  // with no flagged default the first track is the usual one
  assert.equal(T.audioList({ audio: [{ ...aac, isDefault: false }, { ...aac, ordinal: 1, isDefault: false }] })[0].isDefault, true);
});

test('descriptions: a pure track switch says so', () => {
  assert.equal(T.describe(T.decide(three, new Set(), { audio: 1 })), 'Switching the sound track');
  assert.match(T.describe(T.decide({ video: picture, audio: [{ ...aac, codec: 'dts' }] })), /^Converting sound for playback/);
});

test('ffmpeg arguments: the chosen track is mapped, copied when playable and converted when not', () => {
  const copy = T.buildArgs(T.decide(three, new Set(), { audio: 1 }), 'in.mkv', 0, {}).join(' ');
  assert.match(copy, /-map 0:a:1\? .*-c:v copy .*-c:a copy/);
  const conv = T.buildArgs(T.decide(three, new Set(), { audio: 2 }), 'in.mkv', 0, {}).join(' ');
  assert.match(conv, /-map 0:a:2\? .*-c:a aac -ac 6/);
});

test('ffmpeg arguments: seek position, the HEVC tag, HDR tone mapping and sound-less files', () => {
  const seek = T.buildArgs(T.decide({ video: picture, audio: [aac] }), 'in.mkv', 90.5, {});
  assert.deepEqual(seek.slice(seek.indexOf('-ss'), seek.indexOf('-ss') + 2), ['-ss', '90.500']);
  const hevc = T.buildArgs(T.decide({ video: { ...picture, codec: 'hevc' }, audio: [aac] }, T.parseCaps('hevc8')), 'in.mkv', 0, {});
  assert.ok(hevc.join(' ').includes('-tag:v hvc1'));
  const hdr = T.decide({ video: { ...picture, codec: 'hevc', bitDepth: 10, transfer: 'smpte2084' }, audio: [aac] });
  assert.ok(T.buildArgs(hdr, 'in.mkv', 0, { zscale: true }).join(' ').includes('tonemap=tonemap=hable'));
  assert.ok(!T.buildArgs(hdr, 'in.mkv', 0, { zscale: false }).join(' ').includes('tonemap'));
  assert.ok(T.buildArgs(T.decide({ video: picture, audio: [] }), 'in.mkv', 0, {}).includes('-an'));
  assert.equal(T.buildArgs(T.decide({ video: { ...picture, height: 2160 }, audio: [aac] }, new Set(), { force: true }), 'in.mkv', 0, {}).some((a) => a.includes('scale=-2')), true);
});

test('ffprobe output is normalised: bit depth, chroma, HDR flag, cover art ignored, track titles kept', () => {
  const info = T.fromFfprobe({
    format: { duration: '5400.5' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10', width: 3840, height: 2160, color_transfer: 'smpte2084', disposition: {} },
      { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'Main' }, disposition: { default: 1 } },
    ],
  });
  assert.equal(info.duration, 5400.5);
  assert.deepEqual([info.video.codec, info.video.bitDepth, info.video.chroma, info.video.transfer], ['hevc', 10, '420', 'smpte2084']);
  assert.deepEqual([info.audio[0].codec, info.audio[0].lang, info.audio[0].name, info.audio[0].isDefault], ['eac3', 'eng', 'Main', true]);
  assert.equal(T.fromFfprobe({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv444p' }] }).video.chroma, '4:4:4');
  assert.equal(T.fromFfprobe({}).video, null);
});

test('Matroska headers give the same shape: codecs, HEVC bit depth from its setup bytes, HDR, audio names', () => {
  const hvcc = Buffer.alloc(23); hvcc[16] = 0xfc | 1; hvcc[17] = 0xf8 | 2; // 4:2:0, luma depth 8 + 2
  const info = T.fromMatroska({
    duration: 100,
    tracks: [
      { type: 1, codec: 'V_MPEGH/ISO/HEVC', width: 1920, height: 1080, priv: hvcc, transfer: 16 },
      { type: 2, codec: 'A_EAC3', channels: 6, language: 'eng', name: 'Dolby', isDefault: true },
      { type: 2, codec: 'A_PCM/INT/LIT', channels: 2, language: 'spa', name: '', isDefault: false, bitDepth: 24 },
    ],
  });
  assert.deepEqual([info.video.codec, info.video.bitDepth, info.video.chroma, info.video.transfer], ['hevc', 10, '420', 'smpte2084']);
  assert.deepEqual(info.audio.map((a) => [a.codec, a.name, a.ordinal]), [['eac3', 'Dolby', 0], ['pcm_s24le', '', 1]]);
  assert.equal(T.fromMatroska(null), null);
});

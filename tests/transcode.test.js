'use strict';
// The rules for what needs converting, and the ffmpeg commands that do it. No ffmpeg is run here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCaps, fromFfprobe, fromMatroska, decide, describe, buildArgs } = require('../server/transcode');
const { mkvStreams } = require('../server/mkv');
const { mkv, cluster, simpleBlock } = require('./helpers/mkv-builder');

const video = (over = {}) => ({ codec: 'h264', profile: 'High', bitDepth: 8, chroma: '420', width: 1920, height: 1080, transfer: '', ...over });
const audio = (over = {}) => ({ codec: 'aac', channels: 2, lang: 'eng', isDefault: true, ordinal: 0, ...over });
const info = (v, ...a) => ({ duration: 3600, video: v, audio: a });
const reasons = (plan) => plan.reasons.map((r) => `${r.kind}: ${r.text}`);

test('caps: only known words survive, whatever the page sends', () => {
  assert.deepEqual([...parseCaps(' ac3, hevc8,bogus,<script>,eac3')].sort(), ['ac3', 'eac3', 'hevc8']);
  assert.equal(parseCaps(undefined).size, 0);
  assert.equal(parseCaps('x'.repeat(100000)).size, 0);
});

test('ordinary H.264 with AAC plays as it is', () => {
  const p = decide(info(video(), audio()));
  assert.equal(p.mode, 'direct');
  assert.deepEqual(p.reasons, []);
});

test('Dolby audio on an H.264 picture: only the sound is converted (cheap), unless the page can decode it', () => {
  const p = decide(info(video(), audio({ codec: 'eac3', channels: 6 })));
  assert.equal(p.mode, 'remux');
  assert.equal(p.video, 'copy');
  assert.equal(p.audio, 'aac');
  assert.deepEqual(reasons(p), ['audio: E-AC-3 (Dolby Digital Plus)']);
  assert.equal(decide(info(video(), audio({ codec: 'eac3' })), parseCaps('eac3')).mode, 'direct');
  assert.equal(decide(info(video(), audio({ codec: 'ac3' })), parseCaps('eac3')).mode, 'remux', 'each codec is its own question');
  for (const codec of ['dts', 'truehd', 'alac', 'mp2', 'unknown']) assert.equal(decide(info(video(), audio({ codec }))).mode, 'remux', codec);
  for (const codec of ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']) assert.equal(decide(info(video(), audio({ codec }))).mode, 'direct', codec);
});

test('HEVC: 8-bit and 10-bit are separate questions, answered by what the page reports', () => {
  const eight = info(video({ codec: 'hevc', bitDepth: 8 }), audio());
  const ten = info(video({ codec: 'hevc', bitDepth: 10 }), audio());
  assert.equal(decide(eight).mode, 'transcode', 'unknown support means convert');
  assert.equal(decide(eight, parseCaps('hevc8')).mode, 'direct');
  assert.equal(decide(ten, parseCaps('hevc8')).mode, 'transcode', "8-bit support doesn't cover 10-bit");
  assert.deepEqual(reasons(decide(ten, parseCaps('hevc8'))), ['video: HEVC 10-bit']);
  assert.equal(decide(ten, parseCaps('hevc8,hevc10')).mode, 'direct');
});

test('pictures with no decoder here are converted: 4:2:2, 4:4:4, very deep H.264, old codecs', () => {
  assert.equal(decide(info(video({ chroma: '4:2:2' }), audio())).mode, 'transcode');
  assert.equal(decide(info(video({ chroma: '4:4:4' }), audio())).mode, 'transcode');
  assert.equal(decide(info(video({ bitDepth: 12 }), audio())).mode, 'transcode');
  assert.equal(decide(info(video({ bitDepth: 10 }), audio())).mode, 'direct', 'H.264 10-bit decodes here');
  assert.deepEqual(reasons(decide(info(video({ codec: 'mpeg4' }), audio({ codec: 'mp3' })))), ['video: MPEG-4']);
  for (const codec of ['mpeg2video', 'vc1', 'wmv3', 'prores', 'unknown']) assert.equal(decide(info(video({ codec }), audio())).mode, 'transcode', codec);
  for (const codec of ['vp8', 'vp9', 'av1']) assert.equal(decide(info(video({ codec }), audio({ codec: 'opus' }))).mode, 'direct', codec);
});

test('picture and sound problems are both reported, and the picture decides the mode', () => {
  const p = decide(info(video({ codec: 'hevc', bitDepth: 10 }), audio({ codec: 'dts' })));
  assert.equal(p.mode, 'transcode');
  assert.deepEqual(reasons(p), ['video: HEVC 10-bit', 'audio: DTS']);
  assert.equal(describe(p), 'Converting video for playback (video HEVC 10-bit, audio DTS)');
  assert.equal(describe(decide(info(video(), audio({ codec: 'ac3' })))), 'Converting sound for playback (audio AC-3 (Dolby Digital))');
});

test('the audio track judged is the one a player would pick: the default, else the first', () => {
  const p = decide(info(video(), audio({ isDefault: false }), audio({ codec: 'eac3', isDefault: true, ordinal: 1, channels: 6 })));
  assert.equal(p.mode, 'remux');
  assert.equal(p.audioOrdinal, 1);
  assert.equal(p.channels, 6);
  const first = decide(info(video(), audio({ codec: 'dts', isDefault: false }), audio({ codec: 'aac', isDefault: false, ordinal: 1 })));
  assert.equal(first.audioOrdinal, 0);
  assert.equal(first.mode, 'remux');
});

test('a video with no sound, and force for a file that failed although it looked fine', () => {
  const quiet = decide({ duration: 1, video: video(), audio: [] });
  assert.equal(quiet.mode, 'direct');
  assert.equal(quiet.hasAudio, false);
  const forced = decide(info(video(), audio()), new Set(), { force: true });
  assert.equal(forced.mode, 'transcode');
  assert.equal(forced.audio, 'aac');
  assert.deepEqual(reasons(forced), ["video: it wouldn't play as it is"]);
});

test('HDR is noticed (PQ and HLG), so it can be tone-mapped', () => {
  assert.equal(decide(info(video({ codec: 'hevc', bitDepth: 10, transfer: 'smpte2084' }), audio())).hdr, true);
  assert.equal(decide(info(video({ codec: 'hevc', bitDepth: 10, transfer: 'arib-std-b67' }), audio())).hdr, true);
  assert.equal(decide(info(video(), audio())).hdr, false);
});

test('ffprobe output is normalised, and cover art is not mistaken for the picture', () => {
  const json = {
    format: { duration: '5400.5' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 }, width: 600, height: 600 },
      { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10', width: 3840, height: 2160, color_transfer: 'smpte2084', disposition: {} },
      { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' }, disposition: { default: 1 } },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, disposition: { default: 0 } },
      { codec_type: 'subtitle', codec_name: 'subrip' },
    ],
  };
  assert.deepEqual(fromFfprobe(json), {
    duration: 5400.5,
    video: { codec: 'hevc', profile: 'Main 10', bitDepth: 10, chroma: '420', width: 3840, height: 2160, transfer: 'smpte2084' },
    audio: [
      { codec: 'eac3', channels: 6, lang: 'eng', isDefault: true, ordinal: 0 },
      { codec: 'aac', channels: 2, lang: '', isDefault: false, ordinal: 1 },
    ],
  });
  const noDepth = fromFfprobe({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv444p10le', width: 10, height: 10 }] });
  assert.equal(noDepth.video.bitDepth, 10, 'depth from the pixel format when ffprobe leaves it out');
  assert.equal(noDepth.video.chroma, '4:4:4');
  assert.deepEqual(fromFfprobe({}), { duration: 0, video: null, audio: [] });
});

// ---- reading the same facts from a Matroska file's own headers (no ffmpeg needed)

const hvcc = (depth, chroma = 1) => { const b = Buffer.alloc(23); b[0] = 1; b[16] = 0xfc | chroma; b[17] = 0xf8 | (depth - 8); return b; };
const avcc = (profile) => Buffer.from([1, profile, 0, 40, 0xff]);

test('Matroska headers: HEVC bit depth from hvcC, H.264 depth from its profile, HDR from the colour element, audio codecs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-codec-'));
  try {
    const write = (name, tracks, duration) => { const f = path.join(tmp, name); fs.writeFileSync(f, mkv({ tracks, clusters: [cluster(0, simpleBlock(1, 0, 'x'))], duration })); return f; };
    const f = write('hevc10.mkv', [
      { number: 1, type: 1, codec: 'V_MPEGH/ISO/HEVC', priv: hvcc(10), video: { width: 3840, height: 2160, transfer: 16 } },
      { number: 2, type: 2, codec: 'A_EAC3', lang: 'eng', audio: { channels: 6 } },
      { number: 3, type: 2, codec: 'A_AAC', lang: 'eng', isDefault: false, audio: { channels: 2 } },
      { number: 4, type: 17, codec: 'S_TEXT/UTF8', lang: 'eng' },
    ], 7200000);
    const raw = await mkvStreams(f);
    assert.equal(raw.tracks.length, 3, 'subtitle tracks are not included');
    const got = fromMatroska(raw);
    assert.deepEqual(got.video, { codec: 'hevc', profile: '', bitDepth: 10, chroma: '420', width: 3840, height: 2160, transfer: 'smpte2084' });
    assert.deepEqual(got.audio.map((a) => [a.codec, a.channels, a.isDefault, a.ordinal]), [['eac3', 6, true, 0], ['aac', 2, false, 1]]);
    assert.equal(got.duration, 7200);
    assert.equal(decide(got, parseCaps('hevc8')).mode, 'transcode');
    assert.equal(decide(got, parseCaps('hevc8,hevc10,eac3')).mode, 'direct');

    const eight = fromMatroska(await mkvStreams(write('hevc8.mkv', [{ number: 1, type: 1, codec: 'V_MPEGH/ISO/HEVC', priv: hvcc(8), video: { width: 1920, height: 1080 } }])));
    assert.equal(eight.video.bitDepth, 8);
    assert.equal(eight.video.transfer, '');
    assert.equal(fromMatroska(await mkvStreams(write('hevc422.mkv', [{ number: 1, type: 1, codec: 'V_MPEGH/ISO/HEVC', priv: hvcc(10, 2) }]))).video.chroma, '4:2:2');

    const high10 = fromMatroska(await mkvStreams(write('h264-10.mkv', [{ number: 1, type: 1, codec: 'V_MPEG4/ISO/AVC', priv: avcc(110) }, { number: 2, type: 2, codec: 'A_PCM/INT/LIT', audio: { channels: 2, bitDepth: 24 } }])));
    assert.deepEqual([high10.video.codec, high10.video.bitDepth, high10.audio[0].codec], ['h264', 10, 'pcm_s24le']);
    const high = fromMatroska(await mkvStreams(write('h264-8.mkv', [{ number: 1, type: 1, codec: 'V_MPEG4/ISO/AVC', priv: avcc(100) }, { number: 2, type: 2, codec: 'A_AAC/MPEG4/LC' }])));
    assert.deepEqual([high.video.bitDepth, high.audio[0].codec], [8, 'aac']);
    assert.equal(decide(high).mode, 'direct');

    const odd = fromMatroska(await mkvStreams(write('odd.mkv', [{ number: 1, type: 1, codec: 'V_MS/VFW/FOURCC' }, { number: 2, type: 2, codec: 'A_MS/ACM' }])));
    assert.deepEqual([odd.video.codec, odd.audio[0].codec], ['unknown', 'unknown']);
    assert.equal(decide(odd).mode, 'transcode');

    assert.equal(fromMatroska(null), null);
    fs.writeFileSync(path.join(tmp, 'junk.mkv'), 'not a matroska file');
    assert.equal(await mkvStreams(path.join(tmp, 'junk.mkv')), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- the commands

const flag = (args, name) => args[args.indexOf(name) + 1];

test('command, transcode: hardware decode, accurate seek, H.264/AAC into a streamable MP4', () => {
  const plan = decide(info(video({ codec: 'hevc', bitDepth: 10, height: 1080 }), audio({ codec: 'eac3', channels: 6 })));
  const args = buildArgs(plan, 'C:\\Movies\\My "Film" (2020).mkv', 125.5);
  assert.equal(flag(args, '-i'), 'C:\\Movies\\My "Film" (2020).mkv', 'the path is one argument, untouched (there is no shell)');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'seeking before the input is the fast kind');
  assert.equal(flag(args, '-ss'), '125.500');
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
  assert.equal(flag(args, '-c:v'), 'libx264');
  assert.equal(flag(args, '-vf'), 'format=yuv420p');
  assert.equal(flag(args, '-c:a'), 'aac');
  assert.equal(flag(args, '-ac'), '6');
  assert.equal(flag(args, '-b:a'), '384k');
  assert.equal(flag(args, '-f'), 'mp4');
  assert.match(flag(args, '-movflags'), /frag_keyframe/);
  assert.equal(args.at(-1), 'pipe:1');
  assert.ok(args.includes('-sn') && args.includes('-nostdin'));
  assert.equal(args.includes('-ss'), true);
  assert.equal(buildArgs(plan, 'a.mkv', 0).includes('-ss'), false, 'no seek flag at the start');
  assert.equal(flag(buildArgs(plan, 'a.mkv', 0), '-map'), '0:v:0?');
});

test('command, remux: the picture is copied, only the sound is converted', () => {
  const plan = decide(info(video(), audio({ codec: 'eac3', channels: 2 })));
  const args = buildArgs(plan, 'a.mkv', 0);
  assert.equal(flag(args, '-c:v'), 'copy');
  assert.equal(args.includes('-hwaccel'), false, 'nothing is decoded, so no hardware decoder');
  assert.equal(args.includes('-vf'), false);
  assert.equal(flag(args, '-b:a'), '192k');
  assert.ok(args.includes('0:a:0?'));
  const hevc = buildArgs(decide(info(video({ codec: 'hevc' }), audio({ codec: 'dts' })), parseCaps('hevc8')), 'a.mkv', 0);
  assert.equal(flag(hevc, '-tag:v'), 'hvc1', 'copied HEVC is tagged the way Chromium wants');
});

test('command: big pictures are scaled to 1080p, HDR is tone-mapped only if ffmpeg can, more than six channels become six', () => {
  const uhd = decide(info(video({ codec: 'hevc', bitDepth: 10, height: 2160, transfer: 'smpte2084' }), audio({ codec: 'truehd', channels: 8, ordinal: 2 })));
  const without = flag(buildArgs(uhd, 'a.mkv', 0, { zscale: false }), '-vf');
  assert.match(without, /^scale=-2:'min\(1080,ih\)',format=yuv420p$/);
  assert.equal(buildArgs(uhd, 'a.mkv', 0, { zscale: false }).includes('-color_trc'), false, 'not tone-mapped, so the labels are left alone');
  const toneArgs = buildArgs(uhd, 'a.mkv', 0, { zscale: true });
  assert.equal(flag(toneArgs, '-color_trc'), 'bt709', 'tone-mapped output is labelled standard range, not HDR');
  assert.equal(flag(toneArgs, '-colorspace'), 'bt709');
  const withTone = flag(toneArgs, '-vf');
  assert.match(withTone, /tonemap=tonemap=hable/);
  assert.match(withTone, /^scale=/, 'scaled first, so the expensive part runs on fewer pixels');
  assert.match(withTone, /format=yuv420p$/);
  const args = buildArgs(uhd, 'a.mkv', 0);
  assert.equal(flag(args, '-ac'), '6');
  assert.ok(args.includes('0:a:2?'));
  const quiet = buildArgs(decide({ duration: 1, video: video({ codec: 'mpeg4' }), audio: [] }), 'a.avi', 0);
  assert.ok(quiet.includes('-an'));
  assert.equal(quiet.some((a) => a.startsWith('0:a')), false);
});

'use strict';
// What a video needs before the player can show it, and the ffmpeg arguments that do the conversion.
// Everything here is pure (data in, data out), so the rules can be tested without ffmpeg or a browser.
//
// Streams that the player can already decode are copied untouched; only the rest is converted. A video with
// Dolby audio but ordinary H.264 picture, for example, only has its audio converted, which is nearly free.

// Audio that Chromium decodes everywhere. AC-3, E-AC-3 and DTS only count if the page says it can decode them.
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le', 'pcm_u8']);
const DIRECT_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const CAPS = new Set(['ac3', 'eac3', 'dts', 'hevc8', 'hevc10']);

const VIDEO_NAMES = { h264: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vc1: 'VC-1', wmv3: 'WMV', prores: 'ProRes', mjpeg: 'Motion JPEG', theora: 'Theora' };
const AUDIO_NAMES = { ac3: 'AC-3 (Dolby Digital)', eac3: 'E-AC-3 (Dolby Digital Plus)', dts: 'DTS', truehd: 'Dolby TrueHD', alac: 'ALAC', mp2: 'MP2', wmav2: 'WMA', wmapro: 'WMA Pro', pcm_s16be: 'PCM' };

/** `caps` is what the page reported it can decode, as a comma-separated list. Unknown words are ignored. */
function parseCaps(text) {
  return new Set(String(text || '').split(',').map((s) => s.trim()).filter((s) => CAPS.has(s)));
}

const labelVideo = (v) => VIDEO_NAMES[v.codec] || String(v.codec || 'unknown').toUpperCase();
const labelAudio = (a) => AUDIO_NAMES[a.codec] || String(a.codec || 'unknown').toUpperCase();

/** Why the picture can't be played as it is, or '' if it can. */
function videoProblem(v, caps) {
  const name = labelVideo(v);
  if (v.chroma && v.chroma !== '420') return `${name} ${v.chroma}`; // 4:2:2 and 4:4:4 have no decoder here
  if (v.codec === 'h264') return v.bitDepth > 10 ? `${name} ${v.bitDepth}-bit` : '';
  if (v.codec === 'hevc') {
    if (v.bitDepth <= 8) return caps.has('hevc8') ? '' : name;
    return caps.has('hevc10') ? '' : `${name} ${v.bitDepth}-bit`;
  }
  return DIRECT_VIDEO.has(v.codec) ? '' : name;
}

/** Why this sound can't be played as it is, or '' if it can. */
function audioProblem(a, caps) {
  if (DIRECT_AUDIO.has(a.codec) || caps.has(a.codec)) return '';
  return labelAudio(a);
}

/** The audio track a player would pick: the one flagged default, else the first. */
function pickAudio(list) {
  return (list || []).find((a) => a.isDefault) || (list || [])[0] || null;
}

const isHdr = (v) => v && (v.transfer === 'smpte2084' || v.transfer === 'arib-std-b67');

/**
 * Normalise `ffprobe -print_format json -show_format -show_streams` output into
 * { duration, video: { codec, profile, bitDepth, chroma, width, height, transfer } | null, audio: [{ codec, channels, lang, isDefault, ordinal }] }.
 * Cover art stored as a video stream is not a picture to play.
 */
function fromFfprobe(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const pix = String(v?.pix_fmt || '');
  const depth = Number(v?.bits_per_raw_sample) || (/p1[0-9]|10(le|be)/.test(pix) ? (/12/.test(pix) ? 12 : 10) : 8);
  return {
    duration: Number(json?.format?.duration) || 0,
    video: v ? {
      codec: v.codec_name || '', profile: v.profile || '', bitDepth: depth,
      chroma: /444/.test(pix) ? '4:4:4' : /422/.test(pix) ? '4:2:2' : '420',
      width: Number(v.width) || 0, height: Number(v.height) || 0, transfer: v.color_transfer || '',
    } : null,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
      codec: s.codec_name || '', channels: Number(s.channels) || 2, lang: s.tags?.language || '', isDefault: !!s.disposition?.default, ordinal: i,
    })),
  };
}

const MK_VIDEO = {
  'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', V_VP9: 'vp9', V_VP8: 'vp8', V_AV1: 'av1', 'V_MPEG4/ISO/ASP': 'mpeg4',
  'V_MPEG4/ISO/SP': 'mpeg4', 'V_MPEG4/ISO/AP': 'mpeg4', V_MPEG2: 'mpeg2video', V_THEORA: 'theora',
};
const MK_AUDIO = [
  ['A_AAC', 'aac'], ['A_EAC3', 'eac3'], ['A_AC3', 'ac3'], ['A_DTS', 'dts'], ['A_TRUEHD', 'truehd'], ['A_MLP', 'truehd'], ['A_FLAC', 'flac'],
  ['A_OPUS', 'opus'], ['A_VORBIS', 'vorbis'], ['A_MPEG/L3', 'mp3'], ['A_MPEG/L2', 'mp2'], ['A_ALAC', 'alac'],
];

/**
 * The same shape as fromFfprobe, from what mkv.js reads out of a Matroska file's headers, so a file can be judged
 * before ffmpeg is installed. The HEVC bit depth lives in the codec's own setup bytes (hvcC), H.264's in its profile.
 */
function fromMatroska(raw) {
  if (!raw) return null;
  const v = raw.tracks.find((t) => t.type === 1);
  let video = null;
  if (v) {
    const codec = MK_VIDEO[v.codec] || 'unknown';
    let bitDepth = 8;
    let chroma = '420';
    const p = v.priv;
    if (codec === 'hevc' && p && p.length >= 19) {
      bitDepth = (p[17] & 7) + 8;
      chroma = { 2: '4:2:2', 3: '4:4:4' }[p[16] & 3] || '420';
    } else if (codec === 'h264' && p && p.length >= 2) {
      const profile = p[1]; // profile_idc: 110 High 10, 122 High 4:2:2, 244 High 4:4:4
      if (profile === 110) bitDepth = 10;
      else if (profile === 122) { bitDepth = 10; chroma = '4:2:2'; } else if (profile === 244) { bitDepth = 10; chroma = '4:4:4'; }
    }
    video = {
      codec, profile: '', bitDepth, chroma, width: v.width, height: v.height,
      transfer: v.transfer === 16 ? 'smpte2084' : v.transfer === 18 ? 'arib-std-b67' : '',
    };
  }
  const audio = raw.tracks.filter((t) => t.type === 2).map((t, i) => {
    let codec = (MK_AUDIO.find(([id]) => t.codec.startsWith(id)) || [])[1] || 'unknown';
    if (t.codec === 'A_PCM/INT/LIT') codec = `pcm_s${t.bitDepth || 16}le`;
    else if (t.codec === 'A_PCM/FLOAT/IEEE') codec = 'pcm_f32le';
    return { codec, channels: t.channels || 2, lang: t.language || '', isDefault: t.isDefault, ordinal: i };
  });
  return { duration: raw.duration || 0, video, audio };
}

/**
 * Decide what to do with a video.
 *   mode  'direct'     play the file as it is
 *         'remux'      keep the picture, convert the sound (cheap)
 *         'transcode'  convert the picture to H.264 as well
 * `force` converts everything, for a file that failed to play although it looked fine.
 */
function decide(info, caps = new Set(), { force = false } = {}) {
  const reasons = [];
  let video = 'copy';
  let audio = 'copy';
  const a = pickAudio(info?.audio);
  if (info?.video) {
    const why = videoProblem(info.video, caps);
    if (why) {
      video = 'h264';
      reasons.push({ kind: 'video', text: why });
    }
  }
  if (a) {
    const why = audioProblem(a, caps);
    if (why) {
      audio = 'aac';
      reasons.push({ kind: 'audio', text: why });
    }
  }
  if (force && video === 'copy') {
    video = 'h264';
    reasons.push({ kind: 'video', text: "it wouldn't play as it is", forced: true });
  }
  if (force && a && audio === 'copy') audio = 'aac';
  const mode = video === 'h264' ? 'transcode' : audio === 'aac' ? 'remux' : 'direct';
  return {
    mode, video, audio, reasons,
    hasAudio: !!a, audioOrdinal: a ? a.ordinal : 0, channels: a?.channels || 2,
    hdr: !!isHdr(info?.video), height: info?.video?.height || 0, codec: info?.video?.codec || '',
    duration: info?.duration || 0,
  };
}

/** A short sentence for the toast shown when playback is converted. */
function describe(plan) {
  const parts = plan.reasons.map((r) => (r.forced ? r.text : `${r.kind} ${r.text}`));
  const what = plan.mode === 'transcode' ? 'Converting video' : 'Converting sound';
  return `${what} for playback${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * The ffmpeg command for a plan, starting `start` seconds in, writing a fragmented MP4 to stdout so the page can
 * start playing at once. `opts.zscale` says whether this ffmpeg can tone-map HDR.
 */
function buildArgs(plan, file, start = 0, opts = {}) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (plan.video === 'h264') a.push('-hwaccel', 'auto'); // decode on the graphics card where it can
  if (start > 0) a.push('-ss', Number(start).toFixed(3));
  a.push('-i', file, '-map', '0:v:0?');
  if (plan.hasAudio) a.push('-map', `0:a:${plan.audioOrdinal}?`); // "?" so a file with no sound still converts
  a.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');

  if (plan.video === 'copy') {
    a.push('-c:v', 'copy');
    if (plan.codec === 'hevc') a.push('-tag:v', 'hvc1'); // the tag Chromium looks for
  } else {
    const chain = [];
    if (plan.height > 1080) chain.push("scale=-2:'min(1080,ih)'");
    if (plan.hdr && opts.zscale) {
      chain.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
    } else {
      chain.push('format=yuv420p');
    }
    a.push('-vf', chain.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high',
      '-force_key_frames', 'expr:gte(t,n_forced*2)');
    // Once tone-mapped the picture is standard range, so it must not still be labelled HDR.
    if (plan.hdr && opts.zscale) a.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  }

  if (!plan.hasAudio) a.push('-an');
  else if (plan.audio === 'copy') a.push('-c:a', 'copy');
  else {
    const ch = Math.min(plan.channels || 2, 6);
    a.push('-c:a', 'aac', '-ac', String(ch), '-b:a', ch > 2 ? '384k' : '192k');
  }
  a.push('-max_muxing_queue_size', '1024', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return a;
}

module.exports = { parseCaps, fromFfprobe, fromMatroska, decide, describe, buildArgs, pickAudio, CAPS };

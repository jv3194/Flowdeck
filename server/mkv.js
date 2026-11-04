'use strict';
// Embedded text subtitles in Matroska/WebM files (.mkv, .webm), which browsers don't expose themselves.
// Walks the EBML structure reading only element headers, so big video payloads are skipped, not read.
const fs = require('fs');
const { makeReader } = require('./tags');
const { assText, cleanText, finishCues, normalizeLang } = require('./subtitles');

const ID = {
  SEGMENT: 0x18538067, SEEKHEAD: 0x114d9b74, INFO: 0x1549a966, TIMESTAMP_SCALE: 0x2ad7b1, TRACKS: 0x1654ae6b, CUES: 0x1c53bb6b,
  CHAPTERS: 0x1043a770, TAGS: 0x1254c367, ATTACHMENTS: 0x1941a469, CLUSTER: 0x1f43b675, CLUSTER_TIME: 0xe7,
  SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0, BLOCK: 0xa1, BLOCK_DURATION: 0x9b,
  TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83, CODEC_ID: 0x86, NAME: 0x536e, LANGUAGE: 0x22b59c, LANGUAGE_BCP47: 0x22b59d,
  FLAG_DEFAULT: 0x88, FLAG_FORCED: 0x55aa,
  DURATION: 0x4489, CODEC_PRIVATE: 0x63a2, VIDEO: 0xe0, AUDIO: 0xe1, PIXEL_WIDTH: 0xb0, PIXEL_HEIGHT: 0xba, COLOUR: 0x55b0, TRANSFER: 0x55ba,
  CHANNELS: 0x9f, BIT_DEPTH: 0x6264,
};
const TOP_LEVEL = new Set([ID.CLUSTER, ID.CUES, ID.TAGS, ID.ATTACHMENTS, ID.CHAPTERS, ID.SEEKHEAD, ID.INFO, ID.TRACKS]);
const SUBTITLE = 17;
const TEXT_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT']);
const MAX_PAYLOAD = 256 * 1024;

/** EBML variable-length integer. IDs keep their length marker; sizes drop it, and all-ones means "unknown". */
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let ones = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}

async function header(rd, pos, limit) {
  if (pos >= limit) return null;
  const b = await rd.read(pos, 16);
  const id = vint(b, 0, true);
  if (!id || id.length > 4) return null;
  const size = vint(b, id.length, false);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  const end = size.unknown ? limit : Math.min(dataStart + size.value, limit);
  return { id: id.value, dataStart, end, size: Math.max(0, end - dataStart), unknown: size.unknown };
}

const readUInt = (buf) => buf.reduce((v, x) => v * 256 + x, 0);

async function* children(rd, start, end) {
  for (let pos = start; pos < end;) {
    const h = await header(rd, pos, end);
    if (!h) return;
    yield h;
    if (h.end <= pos) return;
    pos = h.end;
  }
}

/** Elements inside an already-read element's bytes: { id, data }. */
function* inside(buf) {
  for (let pos = 0; pos < buf.length;) {
    const id = vint(buf, pos, true);
    if (!id) return;
    const size = vint(buf, pos + id.length, false);
    if (!size || size.unknown) return;
    const start = pos + id.length + size.length;
    yield { id: id.value, data: buf.subarray(start, start + size.value) };
    pos = start + size.value;
  }
}

async function readTrackEntry(rd, entry) {
  const t = { number: 0, type: 0, codec: '', name: '', language: '', bcp47: '', isDefault: true, forced: false, width: 0, height: 0, channels: 0, bitDepth: 0, transfer: 0, priv: null };
  for await (const e of children(rd, entry.dataStart, entry.end)) {
    if (e.size > 4096) continue;
    const data = await rd.read(e.dataStart, e.size);
    const text = () => data.toString('utf8').replace(/\0+$/, '');
    switch (e.id) {
      case ID.TRACK_NUMBER: t.number = readUInt(data); break;
      case ID.TRACK_TYPE: t.type = readUInt(data); break;
      case ID.CODEC_ID: t.codec = text(); break;
      case ID.NAME: t.name = text(); break;
      case ID.LANGUAGE: t.language = text(); break;
      case ID.LANGUAGE_BCP47: t.bcp47 = text(); break;
      case ID.FLAG_DEFAULT: t.isDefault = readUInt(data) !== 0; break;
      case ID.FLAG_FORCED: t.forced = readUInt(data) !== 0; break;
      case ID.CODEC_PRIVATE: t.priv = Buffer.from(data); break;
      case ID.VIDEO:
        for (const v of inside(data)) {
          if (v.id === ID.PIXEL_WIDTH) t.width = readUInt(v.data);
          else if (v.id === ID.PIXEL_HEIGHT) t.height = readUInt(v.data);
          else if (v.id === ID.COLOUR) for (const c of inside(v.data)) if (c.id === ID.TRANSFER) t.transfer = readUInt(c.data);
        }
        break;
      case ID.AUDIO:
        for (const a of inside(data)) {
          if (a.id === ID.CHANNELS) t.channels = readUInt(a.data);
          else if (a.id === ID.BIT_DEPTH) t.bitDepth = readUInt(a.data);
        }
        break;
      default:
    }
  }
  return t;
}

async function withFile(file, fn) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    return await fn(makeReader(fh, 4096), size);
  } finally {
    await fh.close();
  }
}

/** Find the Segment element (it follows the EBML header). */
async function segmentOf(rd, size) {
  for (let pos = 0, i = 0; i < 8; i++) {
    const h = await header(rd, pos, size);
    if (!h) return null;
    if (h.id === ID.SEGMENT) return h;
    pos = h.end;
  }
  return null;
}

/** Segment-level scan up to the first cluster: timestamp scale and the subtitle tracks. */
async function readHeaders(rd, seg) {
  let scale = 1e6;
  let ticks = 0;
  const tracks = [];
  for (let pos = seg.dataStart; pos < seg.end;) {
    const h = await header(rd, pos, seg.end);
    if (!h || h.id === ID.CLUSTER) break; // Tracks always come before the clusters
    if (h.id === ID.INFO) {
      for await (const e of children(rd, h.dataStart, h.end)) {
        if (e.id === ID.TIMESTAMP_SCALE && e.size <= 8) scale = readUInt(await rd.read(e.dataStart, e.size)) || scale;
        else if (e.id === ID.DURATION && (e.size === 4 || e.size === 8)) {
          const d = await rd.read(e.dataStart, e.size);
          ticks = e.size === 4 ? d.readFloatBE(0) : d.readDoubleBE(0);
        }
      }
    } else if (h.id === ID.TRACKS) {
      for await (const e of children(rd, h.dataStart, h.end)) if (e.id === ID.TRACK_ENTRY) tracks.push(await readTrackEntry(rd, e));
    }
    pos = h.end;
  }
  return { scale, tracks, duration: (ticks * scale) / 1e9 };
}

const describe = (t) => ({
  number: t.number,
  codec: t.codec.replace(/^S_/, ''),
  lang: normalizeLang(t.bcp47 || t.language),
  name: t.name,
  forced: t.forced,
  isDefault: t.isDefault,
  supported: TEXT_CODECS.has(t.codec),
});

/** Subtitle tracks in the file: [{ number, codec, lang, name, forced, isDefault, supported }]. Never throws. */
async function mkvTracks(file) {
  try {
    return await withFile(file, async (rd, size) => {
      const seg = await segmentOf(rd, size);
      if (!seg) return [];
      return (await readHeaders(rd, seg)).tracks.filter((t) => t.type === SUBTITLE).map(describe);
    });
  } catch {
    return [];
  }
}

function payloadText(codec, payload) {
  const text = payload.toString('utf8');
  if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
    // "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text": the text is everything after the 8th comma
    let at = -1;
    for (let i = 0; i < 8; i++) at = text.indexOf(',', at + 1);
    return at < 0 ? '' : assText(text.slice(at + 1));
  }
  return cleanText(text);
}

/** Cues for one subtitle track, read from the cluster blocks. Throws if the file can't be read. */
async function mkvCues(file, trackNumber) {
  return withFile(file, async (rd, size) => {
    const seg = await segmentOf(rd, size);
    if (!seg) return [];
    const { scale, tracks } = await readHeaders(rd, seg);
    const track = tracks.find((t) => t.number === trackNumber && t.type === SUBTITLE);
    if (!track || !TEXT_CODECS.has(track.codec)) return [];
    const toSeconds = (ticks) => (ticks * scale) / 1e9;
    const cues = [];

    // Block data: track number (vint), int16 timecode relative to the cluster, flags, then the frame.
    async function block(e, clusterTime) {
      const head = await rd.read(e.dataStart, Math.min(e.size, 16));
      const tn = vint(head, 0, false);
      if (!tn || tn.value !== trackNumber || head.length < tn.length + 3) return null;
      if (head[tn.length + 2] & 0x06 || e.size > MAX_PAYLOAD) return null; // laced or oversized: not a normal subtitle
      const start = toSeconds(clusterTime + head.readInt16BE(tn.length));
      const payload = await rd.read(e.dataStart + tn.length + 3, e.size - tn.length - 3);
      return { s: start, t: payloadText(track.codec, payload) };
    }

    async function scanCluster(h) {
      let clusterTime = 0;
      for (let pos = h.dataStart; pos < h.end;) {
        const e = await header(rd, pos, h.end);
        if (!e) break;
        // An unknown-size cluster ends where the next top-level element begins.
        if (h.unknown && TOP_LEVEL.has(e.id)) return pos;
        if (e.id === ID.CLUSTER_TIME) {
          clusterTime = readUInt(await rd.read(e.dataStart, Math.min(e.size, 8)));
        } else if (e.id === ID.SIMPLE_BLOCK) {
          const b = await block(e, clusterTime);
          if (b) cues.push({ ...b, e: null }); // no duration: filled in below
        } else if (e.id === ID.BLOCK_GROUP) {
          let b = null;
          let duration = null;
          for await (const c of children(rd, e.dataStart, e.end)) {
            if (c.id === ID.BLOCK) b = await block(c, clusterTime);
            else if (c.id === ID.BLOCK_DURATION) duration = readUInt(await rd.read(c.dataStart, Math.min(c.size, 8)));
          }
          if (b) cues.push({ ...b, e: duration == null ? null : b.s + toSeconds(duration) });
        }
        if (e.end <= pos) break;
        pos = e.end;
      }
      return h.end;
    }

    for (let pos = seg.dataStart; pos < seg.end;) {
      const h = await header(rd, pos, seg.end);
      if (!h) break;
      const next = h.id === ID.CLUSTER ? await scanCluster(h) : h.end;
      if (next <= pos) break; // always make progress, even on a damaged file
      pos = next;
    }

    cues.sort((a, b) => a.s - b.s);
    cues.forEach((c, i) => { if (c.e == null) c.e = Math.min(c.s + 5, cues[i + 1] ? cues[i + 1].s : Infinity); });
    return finishCues(cues);
  });
}

/** The video and audio tracks (codec IDs, sizes, HEVC/AVC setup bytes) and the duration, for deciding how to play the file. Null if unreadable. */
async function mkvStreams(file) {
  try {
    return await withFile(file, async (rd, size) => {
      const seg = await segmentOf(rd, size);
      if (!seg) return null;
      const { tracks, duration } = await readHeaders(rd, seg);
      return { duration, tracks: tracks.filter((t) => t.type === 1 || t.type === 2) };
    });
  } catch {
    return null;
  }
}

module.exports = { mkvTracks, mkvCues, mkvStreams };

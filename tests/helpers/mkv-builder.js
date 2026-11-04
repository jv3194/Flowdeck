'use strict';
// Just enough of an EBML/Matroska writer to build test files.

const sizeVint = (n) => {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  if (n < 0x1fffff) return Buffer.from([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0x10 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
};
const idBytes = (id) => {
  const out = [];
  for (let x = id; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
  return Buffer.from(out);
};
const buf = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(p));

/** An element with a known size. */
const el = (id, ...payload) => {
  const body = Buffer.concat(payload.map(buf));
  return Buffer.concat([idBytes(id), sizeVint(body.length), body]);
};
/** An element whose size is "unknown" (as written by live recorders): it runs until the next top-level element. */
const unknownEl = (id, ...payload) => Buffer.concat([idBytes(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...payload.map(buf)]);
const uint = (id, n) => {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return el(id, Buffer.from(hex, 'hex'));
};
const str = (id, s) => el(id, Buffer.from(s));
const f64 = (id, x) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return el(id, b);
};
const none = Buffer.alloc(0);

const ID = {
  EBML: 0x1a45dfa3, DOCTYPE: 0x4282, SEGMENT: 0x18538067, VOID: 0xec, INFO: 0x1549a966, TIMESTAMP_SCALE: 0x2ad7b1, TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83, CODEC_ID: 0x86, NAME: 0x536e, LANGUAGE: 0x22b59c, FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa, CLUSTER: 0x1f43b675, CLUSTER_TIME: 0xe7, SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0, BLOCK: 0xa1, BLOCK_DURATION: 0x9b,
  DURATION: 0x4489, CODEC_PRIVATE: 0x63a2, VIDEO: 0xe0, AUDIO: 0xe1, PIXEL_WIDTH: 0xb0, PIXEL_HEIGHT: 0xba, COLOUR: 0x55b0, TRANSFER: 0x55ba,
  CHANNELS: 0x9f, BIT_DEPTH: 0x6264,
};

/**
 * type: 1 video, 2 audio, 17 subtitle.
 * Optional: priv (CodecPrivate bytes), video { width, height, transfer }, audio { channels, bitDepth }.
 */
const track = ({ number, type, codec, lang, name, forced = false, isDefault = true, priv, video, audio }) =>
  el(ID.TRACK_ENTRY, uint(ID.TRACK_NUMBER, number), uint(ID.TRACK_TYPE, type), str(ID.CODEC_ID, codec),
    lang ? str(ID.LANGUAGE, lang) : none, name ? str(ID.NAME, name) : none,
    uint(ID.FLAG_FORCED, forced ? 1 : 0), uint(ID.FLAG_DEFAULT, isDefault ? 1 : 0),
    priv ? el(ID.CODEC_PRIVATE, priv) : none,
    video ? el(ID.VIDEO, uint(ID.PIXEL_WIDTH, video.width || 0), uint(ID.PIXEL_HEIGHT, video.height || 0), video.transfer ? el(ID.COLOUR, uint(ID.TRANSFER, video.transfer)) : none) : none,
    audio ? el(ID.AUDIO, uint(ID.CHANNELS, audio.channels || 2), audio.bitDepth ? uint(ID.BIT_DEPTH, audio.bitDepth) : none) : none);

/** Block payload: track number, int16 time relative to the cluster, flags, frame. */
const blockData = (trackNumber, rel, frame, flags = 0) =>
  Buffer.concat([Buffer.from([0x80 | trackNumber, (rel >> 8) & 0xff, rel & 0xff, flags]), buf(frame)]);
const simpleBlock = (trackNumber, rel, frame, flags) => el(ID.SIMPLE_BLOCK, blockData(trackNumber, rel, frame, flags));
const blockGroup = (trackNumber, rel, frame, durationTicks) => el(ID.BLOCK_GROUP, el(ID.BLOCK, blockData(trackNumber, rel, frame)), uint(ID.BLOCK_DURATION, durationTicks));
const cluster = (time, ...blocks) => el(ID.CLUSTER, uint(ID.CLUSTER_TIME, time), ...blocks);
const unknownCluster = (time, ...blocks) => unknownEl(ID.CLUSTER, uint(ID.CLUSTER_TIME, time), ...blocks);

/** A whole file: EBML header + Segment { Void, Info, Tracks, ...clusters }. `duration` is in timestamp-scale ticks. */
function mkv({ tracks, clusters, scale = 1000000, unknownSegment = false, duration }) {
  const info = el(ID.INFO, uint(ID.TIMESTAMP_SCALE, scale), duration ? f64(ID.DURATION, duration) : none);
  const parts = [el(ID.VOID, Buffer.alloc(10)), info, el(ID.TRACKS, ...tracks.map(track)), ...clusters];
  return Buffer.concat([el(ID.EBML, str(ID.DOCTYPE, 'matroska')), unknownSegment ? unknownEl(ID.SEGMENT, ...parts) : el(ID.SEGMENT, ...parts)]);
}

module.exports = { el, mkv, track, cluster, unknownCluster, simpleBlock, blockGroup, blockData, ID };

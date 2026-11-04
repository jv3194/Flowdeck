'use strict';
// Writes fetched details (year, genre, album art) into MP3 (ID3v2) and FLAC files.
//
// Safety rules, because this edits the user's own files:
//   * only the tag header is rewritten; every audio byte is copied as-is
//   * the new file is built beside the original, checked (audio hash identical, new header parses), and only then
//     renamed over it, so a failure at any point leaves the original untouched
//   * the original header is handed to `journal` before the swap, which is what makes "undo" exact
//   * anything unusual (ID3v2.2, unsynchronised or damaged tags) is skipped rather than guessed at
//   * existing values are never overwritten: year and genre are only added when missing, art only when absent
//     (or when the caller says the user picked it: `replaceArt`)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeReader } = require('./tags');

const fsp = fs.promises;
const PAD = 1024; // padding left after the new header
const MAX_HEADER = 64 * 1024 * 1024;
const MAX_ART = 8 * 1024 * 1024;

const synchsafeOut = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const synchsafeIn = (b, o = 0) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// ------------------------------------------------------------------- MP3 (ID3v2)

async function readId3(rd) {
  const head = await rd.read(0, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return { ver: 3, headerLen: 0, frames: [] }; // no tag yet
  const ver = head[3];
  const flags = head[5];
  const size = synchsafeIn(head, 6);
  const headerLen = 10 + size + (flags & 0x10 ? 10 : 0);
  if (ver !== 3 && ver !== 4) return { unsupported: `ID3v2.${ver} tags` };
  if (flags & 0x80) return { unsupported: 'an unsynchronised tag' };
  if (size > MAX_HEADER) return { unsupported: 'an oversized tag' };
  let pos = 10;
  const end = 10 + size;
  if (flags & 0x40) {
    const ext = await rd.read(pos, 4);
    pos += ver === 4 ? synchsafeIn(ext) : ext.readUInt32BE(0) + 4;
  }
  const frames = [];
  while (pos + 10 <= end) {
    const fh = await rd.read(pos, 10);
    if (fh.length < 10) return { unsupported: 'a damaged tag' };
    if (fh[0] === 0) break; // padding
    const id = fh.toString('latin1', 0, 4);
    const fsz = ver === 4 ? synchsafeIn(fh, 4) : fh.readUInt32BE(4);
    if (!/^[A-Z0-9]{4}$/.test(id) || pos + 10 + fsz > end) return { unsupported: 'a damaged tag' };
    const data = Buffer.from(await rd.read(pos + 10, fsz));
    if (data.length < fsz) return { unsupported: 'a damaged tag' };
    frames.push({ id, flags: Buffer.from(fh.subarray(8, 10)), data });
    pos += 10 + fsz;
  }
  return { ver, headerLen, frames };
}

const hasText = (frames, ...ids) => frames.some((f) => ids.includes(f.id) && f.data.length > 1);

function textData(ver, text) {
  if (/^[\u0000-ÿ]*$/.test(text)) return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
  if (ver === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]); // ID3v2.3 has no UTF-8
}

const apicData = (image) => Buffer.concat([Buffer.from([0]), Buffer.from(`${image.mime}\0`, 'latin1'), Buffer.from([3, 0]), image.data]); // front cover, no description

function encodeFrame(ver, id, flags, data) {
  return Buffer.concat([Buffer.from(id, 'latin1'), ver === 4 ? synchsafeOut(data.length) : be32(data.length), flags, data]);
}

function buildId3(parsed, { year, genre, image }, replaceArt) {
  const ver = parsed.ver;
  let frames = parsed.frames.slice();
  const added = [];
  const NOFLAGS = Buffer.alloc(2);

  if (replaceArt && image) frames = frames.filter((f) => f.id !== 'APIC');
  if (year && !hasText(frames, 'TYER', 'TDRC')) {
    frames = frames.filter((f) => f.id !== 'TYER' && f.id !== 'TDRC'); // an empty one would shadow ours
    added.push(encodeFrame(ver, ver === 4 ? 'TDRC' : 'TYER', NOFLAGS, textData(ver, String(year))));
  }
  if (genre && !hasText(frames, 'TCON')) {
    frames = frames.filter((f) => f.id !== 'TCON');
    added.push(encodeFrame(ver, 'TCON', NOFLAGS, textData(ver, genre)));
  }
  if (image && !frames.some((f) => f.id === 'APIC')) added.push(encodeFrame(ver, 'APIC', NOFLAGS, apicData(image)));

  if (!added.length && frames.length === parsed.frames.length) return null; // nothing to change
  const body = Buffer.concat([...frames.map((f) => encodeFrame(ver, f.id, f.flags, f.data)), ...added]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([ver, 0, 0]), synchsafeOut(body.length + PAD), body, Buffer.alloc(PAD)]);
}

// --------------------------------------------------------------------------- FLAC

async function readFlac(rd) {
  if ((await rd.read(0, 4)).toString('latin1') !== 'fLaC') return { unsupported: 'a damaged FLAC header' };
  const blocks = [];
  let pos = 4;
  for (let last = false; !last;) {
    const h = await rd.read(pos, 4);
    if (h.length < 4) return { unsupported: 'a damaged FLAC header' };
    last = !!(h[0] & 0x80);
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (len > MAX_HEADER) return { unsupported: 'an oversized FLAC header' };
    const data = Buffer.from(await rd.read(pos + 4, len));
    if (data.length < len) return { unsupported: 'a damaged FLAC header' };
    blocks.push({ type: h[0] & 0x7f, data });
    pos += 4 + len;
  }
  return { blocks, headerLen: pos };
}

function parseVorbis(buf) {
  const vlen = buf.readUInt32LE(0);
  const vendor = buf.toString('utf8', 4, 4 + vlen);
  let p = 4 + vlen;
  const n = buf.readUInt32LE(p);
  p += 4;
  const comments = [];
  for (let i = 0; i < n && p + 4 <= buf.length; i++) {
    const l = buf.readUInt32LE(p);
    comments.push(buf.toString('utf8', p + 4, p + 4 + l));
    p += 4 + l;
  }
  return { vendor, comments };
}

function buildVorbis({ vendor, comments }) {
  const v = Buffer.from(vendor, 'utf8');
  return Buffer.concat([le32(v.length), v, le32(comments.length), ...comments.map((c) => { const b = Buffer.from(c, 'utf8'); return Buffer.concat([le32(b.length), b]); })]);
}

function pictureBlock(image) {
  const mime = Buffer.from(image.mime, 'latin1');
  return Buffer.concat([be32(3), be32(mime.length), mime, be32(0), be32(0), be32(0), be32(0), be32(0), be32(image.data.length), image.data]); // front cover, no description, size unknown
}

function buildFlac(parsed, { year, genre, image }, replaceArt) {
  let blocks = parsed.blocks.filter((b) => b.type !== 1); // padding is re-added at the end
  let changed = false;

  const at = blocks.findIndex((b) => b.type === 4);
  const vorbis = at >= 0 ? parseVorbis(blocks[at].data) : { vendor: 'Flowdeck', comments: [] };
  const lacks = (re) => !vorbis.comments.some((c) => re.test(c));
  if (year && lacks(/^(date|year)=./i)) { vorbis.comments.push(`DATE=${year}`); changed = true; }
  if (genre && lacks(/^genre=./i)) { vorbis.comments.push(`GENRE=${genre}`); changed = true; }
  if (changed) {
    const block = { type: 4, data: buildVorbis(vorbis) };
    if (at >= 0) blocks[at] = block;
    else blocks.push(block);
  }

  const isFront = (b) => b.type === 6 && b.data.length >= 4 && b.data.readUInt32BE(0) === 3;
  if (replaceArt && image && blocks.some(isFront)) {
    blocks = blocks.filter((b) => !isFront(b));
    changed = true;
  }
  if (image && !blocks.some(isFront)) {
    blocks.push({ type: 6, data: pictureBlock(image) });
    changed = true;
  }
  if (!changed) return null;

  blocks.push({ type: 1, data: Buffer.alloc(PAD) });
  return Buffer.concat([
    Buffer.from('fLaC'),
    ...blocks.map((b, i) => {
      if (b.data.length > 0xffffff) throw new Error('A FLAC block would be too large');
      return Buffer.concat([Buffer.from([(i === blocks.length - 1 ? 0x80 : 0) | b.type, (b.data.length >> 16) & 255, (b.data.length >> 8) & 255, b.data.length & 255]), b.data]);
    }),
  ]);
}

const FORMATS = { mp3: { read: readId3, build: buildId3 }, flac: { read: readFlac, build: buildFlac } };
const formatOf = (file) => FORMATS[path.extname(file).slice(1).toLowerCase()];

// ------------------------------------------------------------------ safe rewrite

async function readHeader(file, reader) {
  const fh = await fsp.open(file, 'r');
  try {
    return await reader(makeReader(fh));
  } finally {
    await fh.close();
  }
}

async function readRange(file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function hashFrom(file, start) {
  const fh = await fsp.open(file, 'r');
  const hash = crypto.createHash('sha1');
  const buf = Buffer.allocUnsafe(1 << 20);
  let length = 0;
  try {
    for (let pos = start; ; pos += buf.length) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      length += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return { digest: hash.digest('hex'), length };
}

/**
 * Replace the first `oldLen` bytes of `file` with `newHeader`, keeping everything after them byte-for-byte.
 * `journal(newLen)` runs after the new file has been verified and before it replaces the original.
 */
async function rewriteHeader(file, newHeader, oldLen, { journal, verifyHeader } = {}) {
  const tmp = `${file}.flowdeck-tmp`;
  await fsp.rm(tmp, { force: true });
  const before = await hashFrom(file, oldLen);
  try {
    const src = await fsp.open(file, 'r');
    try {
      const out = await fsp.open(tmp, 'w');
      try {
        await out.write(newHeader);
        const buf = Buffer.allocUnsafe(1 << 20);
        for (let pos = oldLen; ; pos += buf.length) {
          const { bytesRead } = await src.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          await out.write(buf, 0, bytesRead);
        }
        await out.sync();
      } finally {
        await out.close();
      }
    } finally {
      await src.close();
    }
    const after = await hashFrom(tmp, newHeader.length);
    if (after.digest !== before.digest || after.length !== before.length) throw new Error('The audio did not copy exactly, so the file was left alone');
    if (verifyHeader && !(await verifyHeader(tmp))) throw new Error('The new tag could not be read back, so the file was left alone');
    if (journal) await journal(newHeader.length);
    // Antivirus or the search indexer can hold a file for a moment on Windows, so retry the swap briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(tmp, file); // atomic replace
        break;
      } catch (e) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

// -------------------------------------------------------------------- public API

/**
 * Add whatever of `{ year, genre, image }` the file lacks. `image` is `{ data, mime }`.
 * Resolves `{ changed, reason? }`; throws only for I/O problems (locked or read-only file, full disk).
 */
async function writeTags(file, wanted, { replaceArt = false, journal } = {}) {
  const fmt = formatOf(file);
  if (!fmt) return { changed: false, reason: 'format not supported' };
  const image = wanted.image && wanted.image.data.length <= MAX_ART ? wanted.image : null;
  const parsed = await readHeader(file, fmt.read);
  if (parsed.unsupported) return { changed: false, reason: `skipped: ${parsed.unsupported}` };
  const header = fmt.build(parsed, { ...wanted, image }, replaceArt);
  if (!header) return { changed: false, reason: 'already complete' };
  const original = await readRange(file, 0, parsed.headerLen);
  await rewriteHeader(file, header, parsed.headerLen, {
    verifyHeader: async (tmp) => {
      const check = await readHeader(tmp, fmt.read);
      return !check.unsupported && check.headerLen === header.length;
    },
    journal: (newLen) => journal && journal(original, newLen),
  });
  return { changed: true, headerLen: header.length };
}

/** Put back a header saved by `journal`. Refuses if the file's header is no longer the one we wrote. */
async function restoreHeader(file, original, writtenLen) {
  const fmt = formatOf(file);
  if (!fmt) throw new Error('format not supported');
  const parsed = await readHeader(file, fmt.read);
  if (parsed.unsupported || parsed.headerLen !== writtenLen) throw new Error('The file has changed since, so it was left alone');
  await rewriteHeader(file, original, parsed.headerLen);
}

const supportsTags = (file) => !!formatOf(file);

module.exports = { writeTags, restoreHeader, supportsTags, MAX_ART };

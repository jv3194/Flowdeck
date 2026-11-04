'use strict';
// Just enough of a zip reader to pull a few named files out of an archive we have already verified
// (ffmpeg's download). It never writes anywhere but the paths its caller names, so a hostile entry name
// can't escape: names are only ever compared, never used as paths.
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** The archive's entries: [{ name, method, csize, size, offset }]. Zip64 archives are refused. */
async function listZip(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let at = tail.length - 22;
    while (at >= 0 && tail.readUInt32LE(at) !== EOCD) at--;
    if (at < 0) throw new Error('Not a zip file');
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new Error('Damaged zip directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      entries.push({
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
        method: cd.readUInt16LE(p + 10),
        csize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Write one entry's contents to `dest` (streamed, so a large executable never sits in memory). */
async function extractEntry(file, entry, dest) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error('Unsupported zip compression');
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = await readAt(fh, entry.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) throw new Error('Damaged zip entry');
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = fs.createReadStream(file, { start, end: start + entry.csize - 1 });
    const out = fs.createWriteStream(dest, { mode: 0o755 });
    let written = 0;
    const count = async function* (src) {
      for await (const chunk of src) {
        written += chunk.length;
        if (written > entry.size) throw new Error('Zip entry is larger than it says');
        yield chunk;
      }
    };
    await pipeline(raw, ...(entry.method === 8 ? [zlib.createInflateRaw()] : []), count, out);
    if (written !== entry.size) throw new Error('Zip entry is shorter than it says');
  } finally {
    await fh.close();
  }
}

module.exports = { listZip, extractEntry };

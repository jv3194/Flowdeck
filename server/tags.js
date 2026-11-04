'use strict';
// Dependency-free metadata reader: ID3v1/v2 (mp3), FLAC, MP4/M4A and WAV.
// Reads only the bytes it needs, so large embedded cover art isn't pulled in while scanning.
const fs = require('fs');

const MAX_BLOCK = 32 * 1024 * 1024;

function makeReader(fh, window = 64 * 1024) {
  // Small read-ahead window: tag walking does many tiny reads. Callers that hop through a huge file
  // (like the MKV scanner) pass a smaller window so each hop doesn't drag in 64 KB.
  let start = 0;
  let win = Buffer.alloc(0);
  return {
    async read(pos, len) {
      if (len <= 0) return Buffer.alloc(0);
      if (pos >= start && pos + len <= start + win.length) return win.subarray(pos - start, pos - start + len);
      const want = Math.max(len, window);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      start = pos;
      win = buf.subarray(0, bytesRead);
      return win.subarray(0, Math.min(len, bytesRead));
    },
  };
}

const synchsafe = (b, o = 0) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function unsync(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    out[n++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decodeText(buf, enc) {
  if (enc === 1 || enc === 2) {
    let b = buf;
    let be = enc === 2;
    if (enc === 1 && b.length >= 2) {
      if (b[0] === 0xff && b[1] === 0xfe) { b = b.subarray(2); be = false; }
      else if (b[0] === 0xfe && b[1] === 0xff) { b = b.subarray(2); be = true; }
    }
    if (b.length % 2) b = b.subarray(0, b.length - 1);
    return be ? Buffer.from(b).swap16().toString('utf16le') : b.toString('utf16le');
  }
  return buf.toString(enc === 3 ? 'utf8' : 'latin1');
}

function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 4 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 4 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanTags(t) {
  const out = {};
  for (const k of ['title', 'artist', 'album', 'albumArtist']) if (t[k]) out[k] = String(t[k]).trim();
  const track = parseInt(t.track, 10);
  if (track > 0) out.track = track;
  const disc = parseInt(t.disc, 10);
  if (disc > 0) out.disc = disc;
  const year = /\d{4}/.exec(t.year || '');
  if (year) out.year = Number(year[0]);
  let genre = String(t.genre || '').replace(/^\(\d+\)\s*/, '').trim();
  if (genre && !/^\d+$/.test(genre)) out.genre = genre;
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  return out;
}

// ---------------------------------------------------------------- ID3

const ID3_MAP = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDRL: 'year', TCON: 'genre', TCO: 'genre',
};

function termIndex(buf, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i;
    return -1;
  }
  return buf.indexOf(0, from);
}

function parseApic(data, v22) {
  if (data.length < 8) return null;
  const enc = data[0];
  let p;
  let mime = 'image/jpeg';
  if (v22) {
    mime = data.toString('latin1', 1, 4).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const e = data.indexOf(0, 1);
    if (e < 0) return null;
    mime = data.toString('latin1', 1, e);
    p = e + 1;
  }
  const type = data[p++];
  const t = termIndex(data, p, enc);
  if (t < 0) return null;
  p = t + (enc === 1 || enc === 2 ? 2 : 1);
  const img = data.subarray(p);
  return { type, mime: sniffImage(img) || (/^image\//i.test(mime) ? mime : 'image/jpeg'), data: img };
}

async function readId3v2(rd, wantPicture) {
  const head = await rd.read(0, 10);
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = head[3];
  const flags = head[5];
  const size = synchsafe(head, 6);
  const end = 10 + size;
  const res = { tags: {}, tagEnd: end + (flags & 0x10 ? 10 : 0), hasPic: false, pic: null };
  const tagUnsync = !!(flags & 0x80) && ver < 4;
  const v22 = ver === 2;
  const hlen = v22 ? 6 : 10;
  let pos = 10;
  if (flags & 0x40 && !v22) {
    const eh = await rd.read(pos, 4);
    pos += ver === 4 ? synchsafe(eh) : eh.readUInt32BE(0) + 4;
  }
  while (pos + hlen <= end) {
    const fh = await rd.read(pos, hlen);
    if (fh.length < hlen || fh[0] === 0) break;
    const id = fh.toString('latin1', 0, v22 ? 3 : 4);
    const fsz = v22 ? (fh[3] << 16) | (fh[4] << 8) | fh[5] : ver === 4 ? synchsafe(fh, 4) : fh.readUInt32BE(4);
    const fflags = v22 ? 0 : fh.readUInt16BE(8);
    pos += hlen;
    if (fsz <= 0 || pos + fsz > end) break;
    const isPic = id === 'APIC' || id === 'PIC';
    const field = ID3_MAP[id];
    const skip = ver === 3 ? fflags & 0x00c0 : ver === 4 ? fflags & 0x000c : 0;
    if (!skip && (field && fsz < 8192 || isPic)) {
      if (isPic) {
        res.hasPic = true;
        if (wantPicture && fsz < MAX_BLOCK) {
          let data = Buffer.from(await rd.read(pos, fsz));
          if (ver === 4 && fflags & 1) data = data.subarray(4);
          if (tagUnsync || (ver === 4 && fflags & 2)) data = unsync(data);
          const pic = parseApic(data, v22);
          // Prefer the front cover (type 3); otherwise keep the first picture we see.
          if (pic && (!res.pic || (pic.type === 3 && res.pic.type !== 3))) res.pic = pic;
        }
      } else if (!res.tags[field]) {
        let data = await rd.read(pos, fsz);
        if (ver === 4 && fflags & 1) data = data.subarray(4);
        if (tagUnsync || (ver === 4 && fflags & 2)) data = unsync(data);
        const text = decodeText(data.subarray(1), data[0]).split('\0').map((s) => s.trim()).filter(Boolean);
        if (text.length) res.tags[field] = text.join(' / ');
      }
    }
    pos += fsz;
  }
  return res;
}

async function readId3v1(rd, size) {
  if (size < 128) return null;
  const b = await rd.read(size - 128, 128);
  if (b.length < 128 || b.toString('latin1', 0, 3) !== 'TAG') return null;
  const s = (a, z) => b.toString('latin1', a, z).replace(/\0[\s\S]*$/, '').trim();
  const out = { title: s(3, 33), artist: s(33, 63), album: s(63, 93), year: s(93, 97) };
  if (b[125] === 0 && b[126] !== 0) out.track = b[126];
  return out;
}

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

async function mp3Duration(rd, from, size, hasV1) {
  const buf = await rd.read(from, 64 * 1024);
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = layer III
    const br = (buf[i + 2] >> 4) & 15;
    const sr = (buf[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) continue;
    const bitrate = MP3_BITRATES[ver === 3 ? 1 : 2][br] * 1000;
    const rate = MP3_RATES[ver][sr];
    const spf = ver === 3 ? 1152 : 576;
    const mono = ((buf[i + 3] >> 6) & 3) === 3;
    const side = ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = i + 4 + side + (buf[i + 1] & 1 ? 0 : 2);
    const tag = buf.toString('latin1', xing, xing + 4);
    if ((tag === 'Xing' || tag === 'Info') && buf[xing + 7] & 1) return (buf.readUInt32BE(xing + 8) * spf) / rate;
    if (buf.toString('latin1', i + 36, i + 40) === 'VBRI') return (buf.readUInt32BE(i + 50) * spf) / rate;
    const audioBytes = size - (from + i) - (hasV1 ? 128 : 0);
    return audioBytes > 0 ? (audioBytes * 8) / bitrate : undefined;
  }
  return undefined;
}

async function readMp3(rd, size, wantPicture) {
  const v2 = await readId3v2(rd, wantPicture);
  const v1 = !v2 || !v2.tags.title ? await readId3v1(rd, size) : null;
  const tags = { ...(v1 || {}), ...(v2 ? v2.tags : {}) };
  const out = cleanTags(tags);
  const duration = await mp3Duration(rd, v2 ? v2.tagEnd : 0, size, !!v1);
  if (duration) out.duration = duration;
  if (v2 && v2.hasPic) out.hasPic = true;
  return { tags: out, pic: v2 && v2.pic };
}

// ---------------------------------------------------------------- FLAC

async function readFlac(rd, size, wantPicture) {
  const tags = {};
  const out = {};
  let pic = null;
  let pos = 4;
  for (let last = false; !last;) {
    const h = await rd.read(pos, 4);
    if (h.length < 4) break;
    last = !!(h[0] & 0x80);
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    pos += 4;
    if (type === 0 && len >= 18) {
      const b = await rd.read(pos, 18);
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14);
      if (rate && total) out.duration = total / rate;
    } else if (type === 4 && len < 4 * 1024 * 1024) {
      const b = await rd.read(pos, len);
      let p = 4 + b.readUInt32LE(0);
      const n = b.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < n && p + 4 <= b.length; i++) {
        const l = b.readUInt32LE(p);
        p += 4;
        const kv = b.toString('utf8', p, p + l);
        p += l;
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const key = kv.slice(0, eq).toUpperCase();
        const val = kv.slice(eq + 1);
        const map = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', TRACKNUMBER: 'track', DISCNUMBER: 'disc', DATE: 'year', YEAR: 'year', GENRE: 'genre' };
        if (map[key] && !tags[map[key]]) tags[map[key]] = val;
      }
    } else if (type === 6) {
      out.hasPic = true;
      if (wantPicture && len < MAX_BLOCK) {
        const b = await rd.read(pos, len);
        const picType = b.readUInt32BE(0);
        const mlen = b.readUInt32BE(4);
        const dlen = b.readUInt32BE(8 + mlen);
        const off = 12 + mlen + dlen + 16;
        const dataLen = b.readUInt32BE(off);
        const data = b.subarray(off + 4, off + 4 + dataLen);
        if (!pic || (picType === 3 && pic.type !== 3)) pic = { type: picType, mime: sniffImage(data) || b.toString('latin1', 8, 8 + mlen), data };
      }
    }
    pos += len;
  }
  return { tags: { ...cleanTags(tags), ...out }, pic };
}

// ---------------------------------------------------------------- MP4 / M4A

function* atoms(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    let sz = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (sz === 1) { sz = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (sz === 0) sz = end - p;
    if (sz < hdr || p + sz > end) break;
    yield { type, start: p + hdr, end: p + sz };
    p += sz;
  }
}

async function readMp4(rd, size, wantPicture) {
  let moov = null;
  for (let pos = 0; pos + 8 <= size;) {
    const h = await rd.read(pos, 16);
    if (h.length < 8) break;
    let sz = h.readUInt32BE(0);
    let hdr = 8;
    if (sz === 1 && h.length >= 16) { sz = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (sz === 0) sz = size - pos;
    if (sz < hdr) break;
    if (h.toString('latin1', 4, 8) === 'moov') {
      if (sz - hdr <= MAX_BLOCK) moov = Buffer.from(await rd.read(pos + hdr, sz - hdr));
      break;
    }
    pos += sz;
  }
  if (!moov) return { tags: {}, pic: null };
  const tags = {};
  const out = {};
  let pic = null;
  for (const a of atoms(moov)) {
    if (a.type === 'mvhd') {
      const v = moov[a.start];
      const ts = v === 1 ? moov.readUInt32BE(a.start + 20) : moov.readUInt32BE(a.start + 12);
      const dur = v === 1 ? Number(moov.readBigUInt64BE(a.start + 24)) : moov.readUInt32BE(a.start + 16);
      if (ts && dur) out.duration = dur / ts;
    } else if (a.type === 'udta') {
      for (const m of atoms(moov, a.start, a.end)) {
        if (m.type !== 'meta') continue;
        for (const il of atoms(moov, m.start + 4, m.end)) {
          if (il.type !== 'ilst') continue;
          for (const it of atoms(moov, il.start, il.end)) {
            for (const d of atoms(moov, it.start, it.end)) {
              if (d.type !== 'data') continue;
              const payload = moov.subarray(d.start + 8, d.end);
              const text = () => payload.toString('utf8').trim();
              switch (it.type) {
                case '©nam': tags.title = text(); break;
                case '©ART': tags.artist = text(); break;
                case '©alb': tags.album = text(); break;
                case 'aART': tags.albumArtist = text(); break;
                case '©day': tags.year = text(); break;
                case '©gen': tags.genre = text(); break;
                case 'trkn': if (payload.length >= 4) tags.track = payload.readUInt16BE(2); break;
                case 'disk': if (payload.length >= 4) tags.disc = payload.readUInt16BE(2); break;
                case 'covr':
                  out.hasPic = true;
                  if (wantPicture && !pic) pic = { type: 3, mime: sniffImage(payload) || 'image/jpeg', data: payload };
                  break;
                default:
              }
            }
          }
        }
      }
    }
  }
  return { tags: { ...cleanTags(tags), ...out }, pic };
}

// ---------------------------------------------------------------- WAV

async function readWav(rd, size) {
  const h = await rd.read(0, 12);
  if (h.length < 12 || h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') return { tags: {}, pic: null };
  let pos = 12;
  let byteRate = 0;
  for (let i = 0; i < 64; i++) {
    const c = await rd.read(pos, 8);
    if (c.length < 8) break;
    const id = c.toString('latin1', 0, 4);
    const len = c.readUInt32LE(4);
    if (id === 'fmt ') byteRate = (await rd.read(pos + 8, 16)).readUInt32LE(8);
    else if (id === 'data') {
      const bytes = Math.min(len, size - (pos + 8));
      return { tags: byteRate ? { duration: bytes / byteRate } : {}, pic: null };
    }
    pos += 8 + len + (len & 1);
  }
  return { tags: {}, pic: null };
}

// ---------------------------------------------------------------- public API

async function parse(file, ext, wantPicture) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const rd = makeReader(fh);
    switch (ext) {
      case 'mp3': return await readMp3(rd, size, wantPicture);
      case 'flac': return await readFlac(rd, size, wantPicture);
      case 'm4a': case 'm4b': case 'mp4': case 'm4v': case 'mov': return await readMp4(rd, size, wantPicture);
      case 'wav': return await readWav(rd, size);
      default: return { tags: {}, pic: null };
    }
  } finally {
    await fh.close();
  }
}

/** Tags + duration for a file. Never throws: unreadable files just yield `{}`. */
async function readTags(file, ext) {
  try {
    return (await parse(file, ext, false)).tags;
  } catch {
    return {};
  }
}

/** Embedded cover art as `{ mime, data }`, or null. */
async function readPicture(file, ext) {
  try {
    const { pic } = await parse(file, ext, true);
    return pic ? { mime: pic.mime, data: Buffer.from(pic.data) } : null;
  } catch {
    return null;
  }
}

module.exports = { readTags, readPicture, sniffImage, makeReader };

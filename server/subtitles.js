'use strict';
// Subtitles as plain cues: [{ s, e, t }] (start and end in seconds, text with only <i> <b> <u> tags and \n).
// The player draws these itself, so nothing here ever produces markup it could be tricked into running.
const fsp = require('fs').promises;
const path = require('path');

// ----------------------------------------------------------------- languages

// [ISO 639-1, ...ISO 639-2 variants]. Tracks are matched by the two-letter code.
const LANGS = [
  ['en', 'eng'], ['es', 'spa'], ['fr', 'fra', 'fre'], ['de', 'deu', 'ger'], ['it', 'ita'], ['pt', 'por'], ['nl', 'nld', 'dut'],
  ['sv', 'swe'], ['no', 'nor', 'nob', 'nno'], ['da', 'dan'], ['fi', 'fin'], ['pl', 'pol'], ['cs', 'ces', 'cze'], ['hu', 'hun'],
  ['ro', 'ron', 'rum'], ['el', 'ell', 'gre'], ['tr', 'tur'], ['ru', 'rus'], ['uk', 'ukr'], ['bg', 'bul'], ['sr', 'srp'],
  ['hr', 'hrv'], ['sl', 'slv'], ['sk', 'slk', 'slo'], ['ar', 'ara'], ['he', 'heb'], ['fa', 'fas', 'per'], ['hi', 'hin'],
  ['th', 'tha'], ['vi', 'vie'], ['id', 'ind'], ['ms', 'msa', 'may'], ['zh', 'zho', 'chi'], ['ja', 'jpn'], ['ko', 'kor'],
  ['ca', 'cat'], ['eu', 'eus', 'baq'], ['is', 'isl', 'ice'], ['lt', 'lit'], ['lv', 'lav'], ['et', 'est'], ['bn', 'ben'],
  ['ta', 'tam'], ['te', 'tel'],
];
const BY_CODE = new Map();
for (const [two, ...rest] of LANGS) {
  BY_CODE.set(two, two);
  for (const r of rest) BY_CODE.set(r, two);
}
const BY_NAME = new Map();
try {
  const names = new Intl.DisplayNames(['en'], { type: 'language' });
  for (const [two] of LANGS) BY_NAME.set(names.of(two).toLowerCase(), two);
} catch {
  /* no ICU names: codes still work */
}

/** "eng", "en-US", "English", "pt" → "en"/"pt"; null if it isn't a language we recognise. */
function normalizeLang(token, { allowTwoLetter = true } = {}) {
  const t = String(token || '').toLowerCase().split(/[-_]/)[0];
  if (!t || t === 'und' || t === 'mul' || t === 'zxx') return null;
  if (t.length === 2 && !allowTwoLetter) return null;
  return BY_CODE.get(t) || BY_NAME.get(t) || null;
}

// Pre-Unicode subtitle files are usually in their language's Windows code page.
const CODEPAGE = {
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', el: 'windows-1253', tr: 'windows-1254',
  he: 'windows-1255', ar: 'windows-1256', fa: 'windows-1256', pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250',
  ro: 'windows-1250', hr: 'windows-1250', sl: 'windows-1250', sk: 'windows-1250', lt: 'windows-1257', lv: 'windows-1257',
  et: 'windows-1257', th: 'windows-874', vi: 'windows-1258', zh: 'gbk', ja: 'shift_jis', ko: 'euc-kr',
};

/** Bytes to text: honours BOMs, accepts valid UTF-8, else falls back to the language's code page (default Windows-1252). */
function decodeSubtitle(buf, lang) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder(CODEPAGE[lang] || 'windows-1252').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

// ------------------------------------------------------------------- text

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };

/** Drop closing tags that have no matching opener (e.g. left behind when `<b onclick=…>` was stripped). */
function dropOrphanClosers(s) {
  const open = { i: 0, b: 0, u: 0 };
  return s.replace(/<(\/?)([ibu])>/g, (m, slash, tag) => {
    if (!slash) {
      open[tag]++;
      return m;
    }
    return open[tag]-- > 0 ? m : (open[tag] = 0, '');
  });
}

/** Keep <i> <b> <u>, drop every other tag and ASS override, decode entities, trim lines. */
function cleanText(raw) {
  const text = dropOrphanClosers(String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '') // any tag that isn't exactly <i> <b> <u> or their closers
    .replace(/<(\/?)([ibu])>/gi, (_, slash, tag) => `<${slash}${tag.toLowerCase()}>`))
    .replace(/\{\\[^}]*\}/g, '')
    // Entities last, so a decoded "<" is never mistaken for a tag.
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => (Number(n) > 31 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => (parseInt(n, 16) > 31 && parseInt(n, 16) < 0x110000 ? String.fromCodePoint(parseInt(n, 16)) : ''));
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const MAX_CUES = 40000;

function finish(cues) {
  const out = [];
  for (const c of cues) {
    if (!c.t || !Number.isFinite(c.s) || !Number.isFinite(c.e)) continue;
    out.push({ s: Math.max(0, c.s), e: c.e > c.s ? c.e : c.s + 2, t: c.t });
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return out.slice(0, MAX_CUES);
}

// ------------------------------------------------------------ SRT and WebVTT

// One pattern for both: hours optional (VTT), separator "," (SRT) or "." (both).
const TIMING = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const seconds = (h, m, s, f) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(String(f).padEnd(3, '0')) / 1000;

function parseTimed(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, stray index
    const m = TIMING.exec(lines[at]);
    cues.push({ s: seconds(m[1], m[2], m[3], m[4]), e: seconds(m[5], m[6], m[7], m[8]), t: cleanText(lines.slice(at + 1).join('\n')) });
  }
  return finish(cues);
}

// ---------------------------------------------------------------- ASS / SSA

const assTime = (s) => {
  const m = /^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : NaN;
};

/** Dialogue text → cleaned cue text. Style overrides become <i>/<b>/<u>; vector drawings are dropped. */
function assText(raw) {
  if (/\\p[1-9]/.test(raw)) return '';
  const withTags = String(raw)
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/\{([^}]*)\}/g, (_, block) => {
      let out = '';
      for (const [, tag, on] of block.matchAll(/\\([ibu])(\d+)/g)) out += on === '0' ? `</${tag}>` : `<${tag}>`;
      return out;
    });
  return cleanText(withTags);
}

function splitLimited(s, sep, n) {
  const parts = [];
  let rest = s;
  while (parts.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

function parseAss(text) {
  const cues = [];
  let inEvents = false;
  let fields = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) {
      fields = line.slice(7).split(',').map((x) => x.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue; // Comment: lines are not shown
    const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = splitLimited(line.slice(9).trimStart(), ',', f.length);
    cues.push({ s: assTime(parts[f.indexOf('start')]), e: assTime(parts[f.indexOf('end')]), t: assText(parts[f.indexOf('text')] || '') });
  }
  return finish(cues);
}

/** One subtitle file's bytes → cues. `ext` picks the parser; `lang` helps choose a code page for old files. */
function parseSubtitle(buf, ext, lang) {
  const text = decodeSubtitle(buf, lang);
  return /^(ass|ssa)$/i.test(ext) || /^\s*\[Script Info\]/i.test(text) ? parseAss(text) : parseTimed(text);
}

// ------------------------------------------------------------------ sidecars

const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv']);
const SUB_DIR = /^(subs?|subtitles?)$/i;
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

/** Language and flags from what follows the video's name: ".en", ".eng.forced", "_English_SDH", "2_Spanish". */
function describeName(rest, { allowTwoLetter = true } = {}) {
  let lang = null;
  let forced = false;
  let sdh = false;
  const extra = []; // words that aren't a language or a flag, e.g. "Commentary"
  for (const token of rest.split(/[.\-_ \[\]()]+/).filter(Boolean)) {
    const t = token.toLowerCase();
    if (t === 'forced') forced = true;
    else if (t === 'sdh' || t === 'hi' || t === 'cc') sdh = true;
    else if (!lang && normalizeLang(t, { allowTwoLetter })) lang = normalizeLang(t, { allowTwoLetter });
    else if (!/^\d+$/.test(t)) extra.push(token); // a bare number is just an index ("2_English")
  }
  return { lang, forced, sdh, name: extra.join(' ') };
}

/**
 * Subtitle files that belong to a video: next to it or in a Subs/ folder, named like the video
 * ("Movie.en.srt"), or any subtitle file when the folder holds a single video.
 */
async function findSidecars(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const baseLc = base.toLowerCase();
  const list = async (d) => {
    try {
      return await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const ents = await list(dir);
  const onlyVideo = ents.filter((e) => e.isFile() && VIDEO_EXT.has(extOf(e.name))).length === 1;
  const found = [];

  const take = (full, name, related) => {
    const ext = extOf(name);
    if (!SUB_EXT.has(ext)) return;
    const stem = name.slice(0, -(ext.length + 1));
    let rest = null;
    if (stem.toLowerCase() === baseLc) rest = '';
    else if (stem.toLowerCase().startsWith(baseLc) && /^[.\-_ ]/.test(stem.slice(base.length))) rest = stem.slice(base.length);
    else if (related || onlyVideo) rest = stem;
    if (rest === null) return;
    const prefixed = rest === '' || stem.toLowerCase().startsWith(baseLc);
    found.push({ file: full, ext, ...describeName(rest, { allowTwoLetter: prefixed }) });
  };

  const sorted = (es) => es.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of sorted(ents)) if (e.isFile()) take(path.join(dir, e.name), e.name, false);
  for (const d of sorted(ents)) {
    if (!d.isDirectory() || !SUB_DIR.test(d.name)) continue;
    const subDir = path.join(dir, d.name);
    for (const e of sorted(await list(subDir))) {
      if (e.isFile()) take(path.join(subDir, e.name), e.name, false);
      // Scene releases: Subs/<video name>/2_English.srt
      else if (e.isDirectory() && (e.name.toLowerCase().startsWith(baseLc) || onlyVideo)) {
        for (const f of sorted(await list(path.join(subDir, e.name)))) if (f.isFile()) take(path.join(subDir, e.name, f.name), f.name, true);
      }
    }
  }
  return found;
}

module.exports = { parseSubtitle, parseTimed, parseAss, assText, finishCues: finish, decodeSubtitle, cleanText, normalizeLang, findSidecars, describeName, SUB_EXT };

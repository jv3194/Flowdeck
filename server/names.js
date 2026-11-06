'use strict';
// Turning messy file names into something searchable, and scoring how well a search hit matches.
const path = require('path');

/** Lowercase, accent-free, punctuation-free form used to compare titles. */
function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // (Deluxe Edition), [Remastered]
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** 0..1 similarity of two titles: exact after normalising = 1, whole-word containment is strong, else bigram Dice. */
function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  let best = 0;
  if (` ${long} `.includes(` ${short} `)) best = 0.7 + 0.25 * (short.length / long.length);
  if (short.length < 2) return best;
  const bx = bigrams(x);
  const by = bigrams(y);
  let hit = 0;
  for (const [g, n] of bx) hit += Math.min(n, by.get(g) || 0);
  const dice = (2 * hit) / (x.length - 1 + (y.length - 1));
  return Math.max(best, dice);
}

// ------------------------------------------------------------------ video names

const JUNK = /[\s.(\[_-](2160p|1080[pi]|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|bdrip|brrip|web-?dl|web-?rip|webrip|hdtv|dvdrip|dvdscr|hdrip|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|aac|ac3|eac3|dts|ddp?5\.1|remux|proper|repack|extended|unrated|directors?[.\s]cut|imax|multi|dual|internal)([\s.)\]_-]|$).*$/i;
const CAMERA = /^(vid|mov|img|pxl|dsc|mvi|dji|gopr|screen[ _-]?recording|video)[ _-]?\d|^\d{8}[ _-]\d{4,6}$|^(?=.*[_ -])[\d_ -]+$|^\d{6,}$/i; // a short bare number ("1917", "300") is a movie title, not a camera file
const SEASON_DIR = /^(season|series|s)[ ._-]?(\d{1,2})$/i;

const clean = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '');
const stripYear = (s) => s.replace(/[(\[]\s*(19|20)\d{2}\s*[)\]]\s*$/, '').trim();

/** "Doctor Who (2005)", "Doctor Who [2005]" or "Doctor Who 2005" → { name: 'Doctor Who', year: 2005 }. A name that is only a number ("1923") keeps it. */
function splitYear(s) {
  const m = /^(.+?)[\s._-]*(?:[(\[]\s*((?:19|20)\d{2})\s*[)\]]|\s((?:19|20)\d{2}))\s*$/.exec(s);
  return m ? { name: m[1].trim(), year: Number(m[2] || m[3]) } : { name: s, year: undefined };
}

const squash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function episode(show, season, number, tail, year) {
  const out = { type: 'episode', title: show, show, season: Number(season), episode: Number(number) };
  if (year) out.year = year; // tells remakes apart: Doctor Who (1963) and (2005)
  const hint = clean(tail.replace(JUNK, ' '));
  if (hint) out.epHint = hint;
  return out;
}

function folderTitle(dir, root) {
  // Nearest folder under the library root that isn't a "Season 2" folder.
  let d = dir;
  while (d && d.length > root.length) {
    const name = path.basename(d);
    if (!SEASON_DIR.test(name)) return clean(name);
    d = path.dirname(d);
  }
  return '';
}

/**
 * Guess what a video file is from its name and folders.
 * @returns {{type: 'movie'|'episode'|'clip', title: string, year?: number, show?: string, season?: number, episode?: number, epHint?: string}}
 */
function parseVideoName(file, root = path.dirname(file)) {
  const base = path.basename(file, path.extname(file));
  const dir = path.dirname(file);
  const spaced = base.replace(/[._]+/g, ' ');

  const tv =
    /^(.*?)[\s._-]*\bS(\d{1,2})[\s._-]?E(\d{1,3})(?:[\s._-]?E\d{1,3})*(.*)$/i.exec(spaced) ||
    /^(.*?)[\s._-]*\b(\d{1,2})x(\d{2,3})\b(.*)$/i.exec(spaced) ||
    /^(.*?)[\s._-]*\bSeason[\s._-]?(\d{1,2})[\s._-]*Episode[\s._-]?(\d{1,3})(.*)$/i.exec(spaced);
  if (tv) {
    let { name: show, year } = splitYear(clean(tv[1]));
    const folder = splitYear(folderTitle(dir, root));
    if (!show) ({ name: show, year } = folder);
    else if (!year && folder.year && squash(folder.name) === squash(show)) year = folder.year; // "Doctor Who (2005)/S01E01.mkv"
    return episode(show, tv[2], tv[3], tv[4], year);
  }

  // "03 - Episode Title.mkv" inside "Show/Season 2/"
  const inSeason = SEASON_DIR.exec(path.basename(dir));
  const lead = /^(?:E|Ep\.?\s?)?(\d{1,3})[\s._-]+(.+)$/i.exec(spaced);
  if (inSeason && lead) {
    const { name: show, year } = splitYear(folderTitle(path.dirname(dir), root));
    if (show) return episode(show, inSeason[2], lead[1], lead[2], year);
  }

  if (CAMERA.test(base)) return { type: 'clip', title: clean(base) };

  // Movie: cut at the release junk, then pull a trailing year off the title.
  let text = spaced.replace(JUNK, ' ');
  let year;
  const years = [...text.matchAll(/(?:^|[\s(\[])((?:19|20)\d{2})(?=$|[\s)\]])/g)].filter((m) => m.index > 0);
  if (years.length) {
    const m = years[years.length - 1];
    year = Number(m[1]);
    text = text.slice(0, m.index);
  }
  let title = clean(text.replace(/[(\[]+\s*$/, ''));
  if (title.length < 2 || /^(movie|video|film|untitled)$/i.test(title)) {
    const folder = folderTitle(dir, root);
    const fy = /[(\[]\s*((?:19|20)\d{2})\s*[)\]]\s*$/.exec(folder);
    title = stripYear(folder) || title;
    if (fy && !year) year = Number(fy[1]);
  }
  return year ? { type: 'movie', title, year } : { type: 'movie', title };
}

module.exports = { normalize, similarity, parseVideoName, SEASON_DIR };

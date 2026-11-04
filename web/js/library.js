// Turns the server's flat file list into the three shelves the UI shows:
// albums (music), movies + shows (videos) and photos.
import { coverUrl } from './api.js';
import { fmtBytes, fmtLong, fmtTime, hashHue } from './util.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a || '', b || '');
const pad = (n) => String(n).padStart(2, '0');

export const CATEGORIES = [
  { id: 'music', label: 'Music', icon: 'music', ratio: 1, hue: 322, empty: 'No music yet' },
  { id: 'video', label: 'Videos', icon: 'film', ratio: 2 / 3, hue: 214, empty: 'No videos yet' },
  { id: 'photo', label: 'Photos', icon: 'image', ratio: 4 / 3, hue: 168, empty: 'No photos yet' },
];

export const SORTS = {
  music: [['artist', 'Artist'], ['title', 'Album title'], ['added', 'Recently added']],
  video: [['title', 'Name'], ['added', 'Recently added'], ['duration', 'Length']],
  photo: [['date', 'Date taken'], ['title', 'Name']],
};
export const DEFAULT_SORT = { music: 'artist', video: 'title', photo: 'date' };

// ------------------------------------------------------------------- music

const stripDisc = (dir) => dir.replace(/[\\/](cd|disc|disk)\s*\d+\s*$/i, '');

function albumKey(t) {
  if (!t.album) return `|unknown|${t.dir.toLowerCase()}`;
  const aa = (t.albumArtist || '').toLowerCase();
  // Without an album-artist tag, tracks of one album share a folder (CD1/CD2 folders are merged).
  return `${aa}|${t.album.toLowerCase()}|${aa ? '' : stripDisc(t.dir).toLowerCase()}`;
}

function buildAlbums(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const key = albumKey(t);
    let a = map.get(key);
    if (!a) map.set(key, (a = { id: `album:${key}`, kind: 'album', tracks: [], album: t.album || 'Unknown Album' }));
    a.tracks.push(t);
  }
  const albums = [];
  for (const a of map.values()) {
    a.tracks.sort((x, y) => (x.disc || 1) - (y.disc || 1) || (x.track || 999) - (y.track || 999) || cmp(x.name, y.name));
    const artists = new Set(a.tracks.map((t) => t.artist).filter(Boolean));
    const aa = a.tracks.find((t) => t.albumArtist)?.albumArtist;
    a.title = a.album;
    a.artist = aa || (artists.size === 1 ? [...artists][0] : artists.size > 1 ? 'Various Artists' : 'Unknown Artist');
    a.year = a.tracks.find((t) => t.year)?.year;
    a.genre = a.tracks.find((t) => t.genre)?.genre;
    a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    a.added = Math.max(...a.tracks.map((t) => t.added || 0));
    const withCover = a.tracks.find((t) => t.cover);
    a.coverId = withCover ? withCover.id : null;
    a.coverV = withCover ? withCover.cv : 0;
    a.variousArtists = artists.size > 1 && !aa;
    a.ids = a.tracks.map((t) => t.id);
    a.fetched = Math.max(...a.tracks.map((t) => t.fetched || 0));
    a.saved = a.tracks.some((t) => t.saved);
    albums.push(a);
  }
  return albums;
}

// ------------------------------------------------------------------ videos

const showKey = (s) =>
  String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');

function decorateMovie(v) {
  const p = v.parsed || { title: v.name };
  const title = v.meta?.title || p.title || v.name;
  const year = v.meta?.year || p.year;
  return { ...v, entryType: 'movie', title, year, displayTitle: year ? `${title} (${year})` : title };
}

function decorateEpisode(e, show) {
  const label = e.meta?.epTitle || e.parsed.epHint;
  e.entryType = 'episode';
  e.title = label || `Episode ${e.parsed.episode}`;
  e.displayTitle = `${show.title} · S${pad(e.parsed.season)}E${pad(e.parsed.episode)}${label ? ` · ${label}` : ''}`;
}

function buildVideos(videos) {
  const movies = [];
  const shows = new Map();
  for (const v of videos) {
    const p = v.parsed;
    if (p?.type === 'episode' && p.show) {
      // Prefer the looked-up name, so differently spelled file names still land in one show.
      const name = v.meta?.show?.name || p.show;
      const key = showKey(name);
      let s = shows.get(key);
      if (!s) shows.set(key, (s = { id: `show:${key}`, kind: 'show', title: name, parsedShow: p.show, episodes: [] }));
      s.episodes.push(v);
    } else {
      movies.push(decorateMovie(v));
    }
  }
  for (const s of shows.values()) {
    s.episodes.sort((a, b) => a.parsed.season - b.parsed.season || a.parsed.episode - b.parsed.episode || cmp(a.name, b.name));
    s.meta = s.episodes.find((e) => e.meta?.show)?.meta.show;
    if (s.meta?.name) s.title = s.meta.name;
    for (const e of s.episodes) decorateEpisode(e, s);
    s.seasons = [...new Set(s.episodes.map((e) => e.parsed.season))];
    s.year = s.meta?.year;
    s.duration = s.episodes.reduce((sum, e) => sum + (e.duration || 0), 0);
    s.added = Math.max(...s.episodes.map((e) => e.added || 0));
    s.ids = s.episodes.map((e) => e.id);
    s.fetched = Math.max(...s.episodes.map((e) => e.fetched || 0));
  }
  return [...movies, ...shows.values()];
}

// ------------------------------------------------------------------ shelves

function sortList(list, category, sort) {
  const by = {
    music: { artist: (a, b) => cmp(a.artist, b.artist) || (a.year || 0) - (b.year || 0) || cmp(a.title, b.title), title: (a, b) => cmp(a.title, b.title), added: (a, b) => b.added - a.added },
    video: { title: (a, b) => cmp(a.title, b.title), added: (a, b) => b.added - a.added, duration: (a, b) => (b.duration || 0) - (a.duration || 0) },
    photo: { date: (a, b) => b.mtime - a.mtime, title: (a, b) => cmp(a.title, b.title) },
  };
  return list.sort(by[category][sort] || by[category][DEFAULT_SORT[category]]);
}

export function buildCollections(items, sorts = {}) {
  const s = { ...DEFAULT_SORT, ...sorts };
  const byId = new Map();
  for (const it of items) byId.set(it.id, it);
  const music = sortList(buildAlbums(items.filter((i) => i.kind === 'audio')), 'music', s.music);
  const video = sortList(buildVideos(items.filter((i) => i.kind === 'video')), 'video', s.video);
  const photo = sortList(items.filter((i) => i.kind === 'image').map((p) => ({ ...p, title: p.name })), 'photo', s.photo);
  return { music, video, photo, byId };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stars = (r) => (r ? `★ ${r}` : '');

/** Everything the flow/grid needs to draw one entry. `contain` letterboxes art that isn't poster-shaped. */
export function describe(category, e) {
  if (category === 'music') {
    const n = e.tracks.length;
    return {
      title: e.title,
      subtitle: e.artist,
      chips: [e.year, e.genre, plural(n, 'track'), fmtLong(e.duration)].filter(Boolean),
      cover: e.coverId ? coverUrl(e.coverId, e.coverV) : null,
      hue: hashHue(`${e.artist}${e.title}`),
    };
  }
  if (category === 'video') {
    if (e.kind === 'show') {
      const poster = e.episodes.find((x) => x.poster);
      const art = poster || e.episodes.find((x) => x.cover);
      return {
        title: e.title,
        subtitle: [e.year, plural(e.seasons.length, 'season'), plural(e.episodes.length, 'episode')].filter(Boolean).join('  ·  '),
        chips: [e.meta?.network, ...(e.meta?.genres || []).slice(0, 2), stars(e.meta?.rating)].filter(Boolean),
        blurb: e.meta?.summary,
        cover: art ? coverUrl(art.id, art.cv) : null,
        contain: !poster,
        hue: hashHue(e.title),
      };
    }
    const res = e.height ? `${e.height}p` : '';
    return {
      title: e.title,
      subtitle: [e.year, e.meta?.genres?.[0], e.duration ? fmtTime(e.duration) : '', res].filter(Boolean).join('  ·  ') || e.dir.split(/[\\/]/).pop() || '',
      chips: [stars(e.meta?.rating), e.ext.toUpperCase(), fmtBytes(e.size)].filter(Boolean),
      blurb: e.meta?.summary,
      cover: e.cover ? coverUrl(e.id, e.cv) : null,
      contain: !e.poster,
      hue: hashHue(e.title),
    };
  }
  const dims = e.width && e.height ? `${e.width} × ${e.height}` : '';
  return {
    title: e.title,
    subtitle: [dims, new Date(e.mtime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })].filter(Boolean).join('  ·  '),
    chips: [e.ext.toUpperCase(), fmtBytes(e.size)].filter(Boolean),
    cover: e.cover ? coverUrl(e.id, e.cv) : `/media/${e.id}`,
    hue: hashHue(e.title),
  };
}

/** The text type-to-jump matches against: whatever the shelf is currently sorted by. */
export const jumpLabel = (category, sort, e) => (category === 'music' && sort === 'artist' ? e.artist : e.title) || '';

/** What a lookup needs to know about a shelf entry, or null if it can't be looked up. */
export function lookupTarget(category, e) {
  if (category === 'music') {
    return { type: 'album', ids: e.ids, artist: e.variousArtists ? '' : e.artist, album: e.title };
  }
  if (category === 'video' && e.kind === 'show') {
    return { type: 'show', show: e.parsedShow, year: e.episodes.find((x) => x.parsed.year)?.parsed.year, episodes: e.episodes.map((x) => ({ id: x.id, season: x.parsed.season, episode: x.parsed.episode })) };
  }
  if (category === 'video' && e.parsed?.type === 'movie') {
    return { type: 'movie', id: e.id, title: e.parsed.title, year: e.parsed.year };
  }
  return null; // photos, home clips
}

/** Ids whose fetched data a "remove" should clear. */
export const entryIds = (category, e) => (category === 'music' ? e.ids : e.kind === 'show' ? e.ids : [e.id]);

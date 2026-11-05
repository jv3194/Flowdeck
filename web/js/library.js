// Turns the server's flat file list into the three shelves the UI shows:
// albums (music), movies + shows (videos) and photos.
import { coverUrl } from './api.js';
import { clamp, fmtBytes, fmtLong, fmtTime, hashHue } from './util.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a || '', b || '');
const pad = (n) => String(n).padStart(2, '0');

export const CATEGORIES = [
  { id: 'music', label: 'Music', icon: 'music', ratio: 1, hue: 322, empty: 'No music yet' },
  // Audiobooks and podcasts, kept out of Music: it behaves like Music in every way (see baseCategory), but is its own shelf.
  { id: 'spoken', label: 'Spoken', icon: 'book', ratio: 1, hue: 262, empty: 'No audiobooks or podcasts' },
  // Albums that have no cover art (none in the files, none found online): behaves like Music in every way (see baseCategory).
  { id: 'nocover', label: 'No cover art', icon: 'music', ratio: 1, hue: 38, empty: 'Every album has its cover art' },
  { id: 'video', label: 'Videos', icon: 'film', ratio: 2 / 3, hue: 214, empty: 'No videos yet' },
  // Movies and shows you have started, most recent first. Like "No artwork", a shelf of videos that only appears when it has some.
  { id: 'continue', label: 'Continue', icon: 'play', ratio: 2 / 3, hue: 160, empty: 'Nothing in progress' },
  // Videos that got no artwork online: it behaves like Videos in every way (see baseCategory), but is its own shelf.
  { id: 'unmatched', label: 'No artwork', icon: 'film', ratio: 2 / 3, hue: 38, empty: 'Every video found its artwork' },
  { id: 'photo', label: 'Photos', icon: 'image', ratio: 4 / 3, hue: 168, empty: 'No photos yet' },
  // The same photos grouped by the folder they are in. Only shown once there is more than one folder to choose from.
  { id: 'albums', label: 'Albums', icon: 'folder', ratio: 4 / 3, hue: 190, empty: 'No photo folders yet' },
];

export const SORTS = {
  music: [['artist', 'Artist'], ['title', 'Album title'], ['added', 'Recently added']],
  nocover: [['artist', 'Artist'], ['title', 'Album title'], ['added', 'Recently added']],
  spoken: [['artist', 'Author / show'], ['title', 'Title'], ['added', 'Recently added']],
  video: [['title', 'Name'], ['added', 'Recently added'], ['duration', 'Length']],
  unmatched: [['title', 'Name'], ['added', 'Recently added'], ['duration', 'Length']],
  continue: [['recent', 'Recently watched']],
  photo: [['date', 'Date modified'], ['title', 'Name']],
  albums: [['date', 'Newest'], ['title', 'Name']],
};
export const DEFAULT_SORT = { music: 'artist', nocover: 'artist', spoken: 'artist', video: 'title', unmatched: 'title', continue: 'recent', photo: 'date', albums: 'date' };

/** "No artwork" and "Continue" hold videos and shows like any other, and "No cover art" holds albums; everything that depends on the kind of shelf treats them as Videos or Music. */
export const baseCategory = (category) => (category === 'unmatched' || category === 'continue' ? 'video' : category === 'nocover' || category === 'spoken' ? 'music' : category);

// ------------------------------------------------------------ watching
// What has been watched lives in the app's preferences (progress: seconds into a video, watched: when it was finished,
// lastPlayed: when it was last played). The page hands this module a way to read them.

let readPrefs = () => ({});
export const bindWatchState = (getPrefs) => { readPrefs = getPrefs; };
const state = () => {
  const p = readPrefs() || {};
  return { progress: p.progress || {}, watched: p.watched || {}, lastPlayed: p.lastPlayed || {} };
};

/** A video counts as finished once this much of it has played, so the credits don't leave it "in progress". */
export const FINISHED = 0.92;
export const isFinished = (t, len) => len > 10 && t > 10 && t >= Math.min(len * FINISHED, len - 10);

/** When an entry was last played (0 if never): a show counts its most recent episode. */
function recency(e, s) {
  const stamp = (id) => Math.max(s.lastPlayed[id] || 0, s.watched[id] || 0);
  return e.kind === 'show' ? Math.max(0, ...e.episodes.map((x) => stamp(x.id))) : stamp(e.id);
}

/**
 * The episode to play next: the one in progress; else the first unwatched one after the episode finished most
 * recently; else the first unwatched; else the beginning (everything watched, so start over).
 */
export function nextEpisode(show) {
  const s = state();
  const eps = show.episodes;
  let at = -1;
  eps.forEach((x, i) => { if (s.progress[x.id] && (at < 0 || recency(x, s) >= recency(eps[at], s))) at = i; });
  if (at >= 0) return at;
  let last = -1;
  eps.forEach((x, i) => { if (s.watched[x.id] && (last < 0 || s.watched[x.id] >= s.watched[eps[last].id])) last = i; });
  for (let i = last + 1; i < eps.length; i++) if (!s.watched[eps[i].id]) return i;
  const first = eps.findIndex((x) => !s.watched[x.id]);
  return Math.max(0, first);
}

/** { frac, watched, resume } for a movie or show: how far through, whether it is done, and a line saying where it left off. */
export function watchInfo(e) {
  const s = state();
  if (e.kind === 'show') {
    const done = e.episodes.filter((x) => s.watched[x.id]).length;
    const started = done > 0 || e.episodes.some((x) => s.progress[x.id]);
    const next = e.episodes[nextEpisode(e)];
    const tag = `S${pad(next.parsed.season)}E${pad(next.parsed.episode)}`;
    return { frac: done / e.episodes.length, watched: done === e.episodes.length, started, resume: started && done < e.episodes.length ? `Up next: ${tag}${next.title && !/^Episode \d+$/.test(next.title) ? ` · ${next.title}` : ''}` : '' };
  }
  const p = s.progress[e.id] || 0;
  return {
    frac: p && e.duration ? clamp(p / e.duration, 0, 1) : 0,
    watched: !!s.watched[e.id],
    started: p > 0,
    resume: p ? `Resume at ${fmtTime(p)}${e.duration ? ` of ${fmtTime(e.duration)}` : ''}` : '',
  };
}

/** The "Continue" shelf: movies and shows that are in progress, or shows part-way through, most recently played first. */
export function buildContinue(cols) {
  const s = state();
  const inProgress = (e) => (e.kind === 'show'
    ? e.episodes.some((x) => s.progress[x.id]) || (e.episodes.some((x) => s.watched[x.id]) && !e.episodes.every((x) => s.watched[x.id]))
    : !!s.progress[e.id]);
  return [...cols.video, ...cols.unmatched].filter(inProgress).sort((a, b) => recency(b, s) - recency(a, s));
}

// ------------------------------------------------------------------- music

const stripDisc = (dir) => dir.replace(/[\\/](cd|disc|disk)\s*\d+\s*$/i, '');

/** How music is grouped on its shelf. "album" keeps a folder's tracks together (the default); "tags" goes by the album and artist tags alone, so one album spread over several folders is one album; "artist" makes one entry per artist. */
export const MUSIC_GROUPS = [['album', 'Albums (by folder and tags)'], ['tags', 'Albums (by tags, ignoring folders)'], ['artist', 'Artists']];
export const isGroup = (g) => MUSIC_GROUPS.some(([k]) => k === g);
const artistOf = (t) => t.albumArtist || t.artist || 'Unknown Artist';

function albumKey(t, group = 'album') {
  if (group === 'artist') return `artist|${artistOf(t).toLowerCase()}`;
  if (group === 'tags') return `${artistOf(t).toLowerCase()}|${(t.album || '').toLowerCase()}|`;
  if (!t.album) return `|unknown|${t.dir.toLowerCase()}`;
  const aa = (t.albumArtist || '').toLowerCase();
  // Without an album-artist tag, tracks of one album share a folder (CD1/CD2 folders are merged).
  return `${aa}|${t.album.toLowerCase()}|${aa ? '' : stripDisc(t.dir).toLowerCase()}`;
}

function buildAlbums(tracks, group = 'album') {
  const map = new Map();
  for (const t of tracks) {
    const key = albumKey(t, group);
    let a = map.get(key);
    if (!a) map.set(key, (a = { id: `album:${key}`, kind: 'album', tracks: [], album: group === 'artist' ? artistOf(t) : t.album || 'Unknown Album' }));
    a.tracks.push(t);
  }
  const albums = [];
  for (const a of map.values()) {
    a.tracks.sort(group === 'artist'
      ? (x, y) => cmp(x.album, y.album) || (x.disc || 1) - (y.disc || 1) || (x.track || 999) - (y.track || 999) || cmp(x.name, y.name)
      : (x, y) => (x.disc || 1) - (y.disc || 1) || (x.track || 999) - (y.track || 999) || cmp(x.name, y.name));
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
    a.untagged = a.tracks.every((t) => !t.album); // nothing to look up: it has no album name
    if (group === 'artist') {
      // One entry per artist: the name is the title, and the albums are counted instead of named. It is not an album, so nothing is looked up for it.
      a.groupedBy = 'artist';
      a.albumCount = new Set(a.tracks.map((t) => (t.album || '').toLowerCase())).size;
      a.title = a.album;
      a.artist = plural(a.albumCount, 'album');
      a.year = undefined;
      a.variousArtists = false;
    }
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

/**
 * True for a video or show that has no artwork from online: a home clip (there is nothing to look up for it), or
 * something that was looked up and came back without a poster. One that has not been looked up yet stays in Videos.
 */
export const noOnlineArt = (e) => (e.kind === 'show'
  ? e.fetched >= 1 && !e.episodes.some((x) => x.poster)
  : e.parsed?.type === 'clip' || (e.fetched >= 1 && !e.poster));

// What makes a recording spoken word rather than music: the audiobook file type (m4b), a genre that says so, or living
// in a folder called Audiobooks or Podcasts. An album is spoken when most of its tracks are.
const SPOKEN_GENRE = /\b(audio ?books?|podcasts?|spoken( word)?|speech|talk( radio)?)\b/i;
const SPOKEN_FOLDER = /(^|[\\/])(audio ?books?|podcasts?)([\\/]|$)/i;
export const isSpokenTrack = (t) => t.ext === 'm4b' || SPOKEN_GENRE.test(t.genre || '') || SPOKEN_FOLDER.test(t.dir || '');
export const isSpoken = (a) => a.tracks.filter(isSpokenTrack).length * 2 > a.tracks.length;

/**
 * True for an album with no cover art: none in its files and folder, and either none found online or nothing to look
 * up (no album name in the tags). An album that has not been looked up yet stays in Music, as videos do.
 */
export const noCoverArt = (a) => a.groupedBy !== 'artist' && !a.coverId && (a.untagged || a.fetched >= 1);

function sortList(list, category, sort) {
  category = baseCategory(category);
  const by = {
    music: { artist: (a, b) => cmp(a.groupedBy === 'artist' ? a.title : a.artist, b.groupedBy === 'artist' ? b.title : b.artist) || (a.year || 0) - (b.year || 0) || cmp(a.title, b.title), title: (a, b) => cmp(a.title, b.title), added: (a, b) => b.added - a.added },
    video: { title: (a, b) => cmp(a.title, b.title), added: (a, b) => b.added - a.added, duration: (a, b) => (b.duration || 0) - (a.duration || 0) },
    photo: { date: (a, b) => b.mtime - a.mtime, title: (a, b) => cmp(a.title, b.title) },
    albums: { date: (a, b) => b.mtime - a.mtime || cmp(a.title, b.title), title: (a, b) => cmp(a.title, b.title) || cmp(a.parent, b.parent) },
  };
  return list.sort(by[category][sort] || by[category][DEFAULT_SORT[category]]);
}

const lastPart = (dir, n = 0) => String(dir || '').split(/[\\/]/).filter(Boolean).at(-1 - n) || '';

/**
 * One album per folder that holds photos (a folder's subfolders are albums of their own, so the list stays flat).
 * Inside an album the photos run by name, which for camera files is also the order they were taken in.
 */
function buildFolders(photos) {
  const map = new Map();
  for (const p of photos) {
    const key = String(p.dir).toLowerCase();
    let a = map.get(key);
    if (!a) map.set(key, (a = { id: `folder:${key}`, kind: 'folder', dir: p.dir, title: lastPart(p.dir), parent: lastPart(p.dir, 1), photos: [] }));
    a.photos.push(p);
  }
  const albums = [...map.values()];
  for (const a of albums) {
    a.photos.sort((x, y) => cmp(x.name, y.name));
    a.mtime = Math.max(...a.photos.map((p) => p.mtime || 0));
    a.oldest = Math.min(...a.photos.map((p) => p.mtime || Infinity));
    a.coverPhoto = a.photos.find((p) => p.cover) || a.photos[0]; // the picture the album shows on the shelf
  }
  return albums;
}

export function buildCollections(items, sorts = {}, { group = 'album' } = {}) {
  const s = { ...DEFAULT_SORT, ...sorts };
  const byId = new Map();
  for (const it of items) byId.set(it.id, it);
  const everyAlbum = buildAlbums(items.filter((i) => i.kind === 'audio'), isGroup(group) ? group : 'album');
  const spoken = sortList(everyAlbum.filter(isSpoken), 'spoken', s.spoken);
  const albumsAll = everyAlbum.filter((a) => !isSpoken(a));
  const music = sortList(albumsAll.filter((a) => !noCoverArt(a)), 'music', s.music);
  const nocover = sortList(albumsAll.filter(noCoverArt), 'nocover', s.nocover);
  const videos = buildVideos(items.filter((i) => i.kind === 'video'));
  const video = sortList(videos.filter((e) => !noOnlineArt(e)), 'video', s.video);
  const unmatched = sortList(videos.filter(noOnlineArt), 'unmatched', s.unmatched);
  const photo = sortList(items.filter((i) => i.kind === 'image').map((p) => ({ ...p, title: p.name })), 'photo', s.photo);
  const albums = sortList(buildFolders(photo), 'albums', s.albums);
  return { music, nocover, spoken, video, unmatched, photo, albums, byId };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stars = (r) => (r ? `★ ${r}` : '');

/** Everything the flow/grid needs to draw one entry. `contain` letterboxes art that isn't poster-shaped. */
export function describe(category, e) {
  const d = describeBase(baseCategory(category), e);
  if (baseCategory(category) === 'video') {
    const w = watchInfo(e);
    d.progress = w.frac; // a bar on the card while it is part-way through
    d.watched = w.watched && !(e.kind !== 'show' && w.started); // a tick once finished (not while it is being watched again)
    if (d.watched) d.chips = ['Watched', ...d.chips];
    if (category === 'continue' && w.resume) d.subtitle = w.resume;
  }
  return d;
}

function describeBase(category, e) {
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
  if (category === 'albums') {
    const cp = e.coverPhoto;
    const month = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    const span = month(e.oldest) === month(e.mtime) ? month(e.mtime) : `${month(e.oldest)} – ${month(e.mtime)}`;
    return {
      title: e.title,
      subtitle: e.parent ? `in ${e.parent}` : '',
      chips: [plural(e.photos.length, 'photo'), span],
      // No full-size fallback here: until a small thumbnail exists the card shows a placeholder, rather than decoding a whole photo per album.
      cover: cp?.cover ? coverUrl(cp.id, cp.cv) : null,
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
export const jumpLabel = (category, sort, e) => (baseCategory(category) === 'music' && sort === 'artist' && e.groupedBy !== 'artist' ? e.artist : e.title) || '';

/** What a lookup needs to know about a shelf entry, or null if it can't be looked up. */
export function lookupTarget(category, e) {
  category = baseCategory(category);
  if (category === 'music') {
    if (e.groupedBy === 'artist') return null; // an artist is not an album: there is nothing to look up
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
export const entryIds = (category, e) => (baseCategory(category) === 'music' ? e.ids : e.kind === 'show' ? e.ids : [e.id]);

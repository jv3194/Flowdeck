'use strict';
// Online metadata and artwork lookups.
//   music  : MusicBrainz + Cover Art Archive, then iTunes Search   (no key)
//   shows  : TVMaze                                                (no key)
//   movies : TMDB                                                  (free personal API key)
// Each search returns candidates { ref, title, subtitle, year, thumb, score, data }. `data` stays on the
// server; the UI only ever sends `ref` back, and the server re-resolves it, so the client can't make us
// fetch an arbitrary URL.
const { similarity } = require('./names');
const { sniffImage } = require('./tags');

const UA = 'Flowdeck/1.0 (personal media player)';
const IMAGE_HOSTS = /(^|\.)(mzstatic\.com|coverartarchive\.org|archive\.org|tvmaze\.com|tmdb\.org)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Minimum spacing between requests per host (MusicBrainz asks for 1/s; iTunes allows ~20/min).
const GAPS = { 'musicbrainz.org': 1100, 'itunes.apple.com': 3200, 'api.tvmaze.com': 600, 'coverartarchive.org': 400, 'api.themoviedb.org': 120 };
// Best-match scores needed before an automatic (unattended) lookup is applied.
const ACCEPT = { album: 0.75, movie: 0.78, show: 0.8 };
const MAX_IMAGE = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const year4 = (s) => {
  const m = /\d{4}/.exec(s || '');
  return m ? Number(m[0]) : undefined;
};
const lucene = (s) => String(s).replace(/(["\\])/g, '\\$1');
const titleCase = (s) => String(s).replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
const bigArt = (u, size = 600) => String(u || '').replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, `/${size}x${size}bb.$2`);

function createProviders({ fetch: fetchFn = globalThis.fetch, tmdbBase = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3', getTmdbKey = () => '', gaps = GAPS, retryMs = 1500 } = {}) {
  const nextFree = new Map();

  async function throttle(host) {
    const gap = gaps[host] || 0;
    const now = Date.now();
    const at = Math.max(now, nextFree.get(host) || 0);
    nextFree.set(host, at + gap);
    if (at > now) await sleep(at - now);
  }

  async function request(url, { headers = {} } = {}) {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await throttle(host);
      let res;
      try {
        res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20000) });
      } catch (cause) {
        throw Object.assign(new Error(`Can't reach ${host}`), { code: 'OFFLINE', cause });
      }
      if ((res.status === 503 || res.status === 429) && attempt < 2) {
        await sleep(retryMs * (attempt + 1));
        continue;
      }
      return res;
    }
  }

  async function json(url, opts) {
    const res = await request(url, opts);
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${res.status}`), { code: 'HTTP' });
    return res.json();
  }

  // ----------------------------------------------------------------- images

  /** Downloads an image from an allow-listed host, re-checking the host on every redirect. Null if there isn't one. */
  async function downloadImage(url) {
    let u = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) throw new Error('Image host not allowed');
      await throttle(u.host);
      let res;
      try {
        res = await fetchFn(u, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      } catch (cause) {
        throw Object.assign(new Error(`Can't reach ${u.host}`), { code: 'OFFLINE', cause });
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        u = new URL(res.headers.get('location'), u);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`${u.host} answered ${res.status}`), { code: 'HTTP' });
      if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE) return null;
      const data = Buffer.from(await res.arrayBuffer());
      const mime = data.length <= MAX_IMAGE && sniffImage(data);
      return mime ? { data, mime } : null;
    }
    throw new Error('Too many redirects');
  }

  async function firstImage(urls) {
    for (const url of urls || []) {
      const img = await downloadImage(url);
      if (img) return img;
    }
    return null;
  }

  // ------------------------------------------------------------------ albums

  const caa = (kind, id, size) => `https://coverartarchive.org/${kind}/${id}/front-${size}`;

  async function mbAlbums({ artist, album, trackCount }) {
    const q = `release:"${lucene(album)}"${artist ? ` AND artist:"${lucene(artist)}"` : ''}`;
    const data = await json(`https://musicbrainz.org/ws/2/release/?query=${enc(q)}&fmt=json&limit=12`);
    const releases = data?.releases || [];
    // A group's earliest pressing in the results is the best cheap guess at when the album first came out.
    const earliest = new Map();
    for (const r of releases) {
      const key = r['release-group']?.id || r.id;
      const y = year4(r.date);
      if (y && !(earliest.get(key) <= y)) earliest.set(key, y);
    }
    const best = new Map(); // one candidate per release group; the many pressings of an album are interchangeable
    for (const r of releases) {
      const credit = (r['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join('');
      const t = similarity(album, r.title);
      let score = artist ? 0.6 * t + 0.4 * similarity(artist, credit) : t;
      if (trackCount && r['track-count'] === trackCount) score += 0.04;
      if (r.status && r.status !== 'Official') score -= 0.03;
      score = clamp01(score);
      const group = r['release-group']?.id;
      const key = group || r.id;
      if (best.has(key) && best.get(key).score >= score) continue;
      const year = earliest.get(key) ?? year4(r.date);
      best.set(key, {
        ref: { provider: 'musicbrainz', release: r.id, group },
        title: r.title,
        subtitle: [credit, year, 'MusicBrainz'].filter(Boolean).join(' · '),
        year,
        thumb: group ? caa('release-group', group, 250) : caa('release', r.id, 250),
        score,
        data: { title: r.title, artist: credit, year, artUrls: [group && caa('release-group', group, 500), caa('release', r.id, 500)].filter(Boolean) },
      });
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  function itunesAlbumCandidate(r, { artist, album }) {
    const t = similarity(album, r.collectionName);
    const score = clamp01(artist ? 0.6 * t + 0.4 * similarity(artist, r.artistName) : t);
    const year = year4(r.releaseDate);
    return {
      ref: { provider: 'itunes', id: r.collectionId },
      title: r.collectionName,
      subtitle: [r.artistName, year, 'iTunes'].filter(Boolean).join(' · '),
      year,
      thumb: r.artworkUrl100,
      score,
      data: { title: r.collectionName, artist: r.artistName, year, genre: r.primaryGenreName, artUrls: r.artworkUrl100 ? [bigArt(r.artworkUrl100)] : [] },
    };
  }

  async function itunesAlbums(q) {
    const term = [q.artist, q.album].filter(Boolean).join(' ');
    const data = await json(`https://itunes.apple.com/search?term=${enc(term)}&media=music&entity=album&limit=10`);
    return (data?.results || []).filter((r) => r.collectionId && r.collectionName).map((r) => itunesAlbumCandidate(r, q)).sort((a, b) => b.score - a.score);
  }

  /** Candidates from every music source, best first. Fails only if every source failed. */
  async function albumCandidates(q) {
    const settled = await Promise.allSettled([mbAlbums(q), itunesAlbums(q)]);
    if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
    return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value.slice(0, 5) : [])).sort((a, b) => b.score - a.score);
  }

  /**
   * { year, genre } for an album as a whole. A release's own date is whichever pressing matched best (often a
   * remaster), so the release group's first-release-date is the year worth showing; its genres are the votes
   * across every pressing. One request gives both.
   */
  async function releaseGroupInfo(group) {
    if (!UUID.test(group || '')) return null;
    const g = await json(`https://musicbrainz.org/ws/2/release-group/${group}?fmt=json&inc=genres`);
    if (!g) return null;
    const top = [...(g.genres || [])].sort((a, b) => b.count - a.count)[0];
    return { year: year4(g['first-release-date']), genre: top && titleCase(top.name) };
  }

  async function resolveAlbum(ref) {
    if (ref.provider === 'musicbrainz') {
      if (!UUID.test(ref.release) || (ref.group && !UUID.test(ref.group))) throw new Error('Bad reference');
      const r = await json(`https://musicbrainz.org/ws/2/release/${ref.release}?fmt=json&inc=artist-credits+genres`);
      if (!r) throw new Error('Release not found');
      const top = [...(r.genres || [])].sort((a, b) => b.count - a.count)[0];
      const info = ref.group ? await releaseGroupInfo(ref.group).catch(() => null) : null;
      return {
        title: r.title,
        artist: (r['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join(''),
        year: info?.year || year4(r.date),
        genre: info?.genre || (top && titleCase(top.name)),
        artUrls: [ref.group && caa('release-group', ref.group, 500), caa('release', ref.release, 500)].filter(Boolean),
      };
    }
    if (ref.provider === 'itunes') {
      const d = await json(`https://itunes.apple.com/lookup?id=${Number(ref.id)}`);
      const r = d?.results?.[0];
      if (!r) throw new Error('Album not found');
      return itunesAlbumCandidate(r, {}).data;
    }
    throw new Error('Unknown source');
  }

  // ------------------------------------------------------------------ movies

  const noKey = () => Object.assign(new Error('Movies need a free TMDB API key'), { code: 'NO_KEY' });
  const isBearer = (k) => /^eyJ/.test(k);

  async function tmdb(path, params = {}, key = getTmdbKey()) {
    if (!key) throw noKey();
    const q = new URLSearchParams(params);
    if (!isBearer(key)) q.set('api_key', key);
    const res = await request(`${tmdbBase}${path}?${q}`, { headers: isBearer(key) ? { Authorization: `Bearer ${key}` } : {} });
    if (res.status === 401) throw Object.assign(new Error('TMDB rejected the API key'), { code: 'BAD_KEY' });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`TMDB answered ${res.status}`), { code: 'HTTP' });
    return res.json();
  }

  async function testTmdbKey(key) {
    try {
      return !!(await tmdb('/configuration', {}, key));
    } catch (e) {
      if (e.code === 'BAD_KEY') return false;
      throw e;
    }
  }

  let movieGenres = null;
  async function genreNames() {
    if (!movieGenres) {
      const d = await tmdb('/genre/movie/list');
      movieGenres = Object.fromEntries((d?.genres || []).map((g) => [g.id, g.name]));
    }
    return movieGenres;
  }

  const poster = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

  async function movieCandidates({ title, year }) {
    const base = { query: title, include_adult: 'false' };
    let d = await tmdb('/search/movie', year ? { ...base, year } : base);
    if (!d?.results?.length && year) d = await tmdb('/search/movie', base);
    const genres = await genreNames();
    return (d?.results || []).slice(0, 8).map((r) => {
      const ry = year4(r.release_date);
      let score = Math.max(similarity(title, r.title), similarity(title, r.original_title));
      if (year && ry) score += ry === year ? 0.12 : Math.abs(ry - year) === 1 ? 0.04 : -0.25;
      return {
        ref: { provider: 'tmdb', kind: 'movie', id: r.id },
        title: r.title,
        subtitle: [ry, (r.overview || '').slice(0, 90)].filter(Boolean).join(' · '),
        year: ry,
        thumb: poster(r.poster_path, 'w185'),
        score: clamp01(score),
        data: {
          title: r.title, year: ry, summary: r.overview || undefined,
          rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
          genres: (r.genre_ids || []).map((i) => genres[i]).filter(Boolean),
          artUrls: [poster(r.poster_path, 'w500')].filter(Boolean),
        },
      };
    }).sort((a, b) => b.score - a.score);
  }

  async function resolveMovie(ref) {
    if (ref.provider !== 'tmdb') throw new Error('Unknown source');
    const r = await tmdb(`/movie/${Number(ref.id)}`);
    if (!r) throw new Error('Movie not found');
    return {
      title: r.title, year: year4(r.release_date), summary: r.overview || undefined,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
      genres: (r.genres || []).map((g) => g.name), runtime: r.runtime || undefined,
      artUrls: [poster(r.poster_path, 'w500')].filter(Boolean),
    };
  }

  // ------------------------------------------------------------------- shows

  function tvmazeData(s) {
    return {
      id: s.id, name: s.name, year: year4(s.premiered), summary: stripHtml(s.summary) || undefined,
      genres: s.genres || [], network: s.network?.name || s.webChannel?.name || undefined,
      rating: s.rating?.average || undefined, status: s.status || undefined,
      artUrls: [s.image?.original, s.image?.medium].filter(Boolean),
    };
  }

  async function showCandidates({ name, year }) {
    const d = await json(`https://api.tvmaze.com/search/shows?q=${enc(name)}`);
    return (d || []).slice(0, 8).map(({ show }) => {
      const data = tvmazeData(show);
      let score = similarity(name, show.name);
      if (year && data.year) score += data.year === year ? 0.1 : -0.05;
      return {
        ref: { provider: 'tvmaze', id: show.id },
        title: show.name,
        subtitle: [data.year, data.network, data.genres.slice(0, 2).join('/')].filter(Boolean).join(' · '),
        year: data.year,
        thumb: show.image?.medium,
        score: clamp01(score),
        data,
      };
    }).sort((a, b) => b.score - a.score);
  }

  async function resolveShow(ref) {
    if (ref.provider !== 'tvmaze') throw new Error('Unknown source');
    const s = await json(`https://api.tvmaze.com/shows/${Number(ref.id)}`);
    if (!s) throw new Error('Show not found');
    return tvmazeData(s);
  }

  async function showEpisodes(id) {
    const d = await json(`https://api.tvmaze.com/shows/${Number(id)}/episodes`);
    return (d || []).map((e) => ({ season: e.season, episode: e.number, title: e.name, airdate: e.airdate || undefined, runtime: e.runtime || undefined, summary: stripHtml(e.summary) || undefined }));
  }

  return { albumCandidates, mbAlbums, itunesAlbums, releaseGroupInfo, resolveAlbum, movieCandidates, resolveMovie, showCandidates, resolveShow, showEpisodes, downloadImage, firstImage, testTmdbKey };
}

module.exports = { createProviders, ACCEPT, IMAGE_HOSTS };

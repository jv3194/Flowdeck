'use strict';
// Looks up artwork and metadata online and stores it in the library.
// Bulk work runs as a sequential queue (the services rate-limit); `state` is polled by the UI.
const { ACCEPT } = require('./providers');

const idle = () => ({ active: false, done: 0, total: 0, found: 0, missed: 0, skipped: 0, failed: 0, wrote: 0, writeFailed: 0, writeError: '', current: '', noKey: false, offline: false, error: '' });

/** First candidate good enough to apply without asking (candidates arrive best-first). */
const movieSrc = (ref) => (ref.provider === 'itunes' ? 'iTunes' : 'TMDB');
const pick = (cands, threshold) => (cands || []).find((c) => c.score >= threshold) || null;

/** Source failures other than "no network" shouldn't sink a lookup that another source can answer. */
const soft = (promise) => promise.catch((e) => {
  if (e.code === 'OFFLINE') throw e;
  return [];
});
const softNull = (e) => {
  if (e.code === 'OFFLINE') throw e;
  return null;
};

const label = (t) => (t.type === 'album' ? `${t.artist ? `${t.artist} – ` : ''}${t.album}` : t.type === 'show' ? t.show : t.title);

class Enricher {
  constructor(lib, providers, writeback = null) {
    this.lib = lib;
    this.p = providers;
    this.wb = writeback;
    this.queue = [];
    this.running = false;
    this.state = idle();
  }

  /**
   * Queue lookups. Targets: {type:'album', ids, artist, album} | {type:'movie', id, title, year} | {type:'show', show, year, episodes:[{id,season,episode}]}
   * With `write`, an album's details are also saved into its files as soon as they are found.
   */
  enqueue(targets, { force = false, write = false } = {}) {
    if (!this.state.active) this.state = { ...idle(), active: true };
    for (const t of targets) this.queue.push({ ...t, force, write });
    this.state.total += targets.length;
    this._run();
    return targets.length;
  }

  async _run() {
    if (this.running) return;
    this.running = true;
    let offlineRun = 0;
    const st = this.state;
    while (this.queue.length) {
      const t = this.queue.shift();
      st.current = label(t);
      try {
        const outcome = await this.process(t);
        st[outcome === 'found' ? 'found' : outcome === 'skipped' ? 'skipped' : 'missed']++;
        offlineRun = 0;
      } catch (e) {
        st.failed++;
        st.error = e.message;
        if (e.code === 'NO_KEY' || e.code === 'BAD_KEY') {
          st.noKey = true;
          const rest = this.queue.filter((x) => x.type === 'movie');
          this.queue = this.queue.filter((x) => x.type !== 'movie');
          st.done += rest.length;
        } else if (e.code === 'OFFLINE' && ++offlineRun >= 3) {
          st.offline = true;
          st.done += this.queue.length;
          this.queue = [];
        }
      }
      st.done++;
    }
    st.active = false;
    st.current = '';
    this.running = false;
  }

  async process(t) {
    if (t.type === 'album') return this.album(t);
    if (t.type === 'movie') return this.movie(t);
    if (t.type === 'show') return this.show(t);
    throw new Error('Unknown target');
  }

  async album(t) {
    const first = this.lib.get(t.ids[0]);
    if (!first) return 'missed';
    if (!t.force && first.fetched) return 'skipped';
    const q = { artist: t.artist || '', album: t.album, trackCount: t.ids.length };
    let data = null;
    let image = null;
    let src = '';

    const mb = pick(await soft(this.p.mbAlbums(q)), ACCEPT.album);
    if (mb) {
      const info = mb.ref.group ? await this.p.releaseGroupInfo(mb.ref.group).catch(softNull) : null;
      data = { ...mb.data, year: info?.year || mb.data.year, genre: info?.genre || mb.data.genre };
      src = 'MusicBrainz';
      image = await this.p.firstImage(mb.data.artUrls).catch(softNull);
    }
    if (!image) {
      // MusicBrainz has no art for this release (or no match at all): iTunes usually does.
      const it = pick(await soft(this.p.itunesAlbums(q)), ACCEPT.album);
      if (it) {
        image = await this.p.firstImage(it.data.artUrls).catch(softNull);
        data = { ...(data || {}), ...it.data, year: data?.year || it.data.year };
        src = mb ? 'MusicBrainz + iTunes' : 'iTunes';
      }
    }
    if (!data) {
      this.lib.markTried(t.ids);
      return 'missed';
    }
    await this.lib.applyAlbum(t.ids, { year: data.year, genre: data.genre, image, src });
    if (t.write) await this._save(t.ids);
    return image ? 'found' : 'missed';
  }

  /** Save an album's fetched details into its files, counting the result in the running job. */
  async _save(ids, opts = {}) {
    if (!this.wb) return null;
    const s = await this.wb.tracks(ids, opts);
    this.state.wrote += s.wrote;
    this.state.writeFailed += s.failed;
    if (s.errors[0]) this.state.writeError = s.errors[0];
    return s;
  }

  async movie(t) {
    const it = this.lib.get(t.id);
    if (!it) return 'missed';
    if (!t.force && it.fetched) return 'skipped';
    let best = pick(await this.p.movieCandidates({ title: t.title, year: t.year }), ACCEPT.movie);
    // "Wonder Woman 1984" parses as the title "Wonder Woman" released in 1984: if that finds nothing, the number may belong to the title.
    if (!best && t.year) best = pick(await this.p.movieCandidates({ title: `${t.title} ${t.year}` }), ACCEPT.movie);
    if (!best) {
      this.lib.markTried([t.id]);
      return 'missed';
    }
    return this._applyMovie(t.id, best.data, movieSrc(best.ref));
  }

  async _applyMovie(id, d, src) {
    const image = await this.p.firstImage(d.artUrls).catch(softNull);
    await this.lib.applyMovie(id, { meta: { title: d.title, year: d.year, summary: d.summary, rating: d.rating, genres: d.genres, runtime: d.runtime }, image, src });
    return 'found';
  }

  async show(t) {
    const first = this.lib.get(t.episodes[0]?.id);
    if (!first) return 'missed';
    if (!t.force && first.fetched) return 'skipped';
    const best = pick(await this.p.showCandidates({ name: t.show, year: t.year }), ACCEPT.show);
    if (!best) {
      this.lib.markTried(t.episodes.map((e) => e.id));
      return 'missed';
    }
    return this._applyShow(t.episodes, best.data, 'TVMaze');
  }

  async _applyShow(episodes, d, src) {
    const [image, eps] = [await this.p.firstImage(d.artUrls).catch(softNull), await this.p.showEpisodes(d.id).catch(softNull)];
    const epInfo = new Map((eps || []).map((e) => [`${e.season}x${e.episode}`, e]));
    const show = { id: d.id, name: d.name, year: d.year, summary: d.summary, genres: d.genres, network: d.network, rating: d.rating, status: d.status };
    await this.lib.applyShow(episodes, { show, image, epInfo, src });
    return 'found';
  }

  // ------------------------------------------------------- the manual path

  /** Candidates for the "pick the right match" sheet, without the server-side `data`. */
  async candidates(type, q) {
    const list =
      type === 'album' ? await this.p.albumCandidates(q)
      : type === 'movie' ? await this.p.movieCandidates(q)
      : type === 'show' ? await this.p.showCandidates(q)
      : null;
    if (!list) throw new Error('Unknown type');
    return list.slice(0, 8).map(({ ref, title, subtitle, year, thumb, score }) => ({ ref, title, subtitle, year, thumb: /^https:\/\//.test(thumb || '') ? thumb : undefined, score }));
  }

  /** Apply a candidate the user chose. `ref` is re-resolved here, never trusted for URLs. */
  async apply({ type, ref, ids = [], episodes = [], write = false }) {
    if (type === 'album') {
      const d = await this.p.resolveAlbum(ref);
      const image = await this.p.firstImage(d.artUrls);
      await this.lib.applyAlbum(ids, { year: d.year, genre: d.genre, image, src: ref.provider === 'musicbrainz' ? 'MusicBrainz' : 'iTunes' });
      // The user picked this art by hand, so it replaces whatever the files already carry.
      const saved = write && this.wb ? await this.wb.tracks(ids, { replaceArt: true, force: true }) : null;
      return { found: !!image, art: !!image, written: saved ? saved.wrote : 0, writeFailed: saved ? saved.failed : 0, writeError: saved?.errors[0] || '' };
    }
    if (type === 'movie') {
      await this._applyMovie(ids[0], await this.p.resolveMovie(ref), movieSrc(ref));
      return { found: true };
    }
    if (type === 'show') {
      await this._applyShow(episodes, await this.p.resolveShow(ref), 'TVMaze');
      return { found: true };
    }
    throw new Error('Unknown type');
  }
}

const HEX = /^[0-9a-f]{8,32}$/;
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => Number(v) || undefined;

/** Validate lookup targets coming from the UI: ids must be library ids, text is length-limited, junk is dropped. */
function cleanTargets(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list.slice(0, 5000) : []) {
    if (t?.type === 'album' && Array.isArray(t.ids) && t.ids.length && t.ids.every((i) => HEX.test(i)) && str(t.album)) {
      out.push({ type: 'album', ids: t.ids.slice(0, 300), artist: str(t.artist), album: str(t.album) });
    } else if (t?.type === 'movie' && HEX.test(t.id) && str(t.title)) {
      out.push({ type: 'movie', id: t.id, title: str(t.title), year: num(t.year) });
    } else if (t?.type === 'show' && Array.isArray(t.episodes) && str(t.show)) {
      const episodes = t.episodes.slice(0, 3000).filter((e) => HEX.test(e?.id)).map((e) => ({ id: e.id, season: Number(e.season) || 0, episode: Number(e.episode) || 0 }));
      if (episodes.length) out.push({ type: 'show', show: str(t.show), year: num(t.year), episodes });
    }
  }
  return out;
}

module.exports = { Enricher, cleanTargets };

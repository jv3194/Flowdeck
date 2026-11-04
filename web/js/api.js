// Thin wrapper over the local Flowdeck server.

async function req(method, url, body) {
  const init = { method };
  if (method !== 'GET') {
    // The server only accepts JSON on state-changing requests (see its CSRF guard).
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(url, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { code: data.code });
  return data;
}

export const api = {
  library: (rev) => req('GET', rev == null ? '/api/library' : `/api/library?rev=${rev}`),
  prefs: () => req('GET', '/api/prefs'),
  savePrefs: (patch) => req('PUT', '/api/prefs', patch),
  browse: (path) => req('GET', `/api/fs?path=${encodeURIComponent(path || '')}`),
  addRoot: (path) => req('POST', '/api/roots', { path }),
  removeRoot: (path) => req('DELETE', '/api/roots', { path }),
  scan: () => req('POST', '/api/scan'),
  meta: (id, meta) => req('POST', `/api/meta/${id}`, meta),
  // Online artwork and metadata (see server/enrich.js)
  fetchMeta: (targets, force = false, write = false) => req('POST', '/api/meta/fetch', { targets, force, write }),
  writeFiles: (body) => req('POST', '/api/meta/write', body), // { pending: true } or { ids }
  undoFiles: (ids) => req('POST', '/api/meta/undo', { ids }),
  candidates: (query) => req('POST', '/api/meta/candidates', query),
  applyMatch: (body) => req('POST', '/api/meta/apply', body),
  clearFetched: (ids) => req('POST', '/api/meta/clear', { ids }),
  setTmdbKey: (key) => req('POST', '/api/meta/key', { key }),
  // Subtitles: the tracks a video has (files beside it, text tracks inside it), and one track's cues
  subtitleTracks: (id) => req('GET', `/api/subs/${id}`),
  subtitleCues: (id, key) => req('GET', `/api/subs/${id}/${key}`),
  // Videos the browser can't decode are converted on the fly with ffmpeg (see server/transcode.js)
  play: (id, caps, force = false) => req('GET', `/api/play/${id}?caps=${encodeURIComponent(caps)}${force ? '&force=1' : ''}`),
  ffmpegStatus: () => req('GET', '/api/ffmpeg'),
  ffmpegInstall: () => req('POST', '/api/ffmpeg/install'),
  ffmpegRemove: () => req('POST', '/api/ffmpeg/remove'),
  async uploadThumb(id, blob, meta = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(meta)) if (Number.isFinite(v) && v > 0) q.set(k, Math.round(v * 100) / 100);
    const r = await fetch(`/cover/${id}?${q}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (!r.ok) throw new Error('thumbnail upload failed');
  },
};

export const mediaUrl = (id) => `/media/${id}`;
/** A converted stream starting `t` seconds in. The server works the plan out again from `caps`. */
export const convertUrl = (id, t, caps, force = false) => `/convert/${id}?t=${Math.max(0, t).toFixed(3)}&caps=${encodeURIComponent(caps)}${force ? '&force=1' : ''}`;
/** `v` is the item's cover version; it changes when the cover does, which busts the browser cache. */
export const coverUrl = (id, v) => (v ? `/cover/${id}?v=${v}` : `/cover/${id}`);

// Cover artwork: image-or-placeholder elements, dominant colour sampling, and lazy
// thumbnail generation for videos and photos (uploaded to the server so they're made once).
import { api } from './api.js';
import { h, icon } from './util.js';

const CAT_ICON = { music: 'music', video: 'film', photo: 'image' };
const decoded = new Set(); // URLs already shown once: re-created cards skip the fade-in
const palette = new Map();

/** A `.cover` element for a described entry. */
export function coverEl(category, d, lazy = false) {
  const wrap = h('div', { class: 'cover' });
  const ph = h('div', { class: 'ph', style: { '--ph': d.hue } }, icon(CAT_ICON[category]), h('b', {}, d.title));
  wrap.append(ph);
  if (d.cover) {
    // Art that isn't the card's shape (a video frame on a poster card) sits letterboxed on a blurred copy of itself.
    if (d.contain) {
      wrap.classList.add('contain');
      wrap.style.setProperty('--art', `url("${d.cover}")`);
    }
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
    if (lazy) img.loading = 'lazy';
    const show = () => { decoded.add(d.cover); img.classList.add('loaded'); ph.remove(); };
    img.onload = show;
    img.onerror = () => img.remove();
    img.src = d.cover;
    if (decoded.has(d.cover) && img.complete) show();
    wrap.append(img);
  }
  wrap.append(h('div', { class: 'shine' }));
  return wrap;
}

/** Saturation-weighted mean hue of an image, or null for greyscale art. */
export async function dominantColor(url) {
  if (palette.has(url)) return palette.get(url);
  let result = null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const px = ctx.getImageData(0, 0, 24, 24).data;
    let x = 0, y = 0, wt = 0, sat = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const d = mx - mn;
      if (mx < 0.18 || d < 0.08) continue;
      const s = d / mx;
      let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue = (hue * 60 + 360) % 360;
      const w = s * s * mx;
      x += Math.cos((hue * Math.PI) / 180) * w;
      y += Math.sin((hue * Math.PI) / 180) * w;
      sat += s * w;
      wt += w;
    }
    if (wt > 0.4) result = { hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, sat: Math.min(0.8, 0.35 + (sat / wt) * 0.55) };
  } catch {
    /* unreadable image: caller falls back to a hash hue */
  }
  palette.set(url, result);
  return result;
}

// ------------------------------------------------------------ thumbnails

const queue = [];
const seen = new Set();
let active = 0;

/** Make a thumbnail for `item` (kind video|image) if it doesn't have one. `done(item)` fires on success. */
export function ensureThumb(item, done) {
  if (item.cover || seen.has(item.id) || !(item.kind === 'video' || item.kind === 'image')) return;
  seen.add(item.id);
  queue.push({ item, done });
  pump();
}

/** Drop jobs that haven't started (e.g. on category change) so they can be requested again later. */
export function clearThumbQueue() {
  for (const job of queue) seen.delete(job.item.id);
  queue.length = 0;
}

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    (job.item.kind === 'image' ? imageThumb(job.item) : videoThumb(job.item))
      .then((meta) => meta && job.done(job.item, meta))
      .catch(() => {})
      .finally(() => { active--; pump(); });
  }
}

const once = (el, ev, ms = 9000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${ev} timeout`)), ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('media error')); }, { once: true });
  });

function draw(source, sw, sh, max) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

async function imageThumb(item) {
  const img = new Image();
  img.src = `/media/${item.id}`;
  await img.decode();
  const blob = await draw(img, img.naturalWidth, img.naturalHeight, 640);
  const meta = { width: img.naturalWidth, height: img.naturalHeight };
  await api.uploadThumb(item.id, blob, meta);
  return meta;
}

async function videoThumb(item) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.src = `/media/${item.id}`;
  try {
    await once(v, 'loadedmetadata');
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = dur > 4 ? Math.min(dur * 0.12, 45) : 0.1;
    await once(v, 'seeked');
    const meta = { duration: dur, width: v.videoWidth, height: v.videoHeight };
    const blob = await draw(v, v.videoWidth, v.videoHeight, 640);
    await api.uploadThumb(item.id, blob, meta);
    return meta;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// How a video is placed in the window: its shape (aspect ratio), its zoom and where it has been dragged to.
// Plain rules, so they can be tested: the screen only applies the rectangle this works out.

/** The shapes on offer. "original" is the file's own; "fill" crops to cover the whole window; "stretch" ignores the shape. */
export const FITS = [
  ['original', 'Original'],
  ['fill', 'Fill window (crop)'],
  ['stretch', 'Stretch'],
  ['16:9', '16:9'],
  ['4:3', '4:3'],
  ['21:9', '21:9'],
  ['1:1', '1:1'],
];
const RATIOS = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9, '1:1': 1 };

export const isFit = (f) => FITS.some(([k]) => k === f);
export const fitName = (f) => FITS.find(([k]) => k === f)?.[1] || 'Original';
export const nextFit = (f, dir = 1) => {
  const at = Math.max(0, FITS.findIndex(([k]) => k === f));
  return FITS[(at + dir + FITS.length) % FITS.length][0];
};

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
const ZOOM_STEP = 1.1;

/** One step of zoom in (dir 1) or out (dir -1), kept within range and rounded so repeated steps do not drift. */
export const stepZoom = (zoom, dir) => {
  const z = (Number.isFinite(zoom) ? zoom : 1) * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
};

/** How far the picture may be dragged on one axis: only as far as it overhangs the window. */
const limit = (size, box) => Math.max(0, (size - box) / 2);

/**
 * Where to put the video inside a box (the window), as { w, h, x, y } in the box's pixels: x and y are the top-left.
 * `vw` x `vh` is the picture's own size; `pan` is how far it has been dragged from the middle.
 */
export function placement({ fit = 'original', zoom = 1, pan = { x: 0, y: 0 }, box, vw, vh }) {
  const bw = Math.max(1, box.w);
  const bh = Math.max(1, box.h);
  const own = vw > 0 && vh > 0 ? vw / vh : 16 / 9;
  const ratio = fit === 'stretch' ? bw / bh : RATIOS[fit] || own;
  // "contain" fits the whole picture in; "fill" scales until the window is covered.
  const cover = fit === 'fill';
  let w = bw;
  let h = bw / ratio;
  if (cover ? h < bh : h > bh) { h = bh; w = bh * ratio; }
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(zoom) ? zoom : 1));
  w *= z;
  h *= z;
  const px = Math.min(limit(w, bw), Math.max(-limit(w, bw), Number(pan.x) || 0));
  const py = Math.min(limit(h, bh), Math.max(-limit(h, bh), Number(pan.y) || 0));
  return { w, h, x: (bw - w) / 2 + px, y: (bh - h) / 2 + py, panX: px, panY: py };
}

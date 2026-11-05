import test from 'node:test';
import assert from 'node:assert/strict';
import { FITS, fitName, nextFit, placement, stepZoom, ZOOM_MAX } from '../../web/js/picture.js';

const box = { w: 1600, h: 900 };
const near = (a, b) => Math.abs(a - b) < 0.01;

test('the file\'s own shape is fitted inside the window with bars, and centred', () => {
  const wide = placement({ box, vw: 1920, vh: 800 }); // 2.4:1 film in a 16:9 window
  assert.ok(near(wide.w, 1600) && near(wide.h, 1600 / 2.4) && near(wide.x, 0));
  assert.ok(near(wide.y, (900 - wide.h) / 2));
  const tall = placement({ box, vw: 1080, vh: 1920 }); // a phone clip
  assert.ok(near(tall.h, 900) && tall.w < 900 && near(tall.x, (1600 - tall.w) / 2));
});

test('fill crops to cover the whole window, stretch ignores the shape, and a chosen ratio overrides the file', () => {
  const fill = placement({ fit: 'fill', box, vw: 1920, vh: 800 });
  assert.ok(near(fill.h, 900) && fill.w > 1600, 'covers the height, overhangs the width');
  assert.ok(near(fill.x, (1600 - fill.w) / 2));
  const stretch = placement({ fit: 'stretch', box, vw: 1920, vh: 800 });
  assert.deepEqual([stretch.w, stretch.h, stretch.x, stretch.y], [1600, 900, 0, 0]);
  const four3 = placement({ fit: '4:3', box, vw: 1920, vh: 1080 });
  assert.ok(near(four3.h, 900) && near(four3.w, 1200));
  const wide = placement({ fit: '21:9', box, vw: 1920, vh: 1080 });
  assert.ok(near(wide.w, 1600) && near(wide.h, 1600 * 9 / 21));
});

test('zoom scales around the middle, is limited, and the picture can only be dragged as far as it overhangs', () => {
  const z2 = placement({ zoom: 2, box, vw: 1600, vh: 900 });
  assert.ok(near(z2.w, 3200) && near(z2.h, 1800) && near(z2.x, -800) && near(z2.y, -450));
  assert.equal(placement({ zoom: 99, box, vw: 1600, vh: 900 }).w, 1600 * ZOOM_MAX);
  assert.equal(placement({ zoom: -3, box, vw: 1600, vh: 900 }).w, 1600);
  const dragged = placement({ zoom: 2, pan: { x: 5000, y: -5000 }, box, vw: 1600, vh: 900 });
  assert.ok(near(dragged.x, 0) && near(dragged.y, -900), 'stops at the edges of the picture');
  const unzoomed = placement({ zoom: 1, pan: { x: 300, y: 300 }, box, vw: 1600, vh: 900 });
  assert.deepEqual([unzoomed.panX, unzoomed.panY], [0, 0], 'nothing to drag when it fits');
});

test('bad input never gives a NaN: no picture size yet, a zero-size window, junk zoom and pan', () => {
  for (const fit of FITS.map(([k]) => k).concat(['nonsense'])) {
    const p = placement({ fit, zoom: NaN, pan: { x: 'a', y: undefined }, box: { w: 0, h: 0 }, vw: 0, vh: 0 });
    for (const v of Object.values(p)) assert.ok(Number.isFinite(v), `${fit}: ${JSON.stringify(p)}`);
  }
});

test('zoom steps are bounded and do not drift, and the shapes cycle both ways and wrap', () => {
  let z = 1;
  for (let i = 0; i < 100; i++) z = stepZoom(z, 1);
  assert.equal(z, ZOOM_MAX);
  for (let i = 0; i < 100; i++) z = stepZoom(z, -1);
  assert.equal(z, 1);
  assert.equal(stepZoom(NaN, 1), 1.1);
  assert.equal(nextFit('original', -1), FITS.at(-1)[0]);
  assert.equal(nextFit(FITS.at(-1)[0], 1), 'original');
  assert.equal(nextFit('nonsense', 1), 'fill');
  assert.equal(fitName('fill'), 'Fill window (crop)');
});

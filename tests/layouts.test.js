'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../web/js/layouts.js');
const STEPS = Array.from({ length: 65 }, (_, i) => -8 + i * 0.25); // -8 .. 8 in quarter-cards

test('every style gives finite, sensible numbers across the whole shelf', async () => {
  const { LAYOUTS, placement } = await load();
  for (const [style] of LAYOUTS) {
    for (const tilt of [30, 58, 75]) {
      for (const d of STEPS) {
        const p = placement(style, d, 260, tilt);
        for (const [k, v] of Object.entries(p)) if (k !== 'origin') assert.ok(Number.isFinite(v), `${style} d=${d} tilt=${tilt}: ${k} = ${v}`);
        assert.ok(p.scale > 0, `${style} d=${d}: scale ${p.scale}`);
        assert.ok(p.opacity >= 0 && p.opacity <= 1, `${style} d=${d}: opacity ${p.opacity}`);
        assert.ok(p.shade >= 0 && p.shade <= 1, `${style} d=${d}: shade ${p.shade}`);
        assert.ok(p.z <= 0, `${style} d=${d}: nothing comes forward of the focused cover (z ${p.z})`);
      }
    }
  }
});

test('the focused cover sits dead centre, upright and fully visible in every style', async () => {
  const { LAYOUTS, placement } = await load();
  for (const [style] of LAYOUTS) {
    const p = placement(style, 0, 260);
    assert.deepEqual([p.x, p.rotY, p.rotZ, p.opacity, p.shade], [0, 0, 0, 1, 0], style);
    assert.ok(p.scale >= 1, `${style}: the focused cover is the largest`);
    assert.equal(p.z, 0, style);
  }
});

test('left and right mirror each other', async () => {
  const { LAYOUTS, placement } = await load();
  for (const [style] of LAYOUTS) {
    for (const d of [0.3, 1, 1.7, 3, 6]) {
      const r = placement(style, d, 260, 58);
      const l = placement(style, -d, 260, 58);
      assert.ok(Math.abs(l.x + r.x) < 1e-9, `${style} d=${d}: x`);
      assert.ok(Math.abs(l.rotY + r.rotY) < 1e-9, `${style} d=${d}: rotY`);
      assert.ok(Math.abs(l.rotZ + r.rotZ) < 1e-9, `${style} d=${d}: rotZ`);
      for (const k of ['y', 'z', 'scale', 'opacity', 'shade']) assert.ok(Math.abs(l[k] - r[k]) < 1e-9, `${style} d=${d}: ${k}`);
    }
  }
});

test('covers move outward and fade as they get further from the focus', async () => {
  const { LAYOUTS, placement } = await load();
  for (const [style] of LAYOUTS) {
    let lastOpacity = 1;
    let lastShade = 0;
    for (let d = 0; d <= 8; d += 0.25) {
      const p = placement(style, d, 260, 58);
      assert.ok(p.opacity <= lastOpacity + 1e-9, `${style} d=${d}: opacity never increases outward`);
      assert.ok(p.shade >= lastShade - 1e-9, `${style} d=${d}: shade never decreases outward`);
      lastOpacity = p.opacity;
      lastShade = p.shade;
    }
    assert.equal(placement(style, 8, 260).opacity, 0, `${style}: the outermost covers are invisible, so none pop in or out`);
  }
});

test('the cover-flow tilt control is the angle of the side covers', async () => {
  const { placement } = await load();
  assert.equal(placement('slab', 1, 260, 40).rotY, -40);
  assert.equal(placement('slab', -1, 260, 40).rotY, 40);
  assert.equal(placement('slab', 1, 260, 70).rotY, -70);
  assert.ok(Math.abs(placement('carousel', 2, 260, 75).x) > Math.abs(placement('carousel', 2, 260, 30).x), 'a bigger carousel angle spreads covers further');
});

test('styles are genuinely different, and unknown names fall back to the classic', async () => {
  const { LAYOUTS, placement } = await load();
  const sig = LAYOUTS.map(([s]) => JSON.stringify(placement(s, 2, 260, 58)));
  assert.equal(new Set(sig).size, LAYOUTS.length);
  assert.deepEqual(placement('does-not-exist', 2, 260, 58), placement('slab', 2, 260, 58));
  assert.equal(placement('fan', 2, 260).origin, '50% 165%');
});

test('width scales positions linearly', async () => {
  const { placement } = await load();
  const a = placement('slab', 2, 200);
  const b = placement('slab', 2, 400);
  assert.ok(Math.abs(b.x - 2 * a.x) < 1e-9 && Math.abs(b.z - 2 * a.z) < 1e-9);
});

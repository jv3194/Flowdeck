import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUNDS, BASE, exportJson, FONTS, FRAMES, importJson, LIMITS, merge, normalizeTheme, PRESETS, swatch, THEME_KEYS } from '../../web/js/themes.js';
import { LAYOUTS, placement, REACH } from '../../web/js/layouts.js';
import { Flow } from '../../web/js/flow.js';

test('a theme from anywhere is cleaned: unknown keys dropped, numbers clamped, choices checked', () => {
  const t = normalizeTheme({ name: '<b>Evil</b>\u0000', mode: 'purple', background: 'doom', brightness: 900, glass: -5, corners: 'wide', motion: '40', tilt: 5, font: 'Comic Sans', flow: 'spiral', reflection: 'yes', accent: { mode: 'x', hue: 999, sat: 'a' }, script: 'alert(1)', css: 'body{display:none}' });
  assert.equal(t.name, 'bEvil/b');
  assert.deepEqual([t.mode, t.background, t.font, t.flow], [BASE.mode, BASE.background, BASE.font, BASE.flow]);
  assert.deepEqual([t.brightness, t.glass, t.corners, t.motion, t.tilt], [100, 0, BASE.corners, 40, 30]);
  assert.deepEqual(t.accent, { mode: BASE.accent.mode, hue: 359, sat: BASE.accent.sat });
  assert.equal(t.reflection, BASE.reflection);
  assert.deepEqual(Object.keys(t).sort(), [...THEME_KEYS].sort(), 'exactly the known settings survive');
});

test('the newer settings are checked too: a frame must be a real one, numbers are clamped', () => {
  const t = normalizeTheme({ frame: 'rainbow', glow: 900, grain: -5, density: 5 });
  assert.deepEqual([t.frame, t.glow, t.grain, t.density], [BASE.frame, 100, 0, 25]);
  const u = normalizeTheme({ frame: 'neon', glow: '70', grain: 33.6, density: 999 });
  assert.deepEqual([u.frame, u.glow, u.grain, u.density], ['neon', 70, 34, 200]);
  assert.equal(normalizeTheme({ frame: { toString: () => 'neon' } }).frame, BASE.frame, 'something that only prints like a frame name is not one');
});

test('a theme made before these settings existed still loads, with the old look', () => {
  const old = { flowdeckTheme: 1, name: 'Old file', mode: 'dark', background: 'aurora', accent: { mode: 'cover', hue: 200, sat: 60 }, brightness: 40, glass: 40, corners: 10, reflection: true, motion: 50, flow: 'fan', tilt: 50, font: 'serif' };
  const t = importJson(JSON.stringify(old));
  assert.deepEqual([t.frame, t.glow, t.grain, t.density], [BASE.frame, BASE.glow, BASE.grain, BASE.density]);
  assert.equal(t.background, 'aurora');
});

test('exporting and importing carries every setting, new ones included', () => {
  const rich = normalizeTheme({ ...PRESETS.find((p) => p.id === 'midnightcity') });
  const back = importJson(exportJson(rich));
  assert.deepEqual(back, rich);
  assert.deepEqual([back.frame, back.glow, back.grain], ['neon', 90, 20]);
  assert.deepEqual(Object.keys(JSON.parse(exportJson(rich))).sort(), ['flowdeckTheme', ...THEME_KEYS].sort());
});

test('the richer presets really use the newer settings, and between them use every background and frame', () => {
  const rich = PRESETS.filter((p) => ['nebula', 'deepspace', 'fireflies', 'midnightcity', 'dusk', 'plasma', 'vaporwave', 'wireframe', 'cinema', 'lagoon', 'silk', 'daybreak'].includes(p.id));
  assert.equal(rich.length, 12);
  for (const p of rich) assert.ok(p.frame !== 'soft' || p.grain > 0 || p.glow !== 50 || p.density !== 100, p.id);
  assert.deepEqual([...new Set(PRESETS.map((p) => p.background))].sort(), BACKGROUNDS.map(([k]) => k).sort());
  assert.deepEqual([...new Set(PRESETS.map((p) => p.frame))].sort(), FRAMES.map(([k]) => k).sort());
  assert.ok(PRESETS.filter((p) => p.mode === 'light').length >= 4, 'light themes are not forgotten');
});

test('things that are not themes are refused', () => {
  for (const bad of [null, 'text', 5, [1, 2]]) assert.throws(() => normalizeTheme(bad), /not a theme/);
});

test('theme files: export and import round-trip, and bad files give readable errors', () => {
  const original = normalizeTheme({ ...PRESETS[2], name: 'Mine' });
  assert.deepEqual(importJson(exportJson(original)), original);
  assert.throws(() => importJson('{nope'), /not valid JSON/);
  assert.throws(() => importJson('{"name":"x"}'), /not a Flowdeck theme/);
  assert.throws(() => importJson('x'.repeat(20001)), /too large/);
  assert.equal(importJson(`﻿${exportJson(original)}`).name, 'Mine', 'a byte-order mark is tolerated');
});

test('every built-in theme is already valid, uniquely named, and uses real backgrounds, fonts and layouts', () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.builtin);
    assert.deepEqual(normalizeTheme(p), { ...normalizeTheme(p) });
    assert.ok(BACKGROUNDS.some(([k]) => k === p.background) && p.font in FONTS && LAYOUTS.some(([k]) => k === p.flow), p.id);
    assert.equal(merge(p, {}).id, p.id);
  }
  assert.ok(PRESETS.length >= 10);
});

test('swatches are built from validated numbers only, for every background', () => {
  for (const [bg] of BACKGROUNDS) {
    const css = swatch(normalizeTheme({ ...BASE, background: bg, accent: { mode: 'fixed', hue: 200, sat: 50 } }));
    assert.match(css, /gradient/, bg);
    assert.ok(!/[;{}]/.test(css), bg);
  }
  assert.ok(LIMITS.tilt[0] < LIMITS.tilt[1]);
});

// ------------------------------------------------------------- cover-flow layouts

test('every layout puts the focused card in the middle, upright, fully visible and unshaded', () => {
  for (const [style] of LAYOUTS) {
    const p = placement(style, 0, 300, 58);
    assert.deepEqual([p.x, p.rotY, p.rotZ, p.opacity], [0, 0, 0, 1], style);
    assert.ok(p.scale >= 1 && p.shade === 0, style);
  }
});

test('neighbours mirror each other left and right, and never produce -0 for the browser', () => {
  for (const [style] of LAYOUTS) {
    for (const d of [0.4, 1, 2.5, 5]) {
      const l = placement(style, -d, 300, 58);
      const r = placement(style, d, 300, 58);
      assert.equal(l.x + r.x, 0, `${style} ${d}`);
      assert.equal(l.opacity, r.opacity, `${style} ${d}`);
    }
    for (const v of Object.values(placement(style, 0, 300, 58))) assert.ok(!Object.is(v, -0), style);
  }
  assert.ok(REACH >= 6);
});

test('the cover-flow only draws cards that can be seen', () => {
  const visible = (state, p) => Flow.prototype.visible.call(state, p);
  const slab = { style: 'slab', cw: 300, W: 1000 };
  assert.equal(visible(slab, placement('slab', 0, 300, 58)), true);
  assert.equal(visible(slab, placement('slab', 2, 300, 58)), true);
  assert.equal(visible(slab, placement('slab', 7, 300, 58)), false, 'far beyond the window edge');
  assert.equal(visible({ ...slab, W: 8000 }, placement('slab', 7, 300, 58)), false, 'faded out, however wide the window');
  assert.equal(visible({ ...slab, W: Infinity }, placement('slab', 4, 300, 58)), true, 'before the width is known nothing is culled');
  // a card that is partly on screen is kept: nothing visible is ever dropped
  for (const style of ['slab', 'carousel', 'stack', 'flat']) {
    for (const W of [500, 1000, 2000]) {
      for (let d = -8; d <= 8; d += 0.25) {
        const p = placement(style, d, 300, 58);
        const k = 1500 / Math.max(400, 1500 - p.z);
        const reallyOnScreen = p.opacity >= 0.03 && Math.abs(p.x) * k - (300 * p.scale * k) / 2 < W / 2 - 20;
        if (reallyOnScreen) assert.equal(visible({ style, cw: 300, W }, p), true, `${style} d=${d} W=${W}`);
      }
    }
  }
  assert.equal(visible({ style: 'fan', cw: 300, W: 100 }, placement('fan', 2, 300, 58)), true, 'fan cards swing about a distant point, so only fading hides them');
});

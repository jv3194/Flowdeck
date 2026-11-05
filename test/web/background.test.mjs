import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKGROUNDS, FRAMES, PARTICLE_BACKGROUNDS } from '../../web/js/themes.js';

// ---- a stand-in for the page and its canvas that records what is drawn, so every background can run in Node ----

function fakeContext(log) {
  const gradient = () => ({ addColorStop(offset, color) { log.colors.push(color); log.offsets.push(offset); } });
  const target = {
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() { log.calls.putImageData = (log.calls.putImageData || 0) + 1; },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      return (...args) => { log.calls[key] = (log.calls[key] || 0) + 1; for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) log.badNumbers.push(`${String(key)}(${args.join(', ')})`); };
    },
    set(t, key, value) {
      if (key === 'fillStyle' || key === 'strokeStyle') log.colors.push(value);
      t[key] = value;
      return true;
    },
  });
}

const log = { calls: {}, colors: [], offsets: [], badNumbers: [] };
const resetLog = () => { log.calls = {}; log.colors = []; log.offsets = []; log.badNumbers = []; };
const canvas = () => ({ width: 0, height: 0, getContext: () => fakeContext(log) });

globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.document = { documentElement: { style: { setProperty() {} } }, body: { classList: { contains: () => false } }, createElement: () => canvas() };
const { Background } = await import('../../web/js/bg.js');

const make = (cfg = {}) => {
  const bg = new Background(canvas());
  bg.configure({ motion: 60, brightness: 50, ...cfg });
  return bg;
};
const run = (bg, frames = 6) => {
  for (let i = 0; i < frames; i++) {
    bg.t += 0.5;
    bg.energy = i % 2 ? 0.7 : 0;
    bg.draw(1 / 30);
  }
};

test('every background draws in dark and in light without crashing, and never produces a NaN colour or coordinate', () => {
  for (const [style] of BACKGROUNDS) {
    for (const mode of ['dark', 'light']) {
      resetLog();
      const bg = make({ style, mode });
      bg.hue = 200; bg.sat = 0.7;
      assert.doesNotThrow(() => run(bg), `${style} ${mode}`);
      assert.ok(Object.values(log.calls).reduce((a, b) => a + b, 0) > 5, `${style} ${mode} drew nothing`);
      assert.deepEqual(log.badNumbers, [], `${style} ${mode} used a non-number`);
      const bad = log.colors.filter((c) => typeof c === 'string' && /NaN|undefined|Infinity/.test(c));
      assert.deepEqual(bad, [], `${style} ${mode} produced a bad colour`);
      assert.ok(log.offsets.every((o) => o >= 0 && o <= 1), `${style} ${mode} used a gradient stop outside 0..1`);
    }
  }
});

test('the backgrounds survive extremes: brightness at both ends, a tiny window, any hue, full music energy', () => {
  for (const [style] of BACKGROUNDS) {
    for (const brightness of [0, 100]) {
      resetLog();
      globalThis.innerWidth = 320; globalThis.innerHeight = 200;
      const bg = make({ style, brightness, mode: brightness ? 'light' : 'dark' });
      for (const hue of [0, 123.4, 359.9]) { bg.hue = hue; bg.energy = 1; bg.t = 1e5; assert.doesNotThrow(() => bg.draw(0.05), `${style} hue ${hue}`); }
      assert.deepEqual(log.badNumbers, [], `${style} ${brightness}`);
    }
  }
  globalThis.innerWidth = 1280; globalThis.innerHeight = 720;
});

test('the particle density setting thins out or thickens whatever moves, and leaves still backgrounds alone', () => {
  const count = (bg) => bg.bubbles.length + bg.parts.length + bg.fly.length + bg.stars.length;
  for (const style of ['waves', 'bubbles', 'rain', 'embers', 'snow', 'stars', 'nebula', 'fireflies']) {
    const few = count(make({ style, density: 25 }));
    const normal = count(make({ style, density: 100 }));
    const many = count(make({ style, density: 200 }));
    assert.ok(few < normal && normal < many, `${style}: ${few} < ${normal} < ${many}`);
    assert.ok(PARTICLE_BACKGROUNDS.includes(style), `${style} should be listed as having particles`);
  }
  for (const style of ['solid', 'gradient', 'ribbons', 'skyline', 'plasma', 'aurora', 'grid']) {
    assert.equal(count(make({ style, density: 200 })), count(make({ style, density: 25 })), `${style} has no particles to thin out`);
    assert.ok(!PARTICLE_BACKGROUNDS.includes(style), style);
  }
});

test('changing density in place rebuilds the stars, and changing style drops the old things', () => {
  const bg = make({ style: 'nebula', density: 100 });
  const before = bg.stars.length;
  bg.configure({ density: 200 });
  assert.ok(bg.stars.length > before);
  bg.configure({ style: 'solid' });
  assert.deepEqual([bg.fly.length, bg.parts.length], [0, 0]);
});

test('fireflies come back at the bottom after floating away, so their number holds steady', () => {
  const bg = make({ style: 'fireflies' });
  const n = bg.fly.length;
  for (let i = 0; i < 400; i++) { bg.t += 0.2; bg.draw(0.5); }
  assert.equal(bg.fly.length, n);
  assert.ok(bg.fly.every((f) => f.y > 0.05 && f.y < 1.2));
});

test('the skyline is the same city every time, and is made once per window size', () => {
  const a = make({ style: 'skyline' });
  const b = make({ style: 'skyline' });
  run(a, 1); run(b, 1);
  assert.deepEqual(a.city[2].towers.slice(0, 3).map((t) => [Math.round(t.x), Math.round(t.w), Math.round(t.h)]), b.city[2].towers.slice(0, 3).map((t) => [Math.round(t.x), Math.round(t.w), Math.round(t.h)]));
  const built = a.city;
  run(a, 3);
  assert.equal(a.city, built, 'not rebuilt every frame');
  a.resize();
  assert.equal(a.city, null, 'rebuilt for the new window size');
  assert.ok(a.city === null && (run(a, 1), a.city.length === 3));
});

test('plasma is worked out on a small picture, and its colours are rebuilt only when the hue has really moved', () => {
  resetLog();
  const bg = make({ style: 'plasma' });
  bg.hue = 100; bg.sat = 0.7;
  run(bg, 4);
  assert.equal(log.calls.putImageData, 4);
  assert.ok(bg.plasmaBuf.pw <= 100 && bg.plasmaBuf.ph <= 60, 'a small picture, stretched up');
  const lutBefore = Uint8ClampedArray.from(bg.plasmaBuf.lut);
  bg.hue = 100.4; run(bg, 1);
  assert.deepEqual(bg.plasmaBuf.lut, lutBefore, 'a tiny hue change does not rebuild the colours');
  bg.hue = 220; run(bg, 1);
  assert.notDeepEqual(bg.plasmaBuf.lut, lutBefore, 'a real change does');
});

test('nothing is drawn behind a video or photo, and the backdrop is drawn again straight away when it shows again', () => {
  const bg = make({ style: 'waves' });
  const drawn = () => { let n = 0; const orig = bg.draw.bind(bg); bg.draw = (...a) => { n++; return orig(...a); }; return () => n; };
  const count = drawn();
  document.body.classList.contains = () => true; // immersive: a video or photo is covering the page
  for (let i = 0; i < 30; i++) bg.frame(i * 40);
  assert.equal(count(), 0);
  document.body.classList.contains = () => false;
  bg.frame(2000);
  assert.ok(count() >= 1);
});

// ---------------------------------------------------------------- the stylesheet keeps up

test('every cover frame in the theme list has its look in the stylesheet', () => {
  const css = fs.readFileSync(new URL('../../web/css/app.css', import.meta.url), 'utf8');
  for (const [frame] of FRAMES) {
    if (frame === 'soft') continue; // the stylesheet's own look
    // two rules each: how a cover looks, and how the focused one looks
    const rules = css.split(`:root[data-frame="${frame}"]`).length - 1;
    assert.ok(rules >= 2, `the "${frame}" frame needs a look for covers and for the focused cover (found ${rules})`);
  }
  assert.ok(css.includes('--glow') && css.includes('--grain'), 'the glow and grain settings are used by the stylesheet');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { autoFactor, backdropSize, FrameGovernor, lowerTier, stepUiSize, thumbNeedsUpgrade, thumbSize, tierFor, uiFactor } from '../../web/js/quality.js';

test('at 1x density, Standard is exactly the old half-size backdrop; sharper tiers and denser screens get more real pixels', () => {
  const s = backdropSize('standard', 1920, 1080, 1);
  assert.deepEqual([s.logicalW, s.logicalH, s.pixelW, s.pixelH], [960, 540, 960, 540]);
  const hi = backdropSize('high', 1920, 1080, 1);
  assert.ok(hi.pixelW > s.pixelW && hi.pixelH > s.pixelH);
  const dense = backdropSize('standard', 1920, 1080, 2);
  assert.ok(dense.pixelW > s.pixelW);
  assert.equal(backdropSize('ultra', 1920, 1080, 2).logicalW, 960, 'drawing units never change with quality');
});

test('the backdrop never gets more pixels than its tier allows (beyond the half-size floor), and is always a whole, usable size', () => {
  const budgets = { low: 600_000, standard: 2_200_000, high: 4_200_000, ultra: 8_400_000 };
  for (const tier of Object.keys(budgets)) {
    for (const [w, h, dpr] of [[3840, 2160, 1], [3840, 2160, 2], [7680, 4320, 2], [320, 200, 1], [1280, 720, 1.5]]) {
      const s = backdropSize(tier, w, h, dpr);
      assert.ok(s.k >= 0.5, `${tier} ${w}x${h}`);
      const floor = s.logicalW * s.logicalH * 0.25 * 1.05; // k never drops below one half
      assert.ok(s.pixelW * s.pixelH <= Math.max(budgets[tier] * 1.02, floor), `${tier} ${w}x${h}@${dpr}: ${s.pixelW * s.pixelH}`);
      assert.ok(Number.isInteger(s.pixelW) && Number.isInteger(s.pixelH) && s.pixelW >= 2 && s.pixelH >= 2);
    }
  }
  assert.deepEqual(backdropSize('nonsense', 1000, 600), backdropSize('standard', 1000, 600), 'an unknown tier is Standard');
});

test('Auto means whatever the governor settled on, starting at High; a chosen tier wins', () => {
  assert.equal(tierFor('auto', undefined), 'high');
  assert.equal(tierFor('auto', 'standard'), 'standard');
  assert.equal(tierFor('ultra', 'low'), 'ultra');
  assert.equal(tierFor('garbage', 'garbage'), 'high');
  assert.equal(lowerTier('ultra'), 'high');
  assert.equal(lowerTier('low'), 'low');
});

test('thumbnails are sized to the screen within the tier limit, and only redone when clearly too small', () => {
  assert.equal(thumbSize('standard', 1920, 1), 720);
  assert.equal(thumbSize('ultra', 3840, 1), 1440);
  assert.equal(thumbSize('standard', 3840, 2), 960, 'capped by the tier');
  assert.equal(thumbSize('ultra', 800, 1), 480, 'never below the floor');
  assert.equal(thumbNeedsUpgrade(640, 720), false);
  assert.equal(thumbNeedsUpgrade(640, 1440), true);
  assert.equal(thumbNeedsUpgrade(undefined, 1440), true, 'an old thumbnail with no recorded size counts as 640');
  assert.equal(thumbNeedsUpgrade(1440, 1440), false);
});

test('the governor lowers quality only after two slow windows in a row, and ignores hitches and pauses', () => {
  const feed = (g, ms, n) => { let r = null; for (let i = 0; i < n; i++) r = g.push(ms) || r; return r; };
  const g = new FrameGovernor({ window: 10, settleFrames: 5 });
  assert.equal(feed(g, 16, 200), null, 'a smooth machine is left alone');

  const hitchy = new FrameGovernor({ window: 10, settleFrames: 5 });
  const results = [];
  for (let i = 0; i < 200; i++) results.push(hitchy.push(i % 5 === 0 ? 80 : 16)); // a fifth of frames are slow: the middle is still fast
  assert.ok(results.every((r) => r === null));

  const slow = new FrameGovernor({ window: 10, settleFrames: 5 });
  let at = -1;
  for (let i = 0; i < 100 && at < 0; i++) if (slow.push(40) === 'down') at = i;
  assert.equal(at, 5 + 10 + 10 - 1, 'settle, then two full windows');

  const one = new FrameGovernor({ window: 10, settleFrames: 5 });
  feed(one, 40, 15); // settle plus one slow window
  feed(one, 16, 10); // then a good one: the count starts over
  assert.equal(feed(one, 40, 10), null);

  const paused = new FrameGovernor({ window: 10, settleFrames: 5 });
  feed(paused, 40, 14);
  paused.push(900); // a pause is not a measure of speed: start over
  assert.equal(feed(paused, 40, 14), null);
});

test('interface size: Auto follows the screen, the choices are clamped, and stepping moves one size at a time', () => {
  assert.deepEqual([1920, 2560, 2880, 3840].map(autoFactor), [1, 1, 1.25, 1.5]);
  assert.equal(uiFactor('auto', 3840), 1.5);
  assert.equal(uiFactor('normal', 3840), 1);
  assert.equal(uiFactor('large', 1920), 1.2);
  assert.equal(uiFactor('nonsense', 1920), 1);
  assert.equal(stepUiSize('normal', 1, 1920), 'large');
  assert.equal(stepUiSize('normal', -1, 1920), 'small');
  assert.equal(stepUiSize('xlarge', 1, 1920), 'xlarge');
  assert.equal(stepUiSize('small', -1, 1920), 'small');
  assert.equal(stepUiSize('auto', 1, 3840), 'xlarge', 'Auto counts as the size it picks (1.5 is nearest Extra large)');
});

// ---- the backdrop uses it ----

test('the backdrop canvas follows the tier, draws in unchanged logical units, and scales them onto its pixels', async () => {
  const transforms = [];
  const ctx = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), setTransform: (...a) => transforms.push(a) }, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0;
  globalThis.innerWidth = 1600; globalThis.innerHeight = 900; globalThis.devicePixelRatio = 1;
  globalThis.document = { documentElement: { style: { setProperty() {} } }, body: { classList: { contains: () => false } }, createElement: () => ({ getContext: () => ctx }) };
  const { Background } = await import('../../web/js/bg.js');
  const cv = { width: 0, height: 0, getContext: () => ctx };
  const bg = new Background(cv);
  bg.configure({ motion: 60, brightness: 50, mode: 'dark', style: 'gradient' });
  const logical = [bg.w, bg.h];
  assert.deepEqual(logical, [800, 450]);
  assert.deepEqual([cv.width, cv.height], [800, 450], 'Standard at 1x is the old half-size canvas');
  bg.setTier('ultra');
  assert.deepEqual([bg.w, bg.h], logical, 'logical size is the same at every tier');
  assert.ok(cv.width > 800 && cv.height > 450);
  transforms.length = 0;
  bg.draw(1 / 30);
  const [sx, , , sy] = transforms.at(-1);
  assert.ok(Math.abs(sx - cv.width / bg.w) < 1e-9 && Math.abs(sy - cv.height / bg.h) < 1e-9);
  const before = [cv.width, cv.height];
  bg.setTier('ultra'); // no change: nothing to redo
  assert.deepEqual([cv.width, cv.height], before);
});

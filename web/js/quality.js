// Picture quality and interface size, as plain rules that can be tested: how sharp the animated backdrop is drawn, how
// big a generated thumbnail is, when to lower the quality on a machine that struggles, and how large the interface is.

// ----------------------------------------------------------------------------------------------- graphics quality

/** The tiers, best last. "low" is only ever reached by the safety governor, never offered as a choice. */
export const TIERS = ['low', 'standard', 'high', 'ultra'];
export const QUALITY_CHOICES = [['auto', 'Auto'], ['standard', 'Standard'], ['high', 'High'], ['ultra', 'Ultra']];

// scale: the share of the screen's real (device) pixels the backdrop is drawn at. budget: the most pixels it may ever have.
// thumb: the longest side, in pixels, a generated thumbnail may have.
const SPEC = {
  low: { scale: 0.35, budget: 600_000, thumb: 480 },
  standard: { scale: 0.5, budget: 2_200_000, thumb: 960 },
  high: { scale: 0.75, budget: 4_200_000, thumb: 1280 },
  ultra: { scale: 1, budget: 8_400_000, thumb: 1920 },
};

export const isTier = (t) => TIERS.includes(t);
export const lowerTier = (t) => TIERS[Math.max(0, TIERS.indexOf(t) - 1)];

/** What the page should use for a chosen setting: "auto" is whatever the governor last settled on (starting at High). */
export const tierFor = (choice, autoTier) => (choice === 'auto' || !isTier(choice) ? (isTier(autoTier) ? autoTier : 'high') : choice);

/**
 * How the backdrop's canvas is sized. The drawing code works in "logical" units (half the window's CSS size, as it
 * always has), so none of it changes with quality. `k` is how many real canvas pixels each logical unit gets, which is
 * what makes a backdrop sharp on a high-density screen or a big monitor.
 * Returns { logicalW, logicalH, pixelW, pixelH, k }.
 */
export function backdropSize(tier, cssW, cssH, dpr = 1) {
  const spec = SPEC[isTier(tier) ? tier : 'standard'];
  const logicalW = Math.max(2, Math.round(cssW * 0.5));
  const logicalH = Math.max(2, Math.round(cssH * 0.5));
  let k = (Math.max(1, dpr) * spec.scale) / 0.5; // at 1x density, "standard" is exactly the old half-size canvas
  k = Math.min(k, Math.sqrt(spec.budget / (logicalW * logicalH))); // never more pixels than the tier allows
  k = Math.max(0.5, k);
  return { logicalW, logicalH, pixelW: Math.max(2, Math.round(logicalW * k)), pixelH: Math.max(2, Math.round(logicalH * k)), k };
}

/**
 * The longest side of a thumbnail to generate: about what a focused cover needs on this screen, within the tier's limit.
 * `screenLong` is the screen's longer side in CSS pixels.
 */
export function thumbSize(tier, screenLong, dpr = 1) {
  const spec = SPEC[isTier(tier) ? tier : 'standard'];
  const wanted = Math.ceil((0.37 * screenLong * Math.max(1, dpr)) / 80) * 80; // a cover is roughly a third of the screen
  return Math.max(480, Math.min(spec.thumb, wanted));
}

/** Whether an existing thumbnail is small enough, for what is wanted now, to be worth making again. */
export const thumbNeedsUpgrade = (haveLong, wantLong) => (haveLong || 640) < wantLong * 0.75;

/**
 * Watches how long frames take and says when to lower the quality. It looks at the *middle* frame time of a window
 * of frames (so a few hitches do not count), and wants two slow windows in a row before it acts. It never raises the
 * quality again by itself: a machine that struggled once will struggle again, and flip-flopping is worse than a lower tier.
 */
export class FrameGovernor {
  constructor({ window = 90, slowMs = 24, settleFrames = 60 } = {}) {
    this.window = window;
    this.slowMs = slowMs;
    this.settle = settleFrames; // frames to ignore after any change, while things warm up
    this.frames = [];
    this.skip = settleFrames;
    this.slowWindows = 0;
  }

  /** Forget what was measured (after a change of tier, a resize, or coming back to the window). */
  reset() {
    this.frames = [];
    this.skip = this.settle;
    this.slowWindows = 0;
  }

  /** Feed the time of one frame, in milliseconds. Returns "down" when the quality should be lowered a step. */
  push(ms) {
    if (!(ms > 0) || ms > 250) { this.reset(); return null; } // a hidden tab, a debugger pause, a drag of the window: not a measure of speed
    if (this.skip > 0) { this.skip--; return null; }
    this.frames.push(ms);
    if (this.frames.length < this.window) return null;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frames = [];
    this.slowWindows = median > this.slowMs ? this.slowWindows + 1 : 0;
    if (this.slowWindows >= 2) { this.reset(); return 'down'; }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- interface size

/** Choices for how big the interface is. "auto" follows the screen: a 4K screen at 100% scaling gets a bigger interface. */
export const UI_SIZES = [['auto', 'Auto'], ['small', 'Small'], ['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']];
const UI_FACTOR = { small: 0.9, normal: 1, large: 1.2, xlarge: 1.45 };

/** The factor Auto picks, from the screen's width in CSS pixels (what the system reports after its own scaling). */
export function autoFactor(screenCssWidth) {
  if (screenCssWidth >= 3400) return 1.5;
  if (screenCssWidth >= 2800) return 1.25;
  return 1;
}

/** The zoom factor for a chosen size. Always within what the window can show sensibly. */
export function uiFactor(choice, screenCssWidth) {
  const f = choice === 'auto' || !(choice in UI_FACTOR) ? autoFactor(screenCssWidth) : UI_FACTOR[choice];
  return Math.min(2, Math.max(0.75, f));
}

/** The next size up (dir 1) or down (dir -1) from where things are now; "auto" counts as the size it resolves to. */
export function stepUiSize(choice, dir, screenCssWidth) {
  const order = ['small', 'normal', 'large', 'xlarge'];
  const now = uiFactor(choice, screenCssWidth);
  const at = order.reduce((best, k, i) => (Math.abs(UI_FACTOR[k] - now) < Math.abs(UI_FACTOR[order[best]] - now) ? i : best), 0);
  return order[Math.max(0, Math.min(order.length - 1, at + dir))];
}

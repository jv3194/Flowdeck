// Animated backdrop with several styles (see BACKGROUNDS in themes.js), in dark or light.
// Rendered at half resolution (it is all soft gradients), tinted by a hue that eases toward the focused cover,
// and pushed around by the music's energy. With motion at 0 it draws only when something changes.
import { backdropSize } from './quality.js';
import { clamp, hueDelta, lerp } from './util.js';

const TAU = Math.PI * 2;
const STEP = 1 / 30 - 0.004; // the shortest time between two drawings of the backdrop (seconds)
const STEP_BUSY = 1 / 15 - 0.004; // ...and while the shelf is gliding, when nobody is watching the backdrop and every frame counts
// Particle styles: one drop/ember/flake per `per` pixels of the (half-size) canvas, within min..max.
const PARTICLES = {
  rain: { per: 1800, min: 70, max: 260 },
  embers: { per: 1900, min: 60, max: 230 },
  snow: { per: 1500, min: 90, max: 320 },
};

/** HSL (degrees, percent, percent) as three 0-255 numbers. */
function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s /= 100;
  l /= 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

export class Background {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cfg = { style: 'waves', mode: 'dark', brightness: 50, motion: 60, density: 100 };
    this.hue = 322;
    this.targetHue = 322;
    this.sat = 0.62;
    this.targetSat = 0.62;
    this.energy = 0;
    this.targetEnergy = 0;
    this.t = 0;
    this.last = 0;
    this.acc = 0; // time since the backdrop was last drawn
    this.busy = () => false; // set by whatever is animating in front (the cover flow): true while it is moving
    this.tier = 'standard'; // graphics quality (see quality.js): how many real pixels the backdrop is drawn with
    this.onFrame = null; // told how long each frame took while the backdrop animates, so the app can lower quality on a machine that struggles
    this.wasCovered = false;
    this.dirty = true;
    this.bubbles = [];
    this.stars = [];
    this.parts = []; // rain drops, embers or snowflakes, whichever style is showing
    this.partKind = '';
    this.ripples = [];
    this.shoot = null;
    this.nextShoot = 4;
    this.fly = []; // fireflies
    this.starKey = ''; // what the star field was made for (style and density), so it is rebuilt only when that changes
    this.sprite = null; // the soft glow a firefly is drawn with, tinted to the current hue
    this.city = null; // the skyline's buildings, made once per window size
    this.plasmaBuf = null; // the small picture the plasma is computed into, then scaled up
    addEventListener('resize', () => this.resize());
    this.resize();
    this.seed();
    requestAnimationFrame((n) => this.frame(n));
  }

  /** Change style, light/dark, brightness (0-100) or motion (0-100). */
  configure(cfg) {
    Object.assign(this.cfg, cfg);
    this.dirty = true;
    this.seed();
  }

  /** Change the graphics quality: the backdrop is redrawn at the new sharpness. */
  setTier(tier) {
    if (tier === this.tier) return;
    this.tier = tier;
    this.resize();
  }

  setTint(hue, sat = 0.62) {
    this.targetHue = hue;
    this.targetSat = sat;
  }

  setEnergy(e) {
    this.targetEnergy = e;
  }

  resize() {
    // The drawing code always works in "logical" units (half the window's size); the canvas itself gets as many real
    // pixels as the quality tier and the screen's density call for, and draw() scales the one onto the other.
    const size = backdropSize(this.tier, innerWidth, innerHeight, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this.w = size.logicalW;
    this.h = size.logicalH;
    this.cv.width = size.pixelW;
    this.cv.height = size.pixelH;
    this.dirty = true;
    this.stars = [];
    this.starKey = '';
    this.parts = [];
    this.fly = [];
    this.city = null;
    this.plasmaBuf = null;
    this.seed();
  }

  seed() {
    const style = this.cfg.style;
    const k = clamp((this.cfg.density ?? 100) / 100, 0.25, 2); // the theme's "Particles" setting: how thick the moving things are
    const wantBubbles = Math.round((style === 'bubbles' ? 46 : style === 'waves' ? 26 : 0) * k);
    if (this.bubbles.length !== wantBubbles) this.bubbles = Array.from({ length: wantBubbles }, (_, i) => this.makeBubble(i, true));
    const kind = PARTICLES[style];
    if (kind) {
      const n = clamp(Math.round(((this.w * this.h) / kind.per) * k), Math.round(kind.min * k), Math.round(kind.max * k));
      if (this.partKind !== style || this.parts.length !== n) {
        this.partKind = style;
        this.parts = Array.from({ length: n }, () => this.makeParticle(style, true));
        this.ripples = [];
      }
    } else {
      this.parts = [];
      this.partKind = '';
    }
    if (style === 'stars' || style === 'nebula') {
      const key = `${style}|${k}`;
      if (this.starKey !== key || !this.stars.length) {
        this.starKey = key;
        const n = clamp(Math.round(((this.w * this.h) / (style === 'nebula' ? 3200 : 2200)) * k), Math.round(60 * k), Math.round(280 * k));
        this.stars = Array.from({ length: n }, () => ({ x: Math.random() * this.w, y: Math.random() * this.h * 0.9, r: 0.4 + Math.random() ** 3 * 1.7, z: 0.2 + Math.random() * 0.8, tw: Math.random() * TAU, sp: 0.5 + Math.random() * 2 }));
      }
    }
    if (style === 'fireflies') {
      const n = Math.round(clamp((this.w * this.h) / 4200, 26, 64) * k);
      if (this.fly.length !== n) this.fly = Array.from({ length: n }, () => this.makeFly(true));
    } else {
      this.fly = [];
    }
  }

  makeFly(scatter) {
    return {
      x: Math.random(), y: scatter ? 0.12 + Math.random() * 0.88 : 1.04 + Math.random() * 0.1, ph: Math.random() * TAU,
      sp: 0.15 + Math.random() * 0.35, r: 1.1 + Math.random() * 2, wx: 0.012 + Math.random() * 0.03, rise: 0.004 + Math.random() * 0.012, pulse: 0.5 + Math.random() * 1.2,
    };
  }

  /** A small canvas that is not on screen (Chromium's OffscreenCanvas where there is one). */
  makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  makeBubble(i, scatter) {
    const big = this.cfg.style === 'bubbles' ? 1.5 : 1;
    const r = (5 + Math.pow(Math.random(), 2.4) * 34) * big;
    return {
      x: Math.random(),
      y: scatter ? Math.random() : 1.1 + Math.random() * 0.2,
      r,
      v: 0.012 + Math.random() * 0.03 + (60 - r) * 0.0004,
      sway: 0.3 + Math.random() * 0.8,
      amp: 0.01 + Math.random() * 0.03,
      ph: Math.random() * TAU,
      a: 0.25 + Math.random() * 0.5,
    };
  }

  /** A new drop, ember or flake. Positions are fractions of the canvas; `scatter` spreads them over the screen. */
  makeParticle(kind, scatter) {
    const r = Math.random();
    if (kind === 'rain') {
      // Nearer drops are longer, brighter and land lower on the "ground".
      return { x: Math.random() * 1.25 - 0.05, y: scatter ? Math.random() : -Math.random() * 0.3, len: 0.03 + r * 0.07, v: 0.9 + r * 0.9, a: 0.15 + r * 0.45, w: 0.6 + r * 0.9, g: 0.82 + r * 0.16 };
    }
    if (kind === 'embers') {
      return { x: Math.random(), y: scatter ? Math.random() : 1.02 + Math.random() * 0.1, r: 0.6 + r * r * 2.6, v: 0.04 + r * 0.13, sway: 0.5 + Math.random() * 1.5, amp: 0.01 + Math.random() * 0.03, ph: Math.random() * TAU, fl: 2 + Math.random() * 6 };
    }
    return { x: Math.random(), y: scatter ? Math.random() : -0.05 - Math.random() * 0.1, r: 0.5 + r * r * 2.3, v: 0.02 + r * 0.07, sway: 0.3 + Math.random() * 0.9, amp: 0.01 + Math.random() * 0.03, ph: Math.random() * TAU };
  }

  frame(now) {
    const raw = this.last ? now - this.last : 0; // the real time since the last frame, not capped: the governor judges the machine by it
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0.016);
    this.last = now;
    const step = (rate) => Math.min(1, dt * rate);
    const hueGap = hueDelta(this.hue, this.targetHue);
    this.hue = (this.hue + hueGap * step(2.6) + 360) % 360;
    this.sat = lerp(this.sat, this.targetSat, step(2.6));
    this.energy = lerp(this.energy, this.targetEnergy, step(9));
    const speed = this.cfg.motion / 60;
    this.t += dt * speed * (1 + this.energy * 1.5);

    // Mirror the eased hue into CSS so accents (glows, highlights) follow the backdrop.
    if (Math.abs(hueDelta(this.cssHue ?? -99, this.hue)) > 0.5) {
      this.cssHue = this.hue;
      document.documentElement.style.setProperty('--hue', this.hue.toFixed(1));
    }

    const settled = Math.abs(hueGap) < 0.05 && Math.abs(this.sat - this.targetSat) < 0.002 && this.energy < 0.01;
    // Everything above the backdrop has to be composited again each time it changes, which is far more costly than
    // drawing it. A slow ambient animation looks the same at 30 fps, and it needs no drawing at all behind a video or photo.
    const covered = document.body.classList.contains('immersive');
    if (this.onFrame && !covered && this.cfg.motion > 0 && !document.hidden) this.onFrame(raw);
    this.acc = Math.min(0.1, this.acc + dt);
    if (covered) {
      this.acc = 0;
      this.wasCovered = true;
    } else {
      if (this.wasCovered) { this.wasCovered = false; this.dirty = true; } // draw straight away once it shows again
      const due = this.acc >= (this.busy() ? STEP_BUSY : STEP);
      if (this.dirty || (due && (this.cfg.motion > 0 || !settled))) {
        this.draw(this.acc * speed);
        this.acc = 0;
        this.dirty = false;
      }
    }
    requestAnimationFrame((n) => this.frame(n));
  }

  hsl(h, s, l, a = 1) {
    return `hsla(${((h % 360) + 360) % 360},${Math.round(s)}%,${Math.round(l)}%,${a})`;
  }

  draw(dt) {
    const { ctx, w, h } = this;
    const L = this.cfg.mode === 'light';
    const draw = { waves: this.waves, aurora: this.aurora, grid: this.grid, stars: this.stars_, bubbles: this.bubblesOnly, gradient: this.softGradient, solid: this.solid, rain: this.rain, embers: this.embers, snow: this.snow, nebula: this.nebula, fireflies: this.fireflies, ribbons: this.ribbons, skyline: this.skyline, plasma: this.plasma }[this.cfg.style] || this.waves;
    ctx.setTransform(this.cv.width / w, 0, 0, this.cv.height / h, 0, 0); // logical units onto real pixels (a canvas that is resized forgets this)
    ctx.imageSmoothingQuality = 'high';
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt'; // canvas state outlives a frame: a style that rounds its lines must not leak that to the next
    draw.call(this, ctx, w, h, L, dt);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The vertical gradient most styles sit on. brightness 50 is the classic look. */
  base(ctx, w, h, L) {
    const b = this.cfg.brightness / 100;
    const s = this.sat * 100;
    const stops = L
      ? [[0, 80 + b * 14, s * 0.55], [0.5, 74 + b * 16, s * 0.6], [1, 64 + b * 20, s * 0.7]]
      : [[0, clamp(54 * b, 0, 58), s], [0.5, clamp(32 * b, 0, 36), s + 4], [1, clamp(14 * b, 0, 16), s + 8]];
    const g = ctx.createLinearGradient(0, 0, 0, h);
    stops.forEach(([at, l, ss], i) => g.addColorStop(at, this.hsl(this.hue + i * 18, ss, l)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  keyLight(ctx, w, h, L) {
    const e = this.energy;
    const r = ctx.createRadialGradient(w * 0.5, h * 0.12, 0, w * 0.5, h * 0.12, h * 0.95);
    r.addColorStop(0, L ? this.hsl(this.hue - 12, 100, 98, 0.7) : this.hsl(this.hue - 12, 95, 62, 0.34 + e * 0.2));
    r.addColorStop(1, L ? this.hsl(this.hue - 12, 100, 98, 0) : this.hsl(this.hue - 12, 95, 62, 0));
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, w, h);
  }

  bubbleLayer(ctx, w, h, L, dt) {
    const speed = 1 + this.energy * 3;
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      b.y -= b.v * dt * speed;
      if (b.y < -0.2) this.bubbles[i] = this.makeBubble(i, false);
      const x = (b.x + Math.sin(this.t * b.sway + b.ph) * b.amp) * w;
      const y = b.y * h;
      const rr = b.r * (1 + this.energy * 0.15);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fillStyle = L ? this.hsl(this.hue, 70, 50, 0.05 * b.a) : this.hsl(this.hue + 10, 95, 82, 0.05 * b.a + this.energy * 0.03);
      ctx.fill();
      ctx.strokeStyle = L ? this.hsl(this.hue, 70, 35, 0.28 * b.a) : this.hsl(this.hue + 10, 95, 92, 0.32 * b.a);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - rr * 0.38, y - rr * 0.4, rr * 0.2, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${(L ? 0.7 : 0.35) * b.a})`;
      ctx.fill();
    }
  }

  // ----------------------------------------------------------------- styles

  waves(ctx, w, h, L, dt) {
    const { hue, t, energy } = this;
    this.base(ctx, w, h, L);
    this.keyLight(ctx, w, h, L);
    ctx.save();
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < 3; i++) {
      const cx = w * (0.2 + i * 0.3) + Math.sin(t * 0.07 + i * 2) * w * 0.08;
      const bw = w * (0.1 + i * 0.03);
      const lg = ctx.createLinearGradient(cx - bw, 0, cx + bw, 0);
      const c = (a) => (L ? this.hsl(hue + 20, 100, 99, a) : this.hsl(hue + 20, 90, 70, a));
      lg.addColorStop(0, c(0));
      lg.addColorStop(0.5, c((L ? 0.16 : 0.045) + energy * 0.03));
      lg.addColorStop(1, c(0));
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(cx - bw + h * 0.25, 0);
      ctx.lineTo(cx + bw + h * 0.25, 0);
      ctx.lineTo(cx + bw - h * 0.25, h);
      ctx.lineTo(cx - bw - h * 0.25, h);
      ctx.fill();
    }
    ctx.restore();

    for (let i = 0; i < 5; i++) {
      const baseY = h * (0.6 + i * 0.075);
      const amp = h * (0.03 + i * 0.007) * (1 + energy * 1.3);
      const k = ((1.1 + i * 0.32) * TAU) / w;
      const sp = (0.22 + i * 0.07) * (i % 2 ? -1 : 1);
      const grad = ctx.createLinearGradient(0, baseY - amp, 0, h);
      grad.addColorStop(0, L ? this.hsl(hue + 8 + i * 9, 70, 52, 0.17 + i * 0.02) : this.hsl(hue + 8 + i * 9, 88, 70, 0.13 + i * 0.012));
      grad.addColorStop(1, L ? this.hsl(hue + 30, 70, 45, 0.04) : this.hsl(hue + 30, 80, 40, 0.03));
      ctx.beginPath();
      ctx.moveTo(0, h);
      let first = true;
      for (let x = 0; x <= w + 8; x += 8) {
        const y = baseY + Math.sin(x * k + t * sp + i * 1.7) * amp + Math.sin(x * k * 2.3 - t * sp * 0.7 + i) * amp * 0.42;
        if (first) { ctx.lineTo(0, y); first = false; }
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = L ? this.hsl(hue + 10, 70, 40, 0.18 + i * 0.015) : this.hsl(hue + 10, 95, 85, 0.1 + i * 0.012);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    this.bubbleLayer(ctx, w, h, L, dt);
  }

  aurora(ctx, w, h, L) {
    const { t, hue, energy } = this;
    this.base(ctx, w, h, L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < 5; i++) {
      const a = t * 0.05 * (1 + i * 0.3) + i * 1.7;
      const x = w * (0.5 + 0.38 * Math.sin(a * 1.1 + i));
      const y = h * (0.35 + 0.28 * Math.cos(a * 0.9 + i * 2));
      const r = h * (0.55 + 0.15 * Math.sin(a + i)) * (1 + energy * 0.25);
      const hh = hue + (i - 2) * 34;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, this.hsl(hh, 90, L ? 62 : 52, L ? 0.55 : 0.42));
      g.addColorStop(1, this.hsl(hh, 90, L ? 62 : 52, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  softGradient(ctx, w, h, L) {
    const { t, hue } = this;
    this.base(ctx, w, h, L);
    this.keyLight(ctx, w, h, L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < 2; i++) {
      const a = t * 0.04 + i * 3.1;
      const x = w * (0.5 + 0.35 * Math.cos(a));
      const y = h * (0.5 + 0.3 * Math.sin(a * 1.3));
      const g = ctx.createRadialGradient(x, y, 0, x, y, h * 0.9);
      g.addColorStop(0, this.hsl(hue + i * 45, 85, L ? 70 : 50, L ? 0.45 : 0.3));
      g.addColorStop(1, this.hsl(hue + i * 45, 85, L ? 70 : 50, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  solid(ctx, w, h, L) {
    const b = this.cfg.brightness / 100;
    ctx.fillStyle = L ? this.hsl(this.hue, this.sat * 25, 90 + b * 6) : this.hsl(this.hue, this.sat * 30, b * 16);
    ctx.fillRect(0, 0, w, h);
  }

  /** Slanted rain, with rings spreading where drops land. */
  rain(ctx, w, h, L, dt) {
    const { hue, energy } = this;
    const slant = -0.2; // sideways pixels per downward pixel
    const fall = (1 + energy * 2) * 0.9;
    this.base(ctx, w, h, L);
    this.keyLight(ctx, w, h, L);
    // A wet ground: a soft band of light where the rain lands.
    const sheen = ctx.createLinearGradient(0, h * 0.8, 0, h);
    sheen.addColorStop(0, this.hsl(hue + 10, 80, L ? 40 : 60, 0));
    sheen.addColorStop(1, this.hsl(hue + 10, 80, L ? 40 : 60, L ? 0.16 : 0.14 + energy * 0.1));
    ctx.fillStyle = sheen;
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
    ctx.lineCap = 'round';
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.y += p.v * fall * dt;
      p.x += slant * p.v * fall * dt * (h / w);
      if (p.y > p.g) {
        if (this.ripples.length < 40 && Math.random() < 0.55) this.ripples.push({ x: p.x * w, y: p.g * h, r: 1, life: 1, a: p.a });
        this.parts[i] = this.makeParticle('rain', false);
        continue;
      }
      const x = p.x * w;
      const y = p.y * h;
      const len = p.len * h;
      ctx.strokeStyle = L ? this.hsl(hue, 45, 30, p.a * 0.85) : this.hsl(hue + 12, 85, 82, p.a);
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - slant * len, y - len);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    this.ripples = this.ripples.filter((r) => {
      r.r += dt * 26;
      r.life -= dt * 1.3;
      if (r.life <= 0) return false;
      ctx.strokeStyle = L ? this.hsl(hue, 50, 30, r.life * r.a * 0.8) : this.hsl(hue + 12, 90, 80, r.life * r.a);
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r, r.r * 0.28, 0, 0, TAU);
      ctx.stroke();
      return true;
    });
  }

  /** Sparks lifting off a hot floor, cooling and shrinking as they rise. */
  embers(ctx, w, h, L, dt) {
    const { hue, t, energy } = this;
    this.base(ctx, w, h, L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    const glow = ctx.createRadialGradient(w / 2, h * 1.12, 0, w / 2, h * 1.12, h * 0.95);
    glow.addColorStop(0, this.hsl(hue - 8, 100, L ? 62 : 52, (L ? 0.55 : 0.5) + energy * 0.2));
    glow.addColorStop(1, this.hsl(hue - 8, 100, L ? 62 : 52, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const rise = 1 + energy * 2.5;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.y -= p.v * rise * dt;
      if (p.y < -0.05) {
        this.parts[i] = this.makeParticle('embers', false);
        continue;
      }
      const heat = clamp(p.y, 0, 1); // hottest near the floor
      const flick = 0.6 + 0.4 * Math.sin(t * p.fl + p.ph);
      const a = Math.pow(heat, 0.7) * flick;
      const x = (p.x + Math.sin(t * p.sway + p.ph) * p.amp) * w;
      const y = p.y * h;
      const size = p.r * (0.35 + 0.65 * heat) * (1 + energy * 0.4);
      ctx.beginPath();
      ctx.arc(x, y, size * 3.4, 0, TAU);
      ctx.fillStyle = L ? this.hsl(hue, 90, 50, a * 0.1) : this.hsl(hue - 6, 100, 55, a * 0.13);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fillStyle = L ? this.hsl(hue, 90, 42, a * 0.9) : this.hsl(hue + 22 * (1 - heat) - 4, 100, 62 + heat * 22, a * 0.95);
      ctx.fill();
    }
  }

  /** Flakes drifting down in a few layers of depth. */
  snow(ctx, w, h, L, dt) {
    const { hue, t, energy } = this;
    this.base(ctx, w, h, L);
    const mist = ctx.createLinearGradient(0, h * 0.6, 0, h);
    mist.addColorStop(0, this.hsl(hue, 50, L ? 90 : 80, 0));
    mist.addColorStop(1, this.hsl(hue, 50, L ? 90 : 80, L ? 0.35 : 0.14));
    ctx.fillStyle = mist;
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
    const drift = 1 + energy * 0.8;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.y += p.v * drift * dt;
      if (p.y > 1.04) {
        this.parts[i] = this.makeParticle('snow', false);
        continue;
      }
      const x = (p.x + Math.sin(t * p.sway + p.ph) * p.amp) * w;
      ctx.beginPath();
      ctx.arc(x, p.y * h, p.r * (1 + energy * 0.2), 0, TAU);
      ctx.fillStyle = L ? this.hsl(hue, 55, 52, 0.35 + p.r * 0.14) : this.hsl(hue, 45, 96, 0.3 + p.r * 0.16);
      ctx.fill();
    }
  }

  // ------------------------------------------------------------- the newer styles

  /** Slow clouds of colour drifting over a field of stars. */
  nebula(ctx, w, h, L) {
    const { t, hue, energy } = this;
    this.base(ctx, w, h, L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < 7; i++) {
      const a = t * 0.018 * (1 + i * 0.23) + i * 2.1;
      const x = w * (0.5 + 0.42 * Math.sin(a * 1.3 + i));
      const y = h * (0.45 + 0.36 * Math.cos(a + i * 1.7));
      const r = Math.max(w, h) * (0.28 + 0.14 * Math.sin(a * 0.7 + i * 3)) * (1 + energy * 0.2);
      const hh = hue + ((i % 3) - 1) * 46 + Math.sin(a) * 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, this.hsl(hh, 85, L ? 68 : 50, L ? 0.4 : 0.26));
      g.addColorStop(0.55, this.hsl(hh + 10, 80, L ? 72 : 40, L ? 0.18 : 0.1));
      g.addColorStop(1, this.hsl(hh, 80, 50, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this.stars) {
      const x = (((s.x - t * 1.6 * s.z) % w) + w) % w;
      const tw = 0.5 + 0.5 * Math.sin(t * s.sp + s.tw);
      const a = (0.25 + 0.75 * tw) * (1 + energy * 0.5);
      ctx.beginPath();
      ctx.arc(x, s.y, s.r * (1 + energy * 0.3), 0, TAU);
      ctx.fillStyle = L ? this.hsl(hue + 200, 40, 30, Math.min(0.5, a * 0.35)) : this.hsl(hue + s.z * 40, 35, 94, Math.min(1, a));
      ctx.fill();
    }
  }

  /** The soft round glow a firefly is drawn with: made once, and again when the hue has moved on. */
  glowSprite(L) {
    if (this.sprite && this.sprite.L === L && Math.abs(hueDelta(this.sprite.hue, this.hue)) < 5) return this.sprite.cv;
    const cv = this.makeCanvas(64, 64);
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, this.hsl(this.hue + 30, 100, L ? 50 : 88, 1));
    g.addColorStop(0.3, this.hsl(this.hue + 30, 100, L ? 55 : 62, L ? 0.45 : 0.4));
    g.addColorStop(1, this.hsl(this.hue + 30, 100, 55, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    this.sprite = { cv, L, hue: this.hue };
    return cv;
  }

  /** Warm lights drifting up from the dark, each pulsing on its own beat. */
  fireflies(ctx, w, h, L, dt) {
    const { t, hue, energy } = this;
    this.base(ctx, w, h, L);
    const fog = ctx.createLinearGradient(0, h * 0.62, 0, h);
    fog.addColorStop(0, this.hsl(hue + 40, 50, L ? 88 : 22, 0));
    fog.addColorStop(1, this.hsl(hue + 40, 60, L ? 82 : 12, L ? 0.4 : 0.6));
    ctx.fillStyle = fog;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);
    const sprite = this.glowSprite(L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < this.fly.length; i++) {
      const f = this.fly[i];
      f.y -= f.rise * dt * (1 + energy * 2);
      if (f.y < 0.08) { this.fly[i] = this.makeFly(false); continue; }
      const x = (f.x + Math.sin(t * f.sp + f.ph) * f.wx * 5 + Math.sin(t * f.sp * 0.4 + f.ph * 2) * f.wx * 3) * w;
      const y = (f.y + Math.sin(t * f.sp * 0.7 + f.ph) * 0.012) * h;
      const beat = 0.5 + 0.5 * Math.sin(t * f.pulse * 2 + f.ph);
      const a = clamp((L ? 0.55 : 1) * (0.12 + 0.88 * beat * beat) * (1 + energy * 0.5), 0, 1);
      const size = f.r * (5 + energy * 2) * (0.7 + 0.5 * beat);
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, x - size, y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Lines of colour that flow across the screen like a ribbon of light. */
  ribbons(ctx, w, h, L) {
    const { t, hue, energy } = this;
    this.base(ctx, w, h, L);
    const band = ctx.createLinearGradient(0, h * 0.22, 0, h * 0.88);
    band.addColorStop(0, this.hsl(hue, 90, 60, 0));
    band.addColorStop(0.5, this.hsl(hue + 20, 90, L ? 72 : 55, L ? 0.25 : 0.16 + energy * 0.1));
    band.addColorStop(1, this.hsl(hue + 40, 90, 60, 0));
    ctx.fillStyle = band;
    ctx.fillRect(0, h * 0.22, w, h * 0.66);
    const N = 15;
    const step = 8;
    ctx.lineWidth = 1.3;
    ctx.lineJoin = 'round';
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      const shape = Math.sin(f * Math.PI); // the middle lines swing widest
      const baseY = h * (0.26 + 0.5 * f);
      const amp = h * (0.04 + 0.075 * shape) * (1 + energy * 1.4);
      const k = ((1.3 + f * 0.9) * TAU) / w;
      const sp = 0.25 + f * 0.12;
      ctx.beginPath();
      for (let x = 0; x <= w + step; x += step) {
        const y = baseY + Math.sin(x * k + t * sp + i * 0.45) * amp + Math.sin(x * k * 2.1 - t * sp * 0.8 + i) * amp * 0.35;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.hsl(hue + f * 80 - 20, 90, L ? 36 : 72, (L ? 0.55 : 0.55) * (0.4 + 0.6 * shape));
      ctx.stroke();
    }
  }

  /** The buildings, made once: three layers, far to near, each a run of towers with a grid of windows. */
  buildCity(w, h) {
    let seed = 20240611;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; // always the same city
    const specs = [
      { speed: 1.4, hMin: 0.12, hMax: 0.3, wMin: 0.035, wMax: 0.08, win: false },
      { speed: 3.2, hMin: 0.16, hMax: 0.4, wMin: 0.04, wMax: 0.09, win: true },
      { speed: 6, hMin: 0.2, hMax: 0.52, wMin: 0.045, wMax: 0.11, win: true },
    ];
    return specs.map((s) => {
      const towers = [];
      let x = 0;
      while (x < w * 1.15) {
        const bw = (s.wMin + rnd() * (s.wMax - s.wMin)) * w;
        const bh = (s.hMin + rnd() * (s.hMax - s.hMin)) * h;
        const cols = Math.max(1, Math.floor(bw / (w * 0.014)));
        const rows = Math.max(1, Math.floor(bh / (h * 0.032)));
        const windows = [];
        if (s.win) for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) windows.push({ r, c, s: rnd(), f: 0.2 + rnd() * 0.8 });
        towers.push({ x, w: bw, h: bh, cols, rows, windows });
        x += bw + rnd() * w * 0.012;
      }
      return { ...s, towers, total: x };
    });
  }

  /** A city at dusk (or in daylight): the skyline in layers drifting past, with windows that come on and go off. */
  skyline(ctx, w, h, L) {
    const { t, hue, energy } = this;
    if (!this.city) this.city = this.buildCity(w, h);
    const horizon = h * 0.86;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    const b = this.cfg.brightness / 100;
    sky.addColorStop(0, L ? this.hsl(hue + 240, 55, 82, 1) : this.hsl(hue + 240, 60, clamp(8 + b * 14, 4, 24), 1));
    sky.addColorStop(0.7, L ? this.hsl(hue + 20, 80, 86, 1) : this.hsl(hue - 20, 80, clamp(16 + b * 32, 8, 46), 1));
    sky.addColorStop(1, L ? this.hsl(hue + 10, 90, 90, 1) : this.hsl(hue - 8, 90, clamp(26 + b * 34, 12, 62), 1));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // the moon (or sun) with its glow
    const mx = w * 0.72;
    const my = h * 0.3;
    const glow = ctx.createRadialGradient(mx, my, 0, mx, my, h * 0.5);
    glow.addColorStop(0, this.hsl(hue + 30, 80, L ? 96 : 80, L ? 0.8 : 0.35 + energy * 0.15));
    glow.addColorStop(1, this.hsl(hue + 30, 80, 70, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(mx - h * 0.5, my - h * 0.5, h, h);
    ctx.beginPath();
    ctx.arc(mx, my, h * 0.045, 0, TAU);
    ctx.fillStyle = this.hsl(hue + 30, 70, L ? 99 : 92, L ? 0.95 : 0.9);
    ctx.fill();

    this.city.forEach((layer, li) => {
      const shade = li / (this.city.length - 1); // 0 far, 1 near
      const off = (t * layer.speed) % layer.total;
      ctx.fillStyle = L ? this.hsl(hue + 235, 25, 62 - shade * 24, 1) : this.hsl(hue + 238, 38, 22 - shade * 15, 1);
      const lit = [[], []];
      for (const tw of layer.towers) {
        for (const shift of [-off, layer.total - off]) {
          const x = tw.x + shift;
          if (x > w || x + tw.w < 0) continue;
          const top = horizon - tw.h;
          ctx.fillRect(x, top, tw.w, h - top);
          if (!layer.win || L) continue;
          const cw = tw.w / tw.cols;
          const rh = tw.h / tw.rows;
          for (const win of tw.windows) {
            const on = (win.s + t * win.f * 0.03) % 1;
            if (on > 0.5) continue;
            lit[on < 0.18 ? 0 : 1].push(x + win.c * cw + cw * 0.22, top + (win.r + 0.5) * rh, cw * 0.56, rh * 0.42);
          }
        }
      }
      // all the lit windows of a layer in two batches (bright, dim): a few draws instead of hundreds
      [[lit[0], 0.95 + energy * 0.05, 86], [lit[1], 0.5, 68]].forEach(([rects, alpha, l]) => {
        if (!rects.length) return;
        ctx.fillStyle = this.hsl(hue + 45, 95, l, alpha);
        ctx.beginPath();
        for (let i = 0; i < rects.length; i += 4) ctx.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
        ctx.fill();
      });
    });
    // haze at street level
    const haze = ctx.createLinearGradient(0, h * 0.8, 0, h);
    haze.addColorStop(0, this.hsl(hue, 60, L ? 85 : 20, 0));
    haze.addColorStop(1, this.hsl(hue, 60, L ? 80 : 10, L ? 0.5 : 0.7));
    ctx.fillStyle = haze;
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
  }

  /** A slowly shifting field of colour, worked out on a small picture and stretched to fill the screen. */
  plasma(ctx, w, h, L) {
    const pw = 88;
    const ph = Math.max(24, Math.round((pw * h) / w));
    if (!this.plasmaBuf || this.plasmaBuf.pw !== pw || this.plasmaBuf.ph !== ph) {
      const cv = this.makeCanvas(pw, ph);
      const c = cv.getContext('2d');
      this.plasmaBuf = { cv, c, img: c.createImageData(pw, ph), pw, ph, key: '', lut: new Uint8ClampedArray(256 * 3) };
    }
    const buf = this.plasmaBuf;
    // colours: 256 steps from deep to bright, rebuilt only when the hue, strength or brightness has really changed
    const b = this.cfg.brightness / 100;
    const key = `${Math.round(this.hue / 3)}|${Math.round(this.sat * 20)}|${Math.round(b * 20)}|${L}`;
    if (buf.key !== key) {
      buf.key = key;
      const s = clamp(this.sat * 100 + 15, 45, 95);
      for (let i = 0; i < 256; i++) {
        const f = i / 255;
        const l = L ? 58 + 30 * f : 7 + (24 + 40 * b) * Math.pow(f, 1.15);
        const [r, g, bl] = hslToRgb(this.hue + f * 140 - 40, s, l);
        buf.lut[i * 3] = r;
        buf.lut[i * 3 + 1] = g;
        buf.lut[i * 3 + 2] = bl;
      }
    }
    const t = this.t * 0.35;
    const sx = new Float32Array(pw);
    const sx2 = new Float32Array(pw);
    for (let x = 0; x < pw; x++) { sx[x] = Math.sin(x * 0.16 + t); sx2[x] = Math.sin(x * 0.045 - t * 0.7); }
    const data = buf.img.data;
    const lut = buf.lut;
    for (let y = 0; y < ph; y++) {
      const sy = Math.sin(y * 0.2 + t * 1.3);
      const sy2 = Math.sin(y * 0.07 + t * 0.5);
      const dy = y - ph / 2;
      for (let x = 0; x < pw; x++) {
        const dx = x - pw / 2;
        const v = sx[x] + sy + sx2[x] * sy2 * 1.4 + Math.sin((x + y) * 0.09 + t * 0.9) + Math.sin(Math.sqrt(dx * dx + dy * dy) * 0.18 - t);
        const i = clamp(Math.round(((v + 5.4) / 10.8) * 255), 0, 255) * 3;
        const o = (y * pw + x) * 4;
        data[o] = lut[i];
        data[o + 1] = lut[i + 1];
        data[o + 2] = lut[i + 2];
        data[o + 3] = 255;
      }
    }
    buf.c.putImageData(buf.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf.cv, 0, 0, w, h);
    // keep the lower part calmer so the text there stays easy to read
    const calm = ctx.createLinearGradient(0, h * 0.5, 0, h);
    calm.addColorStop(0, this.hsl(this.hue, 50, L ? 92 : 6, 0));
    calm.addColorStop(1, this.hsl(this.hue, 50, L ? 92 : 6, L ? 0.35 : 0.5));
    ctx.fillStyle = calm;
    ctx.fillRect(0, h * 0.5, w, h * 0.5);
  }

  bubblesOnly(ctx, w, h, L, dt) {
    this.base(ctx, w, h, L);
    this.keyLight(ctx, w, h, L);
    this.bubbleLayer(ctx, w, h, L, dt);
  }

  stars_(ctx, w, h, L, dt) {
    const { t, hue, energy } = this;
    this.base(ctx, w, h, L);
    ctx.globalCompositeOperation = L ? 'source-over' : 'lighter';
    for (let i = 0; i < 2; i++) {
      const g = ctx.createRadialGradient(w * (0.3 + i * 0.4), h * (0.35 + i * 0.15), 0, w * (0.3 + i * 0.4), h * (0.35 + i * 0.15), h * 0.75);
      g.addColorStop(0, this.hsl(hue + i * 50, 80, L ? 70 : 45, L ? 0.25 : 0.16));
      g.addColorStop(1, this.hsl(hue + i * 50, 80, L ? 70 : 45, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this.stars) {
      const x = (((s.x - t * 5 * s.z) % w) + w) % w;
      const tw = 0.5 + 0.5 * Math.sin(t * s.sp + s.tw);
      const a = (0.3 + 0.7 * tw) * (L ? 0.5 : 1) * (1 + energy * 0.5);
      ctx.beginPath();
      ctx.arc(x, s.y, s.r * (1 + energy * 0.4), 0, TAU);
      ctx.fillStyle = L ? this.hsl(hue, 60, 35, Math.min(1, a * 0.5)) : this.hsl(hue + s.z * 40, 40, 92, Math.min(1, a));
      ctx.fill();
    }
    // An occasional shooting star.
    this.nextShoot -= dt;
    if (!L && this.nextShoot <= 0 && this.cfg.motion > 0) {
      this.shoot = { x: Math.random() * w * 0.8, y: Math.random() * h * 0.4, life: 1 };
      this.nextShoot = 5 + Math.random() * 7;
    }
    if (this.shoot) {
      const s = this.shoot;
      s.life -= dt * 1.6;
      s.x += dt * w * 0.7;
      s.y += dt * h * 0.3;
      if (s.life <= 0) this.shoot = null;
      else {
        const g = ctx.createLinearGradient(s.x, s.y, s.x - w * 0.12, s.y - h * 0.05);
        g.addColorStop(0, `rgba(255,255,255,${s.life})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - w * 0.12, s.y - h * 0.05);
        ctx.stroke();
      }
    }
  }

  grid(ctx, w, h, L) {
    const { t, hue, energy } = this;
    const b = this.cfg.brightness / 100;
    const horizon = h * 0.58;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, L ? this.hsl(hue + 250, 60, 84, 1) : this.hsl(hue + 250, 70, clamp(14 * b * 2, 2, 24), 1));
    sky.addColorStop(1, L ? this.hsl(hue + 330, 90, 88, 1) : this.hsl(hue - 30, 90, clamp(34 * b * 2, 6, 52), 1));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);
    // sun, cut by stripes that widen toward the bottom
    const R = h * 0.2 * (1 + energy * 0.1);
    const cx = w / 2;
    const cy = horizon - R * 0.55;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();
    const sun = ctx.createLinearGradient(0, cy - R, 0, cy + R);
    sun.addColorStop(0, this.hsl(hue + 50, 100, 68, 1));
    sun.addColorStop(1, this.hsl(hue - 10, 100, 58, 1));
    ctx.fillStyle = sun;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.fillStyle = L ? this.hsl(hue + 330, 90, 88, 1) : this.hsl(hue - 30, 90, clamp(34 * b * 2, 6, 52), 1);
    for (let k = 0; k < 7; k++) ctx.fillRect(cx - R, cy + R * (0.05 + k * 0.14), R * 2, R * (0.02 + k * 0.022));
    ctx.restore();
    // floor
    const floor = ctx.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, L ? this.hsl(hue + 300, 50, 86, 1) : this.hsl(hue + 270, 70, clamp(10 * b * 2, 1, 16), 1));
    floor.addColorStop(1, L ? this.hsl(hue + 300, 50, 78, 1) : this.hsl(hue + 270, 70, clamp(5 * b * 2, 1, 9), 1));
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, w, h - horizon);
    // grid lines running to a vanishing point, scrolling toward the viewer
    const line = L ? this.hsl(hue, 80, 38, 0.6) : this.hsl(hue + 10, 100, 66, 0.8);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = -14; i <= 14; i++) {
      ctx.moveTo(cx + i * w * 0.012, horizon);
      ctx.lineTo(cx + i * w * 0.17, h);
    }
    ctx.stroke();
    const rows = 12;
    for (let k = 0; k < rows; k++) {
      const p = (k + ((t * 0.35) % 1)) / rows;
      const y = horizon + (h - horizon) * p * p;
      ctx.globalAlpha = clamp(p * 1.4, 0, 1);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // glow on the horizon
    const glow = ctx.createLinearGradient(0, horizon - h * 0.04, 0, horizon + h * 0.05);
    glow.addColorStop(0, this.hsl(hue + 20, 100, 70, 0));
    glow.addColorStop(0.5, this.hsl(hue + 20, 100, 70, (L ? 0.25 : 0.35) + energy * 0.2));
    glow.addColorStop(1, this.hsl(hue + 20, 100, 70, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, horizon - h * 0.04, w, h * 0.09);
  }
}

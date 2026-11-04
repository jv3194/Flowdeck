// Animated backdrop with several styles (see BACKGROUNDS in themes.js), in dark or light.
// Rendered at half resolution (it is all soft gradients), tinted by a hue that eases toward the focused cover,
// and pushed around by the music's energy. With motion at 0 it draws only when something changes.
import { clamp, hueDelta, lerp } from './util.js';

const SCALE = 0.5;
const TAU = Math.PI * 2;
// Particle styles: one drop/ember/flake per `per` pixels of the (half-size) canvas, within min..max.
const PARTICLES = {
  rain: { per: 1800, min: 70, max: 260 },
  embers: { per: 1900, min: 60, max: 230 },
  snow: { per: 1500, min: 90, max: 320 },
};

export class Background {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cfg = { style: 'waves', mode: 'dark', brightness: 50, motion: 60 };
    this.hue = 322;
    this.targetHue = 322;
    this.sat = 0.62;
    this.targetSat = 0.62;
    this.energy = 0;
    this.targetEnergy = 0;
    this.t = 0;
    this.last = 0;
    this.dirty = true;
    this.bubbles = [];
    this.stars = [];
    this.parts = []; // rain drops, embers or snowflakes, whichever style is showing
    this.partKind = '';
    this.ripples = [];
    this.shoot = null;
    this.nextShoot = 4;
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

  setTint(hue, sat = 0.62) {
    this.targetHue = hue;
    this.targetSat = sat;
  }

  setEnergy(e) {
    this.targetEnergy = e;
  }

  resize() {
    this.w = this.cv.width = Math.max(2, Math.round(innerWidth * SCALE));
    this.h = this.cv.height = Math.max(2, Math.round(innerHeight * SCALE));
    this.dirty = true;
    this.stars = [];
    this.parts = [];
    this.seed();
  }

  seed() {
    const wantBubbles = this.cfg.style === 'bubbles' ? 46 : this.cfg.style === 'waves' ? 26 : 0;
    if (this.bubbles.length !== wantBubbles) this.bubbles = Array.from({ length: wantBubbles }, (_, i) => this.makeBubble(i, true));
    const kind = PARTICLES[this.cfg.style];
    if (kind) {
      const n = clamp(Math.round((this.w * this.h) / kind.per), kind.min, kind.max);
      if (this.partKind !== this.cfg.style || this.parts.length !== n) {
        this.partKind = this.cfg.style;
        this.parts = Array.from({ length: n }, () => this.makeParticle(this.cfg.style, true));
        this.ripples = [];
      }
    } else {
      this.parts = [];
      this.partKind = '';
    }
    if (this.cfg.style === 'stars' && !this.stars.length) {
      const n = clamp(Math.round((this.w * this.h) / 2200), 70, 280);
      this.stars = Array.from({ length: n }, () => ({ x: Math.random() * this.w, y: Math.random() * this.h * 0.9, r: 0.4 + Math.random() ** 3 * 1.7, z: 0.2 + Math.random() * 0.8, tw: Math.random() * TAU, sp: 0.5 + Math.random() * 2 }));
    }
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
    if (this.cfg.motion > 0 || this.dirty || !settled) {
      this.draw(dt * speed);
      this.dirty = false;
    }
    requestAnimationFrame((n) => this.frame(n));
  }

  hsl(h, s, l, a = 1) {
    return `hsla(${((h % 360) + 360) % 360},${Math.round(s)}%,${Math.round(l)}%,${a})`;
  }

  draw(dt) {
    const { ctx, w, h } = this;
    const L = this.cfg.mode === 'light';
    const draw = { waves: this.waves, aurora: this.aurora, grid: this.grid, stars: this.stars_, bubbles: this.bubblesOnly, gradient: this.softGradient, solid: this.solid, rain: this.rain, embers: this.embers, snow: this.snow }[this.cfg.style] || this.waves;
    ctx.globalCompositeOperation = 'source-over';
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

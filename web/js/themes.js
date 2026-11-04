// Themes: a small, validated set of look-and-feel settings. A theme is data, never CSS, so a theme file
// someone shares can only ever set these values within these limits.
import { LAYOUTS } from './layouts.js';

export const BACKGROUNDS = [
  ['waves', 'Waves'], ['aurora', 'Aurora'], ['grid', 'Retro grid'], ['stars', 'Starfield'],
  ['bubbles', 'Bubbles'], ['rain', 'Rain'], ['embers', 'Embers'], ['snow', 'Snowfall'],
  ['gradient', 'Soft gradient'], ['solid', 'Solid colour'],
];

export const FONTS = {
  soft: { label: 'Soft', stack: '"Segoe UI Variable Display", "Segoe UI", "SF Pro Display", -apple-system, "Helvetica Neue", system-ui, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif' },
  tech: { label: 'Tech', stack: 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif' },
  mono: { label: 'Mono', stack: '"Cascadia Code", "SF Mono", Consolas, "Courier New", monospace' },
};

export const LIMITS = { brightness: [0, 100], glass: [0, 100], corners: [0, 30], motion: [0, 100], tilt: [30, 75], hue: [0, 359], sat: [0, 100] };

/** What a theme looks like when nothing is said. */
export const BASE = Object.freeze({
  mode: 'dark', background: 'waves', accent: { mode: 'cover', hue: 320, sat: 65 },
  brightness: 50, glass: 50, corners: 14, reflection: true, motion: 60, flow: 'slab', tilt: 58, font: 'soft',
});

const make = (id, name, over) => Object.freeze({ id, name, builtin: true, ...BASE, ...over, accent: { ...BASE.accent, ...(over.accent || {}) } });

export const PRESETS = [
  make('wave', 'Wave', {}),
  make('aurora', 'Aurora', { background: 'aurora', brightness: 45, glass: 40, corners: 20, motion: 55, tilt: 52 }),
  make('neon', 'Neon Grid', { background: 'grid', accent: { mode: 'fixed', hue: 305, sat: 90 }, brightness: 55, glass: 30, corners: 6, motion: 70, tilt: 62, font: 'tech' }),
  make('midnight', 'Midnight', { background: 'stars', brightness: 35, glass: 35, corners: 12, motion: 40, flow: 'carousel', tilt: 45 }),
  make('bubbles', 'Bubbles', { background: 'bubbles', brightness: 55, glass: 55, corners: 24, motion: 70, flow: 'stack' }),
  make('sunset', 'Sunset', { accent: { mode: 'fixed', hue: 18, sat: 85 }, brightness: 55, glass: 45, corners: 16, flow: 'fan' }),
  make('oled', 'OLED', { background: 'solid', brightness: 0, glass: 20, corners: 10, reflection: false, motion: 0, flow: 'flat' }),

  // More dark ones, each with its own backdrop, colour, layout and typeface.
  make('terminal', 'Terminal', { background: 'rain', accent: { mode: 'fixed', hue: 135, sat: 85 }, brightness: 22, glass: 20, corners: 2, reflection: false, motion: 80, flow: 'flat', tilt: 50, font: 'mono' }),
  make('neonrain', 'Neon Rain', { background: 'rain', accent: { mode: 'fixed', hue: 195, sat: 90 }, brightness: 40, glass: 35, corners: 8, motion: 65, flow: 'carousel', tilt: 50, font: 'tech' }),
  make('ember', 'Ember', { background: 'embers', accent: { mode: 'fixed', hue: 18, sat: 90 }, brightness: 45, glass: 40, corners: 18, motion: 60, flow: 'stack', tilt: 58 }),
  make('frost', 'Frost', { background: 'snow', accent: { mode: 'fixed', hue: 205, sat: 55 }, brightness: 50, glass: 55, corners: 24, motion: 50, flow: 'slab', tilt: 48 }),
  make('deepsea', 'Deep Sea', { accent: { mode: 'fixed', hue: 188, sat: 80 }, brightness: 28, glass: 45, corners: 20, motion: 40, flow: 'carousel', tilt: 40 }),
  make('outrun', 'Outrun', { background: 'grid', accent: { mode: 'fixed', hue: 12, sat: 95 }, brightness: 60, glass: 30, corners: 10, motion: 80, flow: 'fan', tilt: 62, font: 'tech' }),
  make('obsidian', 'Obsidian', { background: 'solid', accent: { mode: 'fixed', hue: 42, sat: 85 }, brightness: 10, glass: 18, corners: 6, reflection: false, motion: 0, flow: 'carousel', tilt: 45, font: 'serif' }),
  make('northern', 'Northern Lights', { background: 'aurora', accent: { mode: 'fixed', hue: 150, sat: 80 }, brightness: 38, glass: 45, corners: 22, motion: 50, flow: 'slab', tilt: 55 }),
  make('amethyst', 'Amethyst', { background: 'gradient', accent: { mode: 'fixed', hue: 272, sat: 70 }, brightness: 30, glass: 55, corners: 16, motion: 45, flow: 'stack', tilt: 55 }),
  make('bloodmoon', 'Blood Moon', { background: 'stars', accent: { mode: 'fixed', hue: 355, sat: 85 }, brightness: 25, glass: 30, corners: 12, motion: 35, flow: 'fan', tilt: 50, font: 'serif' }),

  // Light ones.
  make('daylight', 'Daylight', { mode: 'light', background: 'gradient', brightness: 60, glass: 60, corners: 16, motion: 40, tilt: 55 }),
  make('paper', 'Paper', { mode: 'light', background: 'solid', accent: { mode: 'fixed', hue: 24, sat: 55 }, brightness: 55, glass: 70, corners: 4, reflection: false, motion: 0, flow: 'flat', tilt: 50, font: 'serif' }),
];

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

/** Clean a theme from anywhere (a file, saved preferences): known keys only, values clamped, nothing else survives. */
export function normalizeTheme(raw, { name } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That is not a theme');
  const a = raw.accent && typeof raw.accent === 'object' ? raw.accent : {};
  return {
    name: String(raw.name ?? name ?? 'Custom').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Custom',
    mode: oneOf(raw.mode, ['dark', 'light'], BASE.mode),
    background: oneOf(raw.background, BACKGROUNDS.map(([k]) => k), BASE.background),
    accent: { mode: oneOf(a.mode, ['cover', 'fixed'], BASE.accent.mode), hue: clamp(a.hue, LIMITS.hue, BASE.accent.hue), sat: clamp(a.sat, LIMITS.sat, BASE.accent.sat) },
    brightness: clamp(raw.brightness, LIMITS.brightness, BASE.brightness),
    glass: clamp(raw.glass, LIMITS.glass, BASE.glass),
    corners: clamp(raw.corners, LIMITS.corners, BASE.corners),
    reflection: typeof raw.reflection === 'boolean' ? raw.reflection : BASE.reflection,
    motion: clamp(raw.motion, LIMITS.motion, BASE.motion),
    flow: oneOf(raw.flow, LAYOUTS.map(([k]) => k), BASE.flow),
    tilt: clamp(raw.tilt, LIMITS.tilt, BASE.tilt),
    font: oneOf(raw.font, Object.keys(FONTS), BASE.font),
  };
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'theme';

/** The theme as a shareable file's text. */
export function exportJson(theme) {
  const { name, mode, background, accent, brightness, glass, corners, reflection, motion, flow, tilt, font } = theme;
  return JSON.stringify({ flowdeckTheme: 1, name, mode, background, accent, brightness, glass, corners, reflection, motion, flow, tilt, font }, null, 2);
}

/** Parse a theme file's text. Throws a readable error for anything that is not a Flowdeck theme. */
export function importJson(text) {
  if (typeof text !== 'string' || text.length > 20000) throw new Error('That file is too large to be a theme');
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('That file is not valid JSON');
  }
  if (!raw || raw.flowdeckTheme !== 1) throw new Error('That is not a Flowdeck theme file');
  return normalizeTheme(raw);
}

const isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A base theme with the user's tweaks on top. */
export function merge(base, tweaks = {}) {
  const t = normalizeTheme({ ...base, ...tweaks, accent: { ...base.accent, ...(tweaks.accent || {}) } });
  return { ...t, id: base.id, name: base.name, builtin: !!base.builtin };
}

export class ThemeManager {
  constructor(app) {
    this.app = app;
    this.previewing = null;
  }

  get prefs() { return this.app.prefs; }

  get custom() {
    return Object.entries(this.prefs.themes || {}).flatMap(([id, t]) => {
      try {
        return [{ ...normalizeTheme(t), id, builtin: false }];
      } catch {
        return []; // a hand-edited entry that no longer makes sense is simply not listed
      }
    });
  }

  get all() { return [...PRESETS, ...this.custom]; }
  find(id) { return this.all.find((t) => t.id === id); }
  get activeId() { return this.find(this.prefs.theme?.id) ? this.prefs.theme.id : 'wave'; }
  get base() { return this.find(this.activeId); }
  get tweaks() { return this.prefs.theme?.tweaks || {}; }
  /** True while something differs from the base theme (an emptied `accent: {}` left behind by un-tweaking doesn't count). */
  get dirty() { return Object.values(this.tweaks).some((v) => !(v && typeof v === 'object') || Object.keys(v).length > 0); }
  /** What is on screen right now: a preview if one is open, else the active theme with its tweaks. */
  get effective() { return this.previewing || merge(this.base, this.tweaks); }

  apply() {
    applyTheme(this.app, this.effective);
  }

  /** Put the current look on screen and tell anything listing themes (open sheets) to redraw. */
  changed() {
    this.apply();
    this.app.emit?.('themes');
  }

  /** Show a theme without keeping it (null goes back to the real one). */
  preview(theme) {
    this.previewing = theme ? merge(theme, {}) : null;
    this.apply();
  }

  /** Switch to a theme, dropping any tweaks made to the previous one. */
  select(id) {
    this.previewing = null;
    this.app.patchPrefs({ theme: { id, tweaks: null } });
    this.changed();
  }

  /**
   * Change some settings of the active theme. A setting that goes back to the base theme's own value is simply
   * un-tweaked, so "modified" means what it says.
   */
  tweak(patch) {
    const base = this.base;
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'accent') {
        out.accent = {};
        for (const [ak, av] of Object.entries(v)) out.accent[ak] = isEqual(av, base.accent[ak]) ? null : av;
      } else {
        out[k] = isEqual(v, base[k]) ? null : v;
      }
    }
    this.previewing = null;
    this.app.patchPrefs({ theme: { id: this.activeId, tweaks: out } });
    this.changed();
  }

  resetTweaks() {
    this.app.patchPrefs({ theme: { id: this.activeId, tweaks: null } });
    this.changed();
  }

  /** Add `t` (already normalised) as a theme of your own and switch to it. */
  create(t) {
    if (this.custom.length >= 30) throw new Error('That is plenty of themes: delete one first');
    const taken = new Set(this.all.map((x) => x.id));
    let id;
    do id = `${slug(t.name)}-${Math.random().toString(36).slice(2, 6)}`; while (taken.has(id));
    this.previewing = null;
    this.app.patchPrefs({ themes: { [id]: t }, theme: { id, tweaks: null } });
    this.changed();
    return id;
  }

  /** Keep the current look as a new theme of your own, and switch to it. */
  saveAs(name) {
    const t = normalizeTheme(this.effective, { name });
    t.name = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || t.name;
    return this.create(t);
  }

  /** Write the current tweaks into the active custom theme. */
  updateCustom() {
    const id = this.activeId;
    if (this.base.builtin) throw new Error('Built-in themes cannot be changed: use Save as a new theme');
    const { name, mode, background, accent, brightness, glass, corners, reflection, motion, flow, tilt, font } = this.effective;
    this.app.patchPrefs({ themes: { [id]: { name, mode, background, accent, brightness, glass, corners, reflection, motion, flow, tilt, font } }, theme: { id, tweaks: null } });
    this.changed();
  }

  rename(id, name) {
    if (!this.find(id) || this.find(id).builtin) return;
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (!clean) throw new Error('Give it a name');
    this.app.patchPrefs({ themes: { [id]: { name: clean } } });
    this.changed();
  }

  remove(id) {
    if (this.find(id)?.builtin) return;
    const wasActive = this.activeId === id;
    this.app.patchPrefs({ themes: { [id]: null }, ...(wasActive ? { theme: { id: 'wave', tweaks: null } } : {}) });
    this.changed();
  }

  /** Add a theme from a file's text, switch to it, and return its id. */
  addFromJson(text) {
    return this.create(importJson(text));
  }

  /** Offer a theme as a file to keep or share. */
  download(theme) {
    const blob = new Blob([exportJson(theme)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flowdeck-theme-${slug(theme.name)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

/** A small picture of a theme for lists: its background style, in its colours. Built only from validated numbers. */
export function swatch(theme) {
  const light = theme.mode === 'light';
  const hue = theme.accent.mode === 'fixed' ? theme.accent.hue : 322;
  const b = theme.brightness / 100;
  const sky = light ? `hsl(${hue} 70% ${84 + b * 8}%)` : `hsl(${hue} 60% ${8 + b * 26}%)`;
  const deep = light ? `hsl(${hue + 30} 70% ${70 + b * 10}%)` : `hsl(${hue + 20} 70% ${4 + b * 10}%)`;
  const glow = `hsl(${hue + 20} 95% 60%)`;
  const base = `linear-gradient(180deg, ${sky}, ${deep})`;
  const ink = light ? 'hsl(230 40% 25%)' : '#fff';
  switch (theme.background) {
    case 'aurora':
      return `radial-gradient(60% 80% at 25% 35%, hsl(${hue} 90% 55% / 0.85), transparent), radial-gradient(60% 80% at 78% 70%, hsl(${hue + 80} 90% 52% / 0.85), transparent), ${base}`;
    case 'grid':
      return `repeating-linear-gradient(90deg, ${glow} 0 1px, transparent 1px 6px) bottom / 100% 42% no-repeat, radial-gradient(circle at 50% 58%, hsl(${hue + 50} 100% 66%) 0 20%, transparent 22%), linear-gradient(180deg, hsl(${hue + 250} 70% ${light ? 84 : 14}%), hsl(${hue - 30} 90% ${light ? 86 : 32}%) 62%)`;
    case 'stars':
      return `radial-gradient(circle, ${ink} 0 0.7px, transparent 1.2px) 0 0 / 9px 8px, radial-gradient(circle, ${ink} 0 0.5px, transparent 1px) 4px 5px / 11px 10px, ${base}`;
    case 'bubbles': {
      const ring = light ? 'hsl(230 40% 30% / 0.6)' : 'rgb(255 255 255 / 0.75)';
      return `radial-gradient(circle at 26% 64%, transparent 0 4px, ${ring} 4px 5px, transparent 5px), radial-gradient(circle at 62% 38%, transparent 0 6px, ${ring} 6px 7px, transparent 7px), radial-gradient(circle at 84% 72%, transparent 0 3px, ${ring} 3px 4px, transparent 4px), ${base}`;
    }
    case 'rain': {
      const streak = light ? 'hsl(230 40% 25% / 0.45)' : 'rgb(255 255 255 / 0.4)';
      return `radial-gradient(90% 45% at 50% 118%, ${glow} 0 40%, transparent 70%), repeating-linear-gradient(100deg, transparent 0 5px, ${streak} 5px 5.8px), ${base}`;
    }
    case 'embers':
      return `radial-gradient(circle at 28% 38%, hsl(${hue + 22} 100% 75%) 0 1px, transparent 1.7px), radial-gradient(circle at 62% 24%, hsl(${hue + 10} 100% 70%) 0 1.2px, transparent 1.9px), radial-gradient(circle at 78% 52%, hsl(${hue} 100% 68%) 0 1px, transparent 1.7px), radial-gradient(90% 65% at 50% 125%, hsl(${hue - 8} 100% 52%) 0 35%, transparent 75%), ${base}`;
    case 'snow':
      return `radial-gradient(circle, ${ink} 0 1.3px, transparent 1.9px) 2px 1px / 12px 10px, radial-gradient(circle, ${ink} 0 0.9px, transparent 1.5px) 7px 6px / 15px 13px, linear-gradient(180deg, transparent 55%, hsl(${hue} 50% ${light ? 90 : 80}% / 0.35)), ${base}`;
    case 'gradient':
      return `radial-gradient(circle at 72% 28%, hsl(${hue + 45} 85% 62% / 0.75), transparent 62%), ${base}`;
    case 'solid': {
      const flat = light ? `hsl(${hue} 14% ${88 + b * 6}%)` : `hsl(${hue} 25% ${b * 16}%)`;
      return `linear-gradient(${flat}, ${flat})`;
    }
    default:
      return `radial-gradient(120% 60% at 28% 112%, ${glow} 0 52%, transparent 54%), radial-gradient(120% 50% at 82% 116%, hsl(${hue + 40} 85% 55%) 0 52%, transparent 54%), ${base}`;
  }
}

/** Put a theme on screen: CSS variables, the background, the cover layout. */
export function applyTheme(app, theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const s = root.style;
  root.dataset.mode = theme.mode;
  root.dataset.reflect = theme.reflection ? 'on' : 'off';
  s.colorScheme = theme.mode;
  s.setProperty('--radius', `${theme.corners}px`);
  s.setProperty('--font', FONTS[theme.font].stack);
  const g = theme.glass / 100;
  s.setProperty('--glass-a', (0.1 + g * 0.22).toFixed(3));
  s.setProperty('--glass-b', (0.03 + g * 0.08).toFixed(3));
  s.setProperty('--glass-solid-a', (0.4 + g * 0.45).toFixed(3));
  s.setProperty('--blur', `${Math.round(8 + g * 28)}px`);
  try {
    localStorage.setItem('flowdeck-mode', theme.mode); // lets the next launch paint the right colours before anything loads
  } catch {
    /* storage unavailable: only the first paint is affected */
  }
  app.bg?.configure({ style: theme.background, mode: theme.mode, brightness: theme.brightness, motion: theme.motion });
  app.retint?.();
  app.nav?.screens?.home?.flow?.setLayout(theme.flow, theme.tilt);
}

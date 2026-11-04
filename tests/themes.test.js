'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../web/js/themes.js');

/** Just enough of the app for the theme manager: preferences with the same patch semantics (null deletes). */
function fakeApp() {
  const prefs = {};
  const merge = (t, p) => {
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete t[k];
      else if (v && typeof v === 'object' && !Array.isArray(v)) merge((t[k] ??= {}), v);
      else t[k] = v;
    }
  };
  return { prefs, patchPrefs: (p) => merge(prefs, p) };
}

test('presets: unique ids, valid settings, and a real spread of looks', async () => {
  const { PRESETS, normalizeTheme, BACKGROUNDS } = await load();
  assert.ok(PRESETS.length >= 19);
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.equal(PRESETS[0].id, 'wave', 'the default comes first');
  for (const p of PRESETS) {
    const { name, ...rest } = normalizeTheme(p);
    assert.deepEqual({ name, ...rest }, { name: p.name, mode: p.mode, background: p.background, accent: p.accent, brightness: p.brightness, glass: p.glass, corners: p.corners, reflection: p.reflection, motion: p.motion, flow: p.flow, tilt: p.tilt, font: p.font }, `${p.id} is already valid`);
    assert.ok(p.builtin);
  }
  assert.ok(PRESETS.some((p) => p.mode === 'light') && PRESETS.some((p) => p.mode === 'dark'));
  assert.ok(new Set(PRESETS.map((p) => p.background)).size >= 5, 'several background styles are used');
  assert.ok(new Set(PRESETS.map((p) => p.flow)).size >= 4, 'several cover layouts are used');
  assert.equal(BACKGROUNDS.length, 10);
  assert.ok(PRESETS.filter((p) => p.mode === "dark").length >= 17, "plenty of dark themes");
  assert.ok(new Set(PRESETS.filter((p) => p.mode === "dark").map((p) => p.background)).size >= 8, "the dark themes use many different backdrops");
});

test('normalizeTheme clamps numbers, falls back on bad choices and drops anything unknown', async () => {
  const { normalizeTheme } = await load();
  const t = normalizeTheme({ name: '  <b>Mine</b>\u0000  ', mode: 'purple', background: 'url(javascript:alert(1))', brightness: 500, glass: -4, corners: '99', motion: 'fast', tilt: 10, flow: 'spiral', font: 'comic', reflection: 'yes', accent: { mode: 'fixed', hue: 720, sat: '42' }, css: 'body{display:none}', script: '<script>', __proto__: { polluted: 1 } });
  assert.equal(t.name, 'bMine/b', 'angle brackets and control characters are removed');
  assert.deepEqual([t.mode, t.background, t.flow, t.font], ['dark', 'waves', 'slab', 'soft']);
  assert.deepEqual([t.brightness, t.glass, t.corners, t.motion, t.tilt], [100, 0, 30, 60, 30]);
  assert.equal(t.reflection, true);
  assert.deepEqual(t.accent, { mode: 'fixed', hue: 359, sat: 42 });
  assert.deepEqual(Object.keys(t).sort(), ['accent', 'background', 'brightness', 'corners', 'flow', 'font', 'glass', 'mode', 'motion', 'name', 'reflection', 'tilt'], 'nothing but known settings survives');
  assert.equal(({}).polluted, undefined);
});

test('normalizeTheme: long names are cut, missing parts take defaults, non-objects are refused', async () => {
  const { normalizeTheme, BASE } = await load();
  assert.equal(normalizeTheme({ name: 'x'.repeat(100) }).name.length, 40);
  assert.equal(normalizeTheme({}).name, 'Custom');
  assert.equal(normalizeTheme({}, { name: 'From a file' }).name, 'From a file');
  assert.deepEqual(normalizeTheme({ accent: 'red' }).accent, BASE.accent);
  for (const bad of [null, undefined, 'str', 42, [1, 2]]) assert.throws(() => normalizeTheme(bad), /not a theme/);
});

test('the active theme plus tweaks; changing a setting back to the original un-tweaks it', async () => {
  const { ThemeManager } = await load();
  const app = fakeApp();
  const m = new ThemeManager(app);
  assert.equal(m.activeId, 'wave');
  assert.equal(m.dirty, false);

  m.select('aurora');
  assert.equal(m.effective.background, 'aurora');
  m.tweak({ corners: 30 });
  assert.equal(m.effective.corners, 30);
  assert.equal(m.dirty, true);
  assert.equal(m.base.corners, 20, 'the base theme itself is untouched');

  m.tweak({ corners: 20 }); // back to what Aurora has
  assert.equal(m.dirty, false);

  m.tweak({ accent: { mode: 'fixed', hue: 200 } });
  assert.deepEqual(m.effective.accent, { mode: 'fixed', hue: 200, sat: 65 });
  m.tweak({ accent: { mode: 'cover' } });
  assert.deepEqual(m.tweaks.accent, { hue: 200 }, 'only the part still different is kept');
  m.resetTweaks();
  assert.equal(m.dirty, false);

  m.tweak({ glass: 90 });
  m.select('paper');
  assert.equal(m.dirty, false, 'switching theme drops tweaks made to the old one');
  assert.equal(m.effective.font, 'serif');
});

test('a preview is shown but never saved', async () => {
  const { ThemeManager, PRESETS } = await load();
  const app = fakeApp();
  const m = new ThemeManager(app);
  m.preview(PRESETS.find((p) => p.id === 'neon'));
  assert.equal(m.effective.background, 'grid');
  assert.equal(app.prefs.theme, undefined, 'nothing was persisted');
  m.preview(null);
  assert.equal(m.effective.background, 'waves');
  m.select('daylight');
  m.preview(PRESETS.find((p) => p.id === 'oled'));
  m.tweak({ glass: 10 });
  assert.equal(m.previewing, null, 'changing something ends the preview');
  assert.equal(m.effective.mode, 'light', 'and applies to the real active theme');
});

test('save as a new theme, update it, delete it', async () => {
  const { ThemeManager } = await load();
  const app = fakeApp();
  const m = new ThemeManager(app);
  m.select('sunset');
  m.tweak({ corners: 2, font: 'mono' });
  const id = m.saveAs('  My  look ');
  assert.equal(m.activeId, id);
  assert.equal(m.base.name, 'My  look');
  assert.deepEqual([m.effective.corners, m.effective.font, m.effective.flow], [2, 'mono', 'fan'], 'it keeps what you saw');
  assert.equal(m.dirty, false);
  assert.equal(m.custom.length, 1);
  assert.equal(m.base.builtin, false);

  const again = m.saveAs('My look');
  assert.notEqual(again, id, 'the same name never reuses an id');
  assert.equal(m.custom.length, 2);

  m.select(id);
  m.tweak({ brightness: 80 });
  m.updateCustom();
  assert.equal(m.dirty, false);
  assert.equal(m.find(id).brightness, 80, 'update writes the tweaks into the theme itself');

  m.remove(id);
  assert.equal(m.find(id), undefined);
  assert.equal(m.activeId, 'wave', 'deleting the active theme falls back to the default');
  m.remove('aurora');
  assert.ok(m.find('aurora'), 'built-in themes cannot be deleted');
  m.select('aurora');
  assert.throws(() => m.updateCustom(), /Built-in/);
});

test('there is a limit on how many themes you can pile up', async () => {
  const { ThemeManager } = await load();
  const m = new ThemeManager(fakeApp());
  for (let i = 0; i < 30; i++) m.saveAs(`Theme ${i}`);
  assert.throws(() => m.saveAs('one too many'), /plenty/);
});

test('theme files: export and import round-trip, and bad files are refused with a clear reason', async () => {
  const { ThemeManager, PRESETS, exportJson, importJson, normalizeTheme } = await load();
  const neon = PRESETS.find((p) => p.id === 'neon');
  const text = exportJson(neon);
  assert.equal(JSON.parse(text).flowdeckTheme, 1);
  assert.equal('id' in JSON.parse(text) || 'builtin' in JSON.parse(text), false, 'ids stay out of the file');
  assert.deepEqual(importJson(text), normalizeTheme(neon));

  const m = new ThemeManager(fakeApp());
  const id = m.addFromJson(text);
  assert.equal(m.activeId, id);
  assert.deepEqual([m.effective.background, m.effective.font, m.effective.accent.hue], ['grid', 'tech', 305]);

  assert.throws(() => importJson('{"name":"no marker"}'), /not a Flowdeck theme/);
  assert.throws(() => importJson('not json at all'), /not valid JSON/);
  assert.throws(() => importJson('x'.repeat(30000)), /too large/);
  assert.throws(() => importJson('[1,2,3]'), /not a Flowdeck theme/);
  const hostile = importJson('{"flowdeckTheme":1,"name":"<img onerror=x>","background":"expression(alert(1))","corners":9999,"__proto__":{"polluted":true}}');
  assert.deepEqual([hostile.background, hostile.corners], ['waves', 30]);
  assert.equal(({}).polluted, undefined);
});

test('damaged custom themes in preferences are skipped, not fatal', async () => {
  const { ThemeManager } = await load();
  const app = fakeApp();
  app.prefs.themes = { broken: 'a string', alsoBroken: null, fine: { name: 'Fine', mode: 'light' } };
  app.prefs.theme = { id: 'broken' };
  const m = new ThemeManager(app);
  assert.deepEqual(m.custom.map((t) => t.id), ['fine']);
  assert.equal(m.activeId, 'wave', 'an active theme that cannot be found falls back to the default');
});

test('every preset gets its own swatch picture, built from gradients only', async () => {
  const { PRESETS, swatch } = await load();
  const all = PRESETS.map((p) => swatch(p));
  assert.equal(new Set(all).size, PRESETS.length, 'no two presets share a swatch');
  for (const s of all) {
    assert.match(s, /gradient\(/);
    assert.doesNotMatch(s, /[<>;{}]|url\(/, 'only gradient syntax, nothing that could carry other CSS');
  }
});

test('undoing every part of an accent tweak leaves the theme unmodified', async () => {
  const { ThemeManager } = await load();
  const m = new ThemeManager(fakeApp());
  m.tweak({ accent: { hue: 200 } });
  assert.equal(m.dirty, true);
  m.tweak({ accent: { hue: 320 } }); // the base value again; the emptied accent object stays behind in preferences
  assert.equal(m.dirty, false);
  assert.equal(m.effective.accent.hue, 320);
});

test('renaming works on your own themes only, and every change announces itself', async () => {
  const { ThemeManager } = await load();
  const app = fakeApp();
  let announced = 0;
  app.emit = (ev) => { if (ev === 'themes') announced++; };
  const m = new ThemeManager(app);

  m.rename('wave', 'Hacked');
  assert.equal(m.find('wave').name, 'Wave', 'built-in themes keep their names');

  const id = m.saveAs('Late night');
  const before = announced;
  m.rename(id, '  <b>Evening</b>  ');
  assert.equal(m.find(id).name, 'bEvening/b', 'markup characters are stripped');
  assert.throws(() => m.rename(id, '   '), /name/i);
  assert.equal(m.find(id).name, 'bEvening/b', 'a refused rename changes nothing');
  assert.ok(announced > before, 'sheets listing themes are told to redraw');

  m.tweak({ glass: 80 });
  m.select('wave');
  m.remove(id);
  assert.equal(m.find(id), undefined);
});

test('every backdrop style in the list has a drawing routine in bg.js', async () => {
  const { BACKGROUNDS } = await load();
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../web/js/bg.js'), 'utf8');
  const table = src.match(/const draw = \{([^}]*)\}\[/)[1];
  for (const [key] of BACKGROUNDS) assert.ok(table.includes(` ${key}: this.`), `${key} is drawn`);
});

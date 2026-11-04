// The theme picker and the Customize sheet. All the rules (limits, saving, importing) live in themes.js;
// this file only lays them out as lists you can move through with the keyboard, a gamepad or the mouse.
import { LAYOUTS } from './layouts.js';
import { BACKGROUNDS, FONTS, LIMITS, swatch } from './themes.js';
import { ListSheet, TextPrompt, toast } from './ui.js';
import { clamp, h } from './util.js';

const nameOf = (list, key) => (list.find(([k]) => k === key) || [])[1] ?? key;

/** Pick a theme. Moving over one previews it; Enter keeps it; Esc puts everything back. */
export function openThemes(app) {
  const tm = app.themes;
  const build = () => [
    { label: 'Customize this theme…', icon: 'gear', primary: true, keep: true, action: () => openCustomize(app) },
    { sep: true },
    ...tm.all.map((t) => ({
      label: t.name,
      swatch: swatch(t),
      theme: t,
      on: t.id === tm.activeId,
      sm: t.builtin ? '' : 'yours',
      value: t.id === tm.activeId ? (tm.dirty ? 'In use, edited' : 'In use') : '',
      action: () => tm.select(t.id),
    })),
    { sep: true },
    { label: 'Import a theme file…', icon: 'upload', keep: true, action: () => importThemeFile(app) },
  ];
  const sheet = new ListSheet(app, {
    title: 'Theme & style',
    note: 'Move over a theme to see it. Enter keeps it, Esc leaves things as they were.',
    wide: true,
    closeBelow: true,
    items: [],
    hints: [{ pad: 'cross', key: 'Enter', label: 'Use theme' }, { pad: 'D-pad', key: '↑ ↓', label: 'Preview' }, { pad: 'circle', key: 'Esc', label: 'Cancel' }],
    onSelect: (it) => tm.preview(it?.theme && it.theme.id !== tm.activeId ? it.theme : null),
    onClose: () => {
      off();
      tm.preview(null);
    },
  });
  const off = app.on('themes', () => sheet.setItems(build(), { keepSel: true }));
  sheet.setItems(build());
  sheet.sel = Math.max(0, sheet.items.findIndex((i) => i.on));
  sheet.paint();
  app.openLayer(sheet);
}

/** Every setting of the current theme, with changes applied as you go. */
export function openCustomize(app) {
  const tm = app.themes;
  const cur = () => tm.effective;
  const tweaked = (k, sub) => (sub ? tm.tweaks.accent?.[sub] : tm.tweaks[k]) !== undefined;

  /** A number you nudge with left/right, or set by clicking the gauge. */
  const gauge = (name, { get, set, lo, hi, step, fmt = String, dot, disabled, edited }) => {
    const nudge = (dir, wrap) => {
      let v = get() + dir * step;
      if (wrap) v = v > hi ? lo : v < lo ? hi : v;
      set(clamp(v, lo, hi));
    };
    return {
      label: name, meter: (get() - lo) / (hi - lo), value: fmt(get()), dot, disabled, sm: edited ? 'edited' : '', keep: true,
      adjust: (dir) => nudge(dir, false),
      action: () => nudge(1, true),
      setFrac: (f) => set(clamp(Math.round((lo + f * (hi - lo)) / step) * step, lo, hi)),
    };
  };

  /** One of a few named options, stepped with left/right or Enter. */
  const choice = (name, { get, set, options, fmt, edited }) => {
    const nudge = (dir) => set(options[(options.indexOf(get()) + dir + options.length) % options.length]);
    return { label: name, value: fmt(get()), sm: edited ? 'edited' : '', keep: true, adjust: nudge, action: () => nudge(1) };
  };

  const build = () => {
    const t = cur();
    const fixed = t.accent.mode === 'fixed';
    const mine = !tm.base.builtin;
    const range = (k) => ({ lo: LIMITS[k][0], hi: LIMITS[k][1] });
    return [
      choice('Light or dark', { get: () => cur().mode, set: (v) => tm.tweak({ mode: v }), options: ['dark', 'light'], fmt: (v) => (v === 'dark' ? 'Dark' : 'Light'), edited: tweaked('mode') }),
      choice('Background', { get: () => cur().background, set: (v) => tm.tweak({ background: v }), options: BACKGROUNDS.map(([k]) => k), fmt: (v) => nameOf(BACKGROUNDS, v), edited: tweaked('background') }),
      choice('Accent colour', { get: () => cur().accent.mode, set: (v) => tm.tweak({ accent: { mode: v } }), options: ['cover', 'fixed'], fmt: (v) => (v === 'cover' ? 'Follows the cover' : 'One colour'), edited: tweaked('accent', 'mode') }),
      gauge('Accent hue', { ...range('hue'), step: 10, get: () => cur().accent.hue, set: (v) => tm.tweak({ accent: { hue: v } }), fmt: (v) => `${v}°`, dot: `hsl(${t.accent.hue} 90% 60%)`, disabled: !fixed, edited: tweaked('accent', 'hue') }),
      gauge('Accent strength', { ...range('sat'), step: 5, get: () => cur().accent.sat, set: (v) => tm.tweak({ accent: { sat: v } }), fmt: (v) => `${v}%`, disabled: !fixed, edited: tweaked('accent', 'sat') }),
      gauge('Brightness', { ...range('brightness'), step: 5, get: () => cur().brightness, set: (v) => tm.tweak({ brightness: v }), fmt: (v) => `${v}%`, edited: tweaked('brightness') }),
      gauge('Glass', { ...range('glass'), step: 5, get: () => cur().glass, set: (v) => tm.tweak({ glass: v }), fmt: (v) => `${v}%`, edited: tweaked('glass') }),
      gauge('Corners', { ...range('corners'), step: 2, get: () => cur().corners, set: (v) => tm.tweak({ corners: v }), fmt: (v) => `${v} px`, edited: tweaked('corners') }),
      choice('Reflections', { get: () => cur().reflection, set: (v) => tm.tweak({ reflection: v }), options: [true, false], fmt: (v) => (v ? 'On' : 'Off'), edited: tweaked('reflection') }),
      gauge('Motion', { ...range('motion'), step: 10, get: () => cur().motion, set: (v) => tm.tweak({ motion: v }), fmt: (v) => (v === 0 ? 'Still' : `${v}%`), edited: tweaked('motion') }),
      choice('Cover layout', { get: () => cur().flow, set: (v) => tm.tweak({ flow: v }), options: LAYOUTS.map(([k]) => k), fmt: (v) => nameOf(LAYOUTS, v), edited: tweaked('flow') }),
      gauge('Cover angle', { ...range('tilt'), step: 5, get: () => cur().tilt, set: (v) => tm.tweak({ tilt: v }), fmt: (v) => `${v}°`, disabled: t.flow === 'flat', edited: tweaked('tilt') }),
      choice('Font', { get: () => cur().font, set: (v) => tm.tweak({ font: v }), options: Object.keys(FONTS), fmt: (v) => FONTS[v].label, edited: tweaked('font') }),
      { sep: true },
      { label: 'Undo my changes', icon: 'sync', keep: true, disabled: !tm.dirty, action: () => tm.resetTweaks() },
      { label: 'Save as a new theme…', icon: 'check', primary: true, keep: true, action: () => askName(app, { title: 'Name your theme', value: `My ${tm.base.name}`.slice(0, 40), onName: (name) => { tm.saveAs(name); toast(`Saved “${name}”`, 'check'); } }) },
      ...(mine ? [
        { label: `Save changes to “${tm.base.name}”`, icon: 'check', keep: true, disabled: !tm.dirty, action: () => { tm.updateCustom(); toast('Theme updated', 'check'); } },
        { label: 'Rename…', icon: 'gear', keep: true, action: () => askName(app, { title: 'Rename theme', value: tm.base.name, onName: (name) => tm.rename(tm.activeId, name) }) },
        { label: 'Delete this theme', icon: 'trash', keep: true, action: () => confirmDelete(app) },
      ] : []),
      { label: 'Export this theme as a file', icon: 'download', keep: true, action: () => { tm.download(cur()); toast('Theme file saved to your downloads', 'check'); } },
      { label: 'Import a theme file…', icon: 'upload', keep: true, action: () => importThemeFile(app) },
    ];
  };

  const title = () => `Customize · ${tm.base.name}`;
  const note = () => (tm.base.builtin ? 'Changes apply right away. Use “Save as a new theme” to keep them as your own.' : 'Changes apply right away. “Save changes” keeps them in this theme.');
  const sheet = new ListSheet(app, {
    title: title(),
    note: note(),
    wide: true,
    items: [],
    hints: [{ pad: 'cross', key: 'Enter', label: 'Change' }, { pad: 'D-pad', key: '← →', label: 'Adjust' }, { pad: 'circle', key: 'Esc', label: 'Done' }],
    onClose: () => off(),
  });
  const refresh = () => sheet.setItems(build(), { keepSel: true, title: title(), note: note() });
  const off = app.on('themes', refresh);
  refresh();
  sheet.sel = 0;
  sheet.paint();
  app.openLayer(sheet);
}

/** A name dialog; `onName` may throw to show a message in the dialog. */
function askName(app, { title, value, onName }) {
  app.openLayer(new TextPrompt(app, {
    title,
    value,
    placeholder: 'Theme name',
    onSubmit: (name) => {
      if (!name) throw new Error('Give it a name');
      onName(name);
    },
  }));
}

function confirmDelete(app) {
  const tm = app.themes;
  const { id, name } = tm.base;
  app.openLayer(new ListSheet(app, {
    title: `Delete “${name}”?`,
    note: 'This removes the theme from Flowdeck. Your media files are not touched.',
    items: [
      { label: 'Delete', icon: 'trash', primary: true, action: () => { tm.remove(id); toast('Theme deleted', 'trash'); } },
      { label: 'Keep it', icon: 'close' },
    ],
  }));
}

/** Choose a theme file from disk. Only text is read, and it is checked by themes.js before anything is used. */
export function importThemeFile(app) {
  let input = app.themeFile;
  if (!input) {
    input = app.themeFile = h('input', { type: 'file', accept: '.json,application/json', tabindex: '-1', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try {
        if (file.size > 20000) throw new Error('That file is too large to be a theme');
        const id = app.themes.addFromJson(await file.text());
        toast(`Added “${app.themes.find(id).name}”`, 'check');
      } catch (e) {
        toast(e.message, 'info', 5000);
      }
    });
    document.body.append(input);
  }
  input.click();
}

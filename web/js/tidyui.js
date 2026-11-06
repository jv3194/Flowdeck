// The "Tidy folder names" screens: choose what to look at, see exactly what would change on disk, approve it, undo it.
// Nothing is changed until "Apply" is pressed, and the server re-checks everything at that moment (see server/tidy.js).
import { api } from './api.js';
import { baseCategory } from './library.js';
import { actionText, detailText, followIds, forServer, pathText, summarize, tidyTargets } from './tidy.js';
import { ListSheet, TextPrompt, toast } from './ui.js';

const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const CAUTION = 'This renames folders on your disk, as Windows would: a movie\'s folder becomes “Title (Year)”, and loose files are put in a folder of their own. You see every change first, nothing is overwritten or merged, and the latest change can be undone. If Sonarr, Radarr or a download client manages these folders, rename them there instead, or they will lose track of the files.';

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const changes = (r) => [r.folders && plural(r.folders, 'folder'), r.files && plural(r.files, 'file')].filter(Boolean).join(' and ');

/** Undo a batch and bring the page back in step: the library, and the preferences keyed by file id. Returns the server's answer. */
async function undoBatch(app, id) {
  const r = await api.tidyUndo(id);
  app.migrateIds(r.idMap);
  if (r.undone) toast(`Put ${plural(r.undone, 'change')} back as ${r.undone === 1 ? 'it was' : 'they were'}`, 'trash', 5000);
  if (r.failed?.length) toast(`${plural(r.failed.length, 'change')} couldn't be undone: ${r.failed[0]}`, 'info', 8000);
  app.libraryChanged();
  return r;
}

/** Options → Tidy folder names: this movie or show, or the whole shelf, or undo the last change. */
export async function openTidy(app) {
  const ctx = app.currentEntry();
  const cat = app.prefs.category;
  const entryIsVideo = ctx && baseCategory(ctx.category) === 'video';
  if (!entryIsVideo && baseCategory(cat) !== 'video') return toast('Tidy folder names is for movies and shows: open the Videos shelf first', 'info', 4500);
  const shelf = tidyTargets(app.cols[baseCategory(cat) === 'video' ? cat : 'video'] || []);
  const here = entryIsVideo ? tidyTargets([ctx.entry]) : [];
  let history = [];
  try {
    ({ batches: history } = await api.tidyHistory());
  } catch {
    /* no undo list to show: the rest still works */
  }
  const items = here.length
    ? [{ label: `Just “${cut(here[0].label, 40)}”`, icon: 'folder', primary: true, action: () => openTidyReview(app, { targets: here, title: here[0].label, single: true }) }]
    : [{ label: 'The selected item can\'t be tidied', icon: 'info', sm: 'a home video, or nothing is selected', disabled: true }];
  items.push({ label: 'Everything on this shelf', icon: 'grid', value: String(shelf.length), disabled: !shelf.length, action: () => openTidyReview(app, { targets: shelf, title: 'this shelf' }) });
  if (history[0]) {
    const h = history[0];
    items.push({ sep: true }, {
      label: `Undo the last change: “${cut(h.label, 36)}”`, icon: 'trash', sm: `${ago(h.at)}, ${changes(h) || 'folders'}`,
      action: () => undoBatch(app, h.id).catch((e) => toast(e.message, 'info', 6000)),
    });
  }
  app.openLayer(new ListSheet(app, { title: 'Tidy folder names', note: CAUTION, closeBelow: true, items }));
}

/**
 * The preview. Every movie or show with what its folder is called now and what it would become, ticked where we are
 * fairly sure (looked up online, or the one you chose), and apart from those that can't be done, with the reason.
 */
export function openTidyReview(app, { targets, title, single = false }) {
  const edited = targets.map((t) => ({ ...t })); // the user may give some their own folder name
  let plans = [];
  let ticks = new Set();
  let cursor = -1; // the last list row the highlight was on, for "change the name"
  let busy = true;
  let result = null; // what the last Apply did, while it can still be undone from here
  let closed = false;
  const failed = new Map();
  const note = single ? 'Tick it, then Apply. You can change the folder name first.' : 'Ones looked up online start ticked. The others are named from their file names, so check them first. Highlight a row to see the folder.';

  const plan = async (first = false) => {
    const out = await api.tidyPlan(edited.map(forServer));
    plans = out.plans;
    if (first) ticks = new Set(plans.filter((p) => p.status === 'ready' && (single || edited[p.index].looked)).map((p) => p.index));
    else ticks = new Set([...ticks].filter((i) => plans[i]?.status === 'ready'));
  };

  const build = () => {
    const n = ticks.size;
    const sum = summarize(plans);
    const rows = [{
      label: busy ? 'Working…' : n ? `Apply ${plural(n, 'change')}` : 'Nothing is ticked', icon: 'check', primary: true, disabled: !n || busy, keep: true, action: apply,
    }];
    if (plans.length > 1) rows.push({ label: `${sum.ready} can be done · ${sum.same} already tidy · ${sum.blocked} can't be done`, icon: 'info', disabled: true });
    rows.push(
      { label: 'Tick everything that can be done', icon: 'check', disabled: !sum.ready || busy, keep: true, action: (s) => { ticks = new Set(plans.filter((p) => p.status === 'ready').map((p) => p.index)); refresh(s); } },
      { label: 'Untick everything', icon: 'unchecked', disabled: !n || busy, keep: true, action: (s) => { ticks.clear(); refresh(s); } },
      { label: 'Change the name of the highlighted folder…', icon: 'gear', disabled: busy || !plans.length, keep: true, action: rename },
    );
    if (result?.batch) rows.push({ label: `Undo the ${changes(result)} just changed`, icon: 'trash', keep: true, disabled: busy, action: undo });
    rows.push({ sep: true });
    for (const p of plans) {
      const t = edited[p.index];
      const ready = p.status === 'ready';
      rows.push({
        planIndex: p.index,
        label: ready ? p.name : cut(t.label, 50),
        value: failed.has(p.index) ? `couldn't: ${failed.get(p.index)}` : detailText(p),
        sm: actionText(p) + (ready && !single && !t.looked ? ' · from file name' : ''),
        icon: ready ? (ticks.has(p.index) ? 'check' : 'unchecked') : p.status === 'same' ? 'check' : 'info',
        on: ready && ticks.has(p.index),
        disabled: !ready,
        keep: true,
        action: (s) => { if (ticks.has(p.index)) ticks.delete(p.index); else ticks.add(p.index); refresh(s); },
      });
    }
    if (!plans.length) rows.push({ label: busy ? 'Looking at your folders…' : 'Nothing to tidy here', icon: 'info', disabled: true });
    return rows;
  };

  const sheet = new ListSheet(app, {
    title: `Tidy folder names · ${cut(title, 36)}`,
    note,
    wide: true,
    items: build(),
    hints: [{ pad: 'cross', key: 'Enter', label: 'Tick / choose' }, { pad: 'D-pad', key: '↑ ↓', label: 'Browse' }, { pad: 'circle', key: 'Esc', label: 'Close' }],
    onSelect: (it) => {
      if (it?.planIndex != null) cursor = it.planIndex;
      const p = it?.planIndex != null ? plans[it.planIndex] : null;
      const line = p ? pathText(p) : '';
      sheet.pathEl.textContent = line;
      sheet.pathEl.style.display = line ? '' : 'none';
      sheet.noteEl.textContent = p?.warnings?.length ? `${note}  ⚠ ${p.warnings.join('  ⚠ ')}` : note;
    },
    onClose: () => { closed = true; },
  });
  const refresh = (s = sheet) => s.setItems(build(), { keepSel: true });

  function rename() {
    const t = edited[cursor];
    const p = plans[cursor];
    if (!t || !p) return toast('Highlight a folder in the list first', 'info', 3000);
    app.openLayer(new TextPrompt(app, {
      title: 'Folder name',
      note: `What should the folder for “${cut(t.label, 60)}” be called? Characters Windows doesn't allow are taken out.`,
      value: p.name || t.label,
      placeholder: 'Folder name',
      submitLabel: 'Use this name',
      onSubmit: async (value) => {
        if (!value) throw new Error('Type a name');
        t.name = value;
        await plan();
        if (plans[cursor]?.status === 'ready') ticks.add(cursor);
        refresh();
      },
    }));
  }

  async function apply() {
    const chosen = [...ticks].sort((a, b) => a - b);
    if (!chosen.length) return;
    busy = true;
    refresh();
    try {
      const out = await api.tidyApply(chosen.map((i) => forServer(edited[i])));
      failed.clear();
      for (const f of out.failed) failed.set(chosen[f.index], f.reason);
      app.migrateIds(out.idMap);
      edited.forEach((t, i) => { edited[i] = { ...followIds(t, out.idMap), name: t.name }; });
      result = out.batch ? out : null;
      if (out.batch) toast(`Done: ${changes(out)}. You can undo it from this window or Options → Tidy folder names`, 'check', 7000);
      if (out.failed.length) toast(`${plural(out.failed.length, 'item')} couldn't be done: ${out.failed[0].reason}`, 'info', 9000);
      app.libraryChanged();
    } catch (e) {
      toast(e.message, 'info', 7000);
    }
    await plan().catch(() => {});
    busy = false;
    if (!closed) refresh();
  }

  async function undo() {
    busy = true;
    refresh();
    try {
      const r = await undoBatch(app, result.batch);
      edited.forEach((t, i) => { edited[i] = { ...followIds(t, r.idMap), name: t.name }; });
      result = null;
    } catch (e) {
      toast(e.message, 'info', 6000);
    }
    await plan().catch(() => {});
    busy = false;
    if (!closed) refresh();
  }

  app.openLayer(sheet);
  plan(true)
    .then(() => { busy = false; if (!closed) refresh(); })
    .catch((e) => { toast(e.message, 'info', 6000); sheet.close(); });
}

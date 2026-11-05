// The review screen for "Identify songs": every song with what it says now and what was found for it, so the user can
// see, change and approve the proposals before anything is written into their files.
import { api } from './api.js';
import { ListSheet, toast } from './ui.js';

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pct = (c) => `${Math.round(c.score * 100)}%`;

const describeCandidate = (c) => `${cut(c.title, 34)} — ${cut(c.artist, 24)}${c.album ? ` · ${cut(c.album, 26)}` : ''}${c.year ? ` (${c.year})` : ''}`;
const describeCurrent = (r) => {
  const c = r.current;
  const name = c.title || r.query.title || r.name;
  const who = c.artist || r.query.artist;
  return `${cut(name, 36)}${who ? ` — ${cut(who, 26)}` : ''}`;
};

/** `ids`: the songs to look at; `title`: what they belong to (an album, an artist, a folder). */
export function openSongReview(app, { ids, title }) {
  const choice = new Map(); // id → { pick, on }
  let snap = { active: true, done: 0, total: ids.length, current: '', offline: false, error: '', results: [] };
  let art = true;
  let applied = [];
  let applying = false;
  let closed = false;

  // Decide what is ticked as each result arrives: only confident, editable songs start ticked.
  const take = (results) => {
    for (const r of results) {
      if (choice.has(r.id)) continue;
      choice.set(r.id, { pick: Math.max(0, r.pick), on: r.status === 'found' && r.confident && r.writable });
    }
  };
  const ticked = () => snap.results.filter((r) => choice.get(r.id)?.on && r.candidates[choice.get(r.id).pick] && r.status === 'found');

  const build = () => {
    const n = ticked().length;
    const rows = [
      {
        label: applying ? 'Saving into the files…' : n ? `Save ${n} song${n === 1 ? '' : 's'} into the files` : 'Nothing is ticked to save', icon: 'check', primary: true, disabled: !n || applying, keep: true,
        action: save,
      },
      {
        label: snap.active ? `Looking up songs… ${snap.done} of ${snap.total}` : snap.offline ? 'No connection: the rest were not looked up' : `${snap.total} song${snap.total === 1 ? '' : 's'} looked up`,
        icon: 'sync', sm: snap.active ? cut(snap.current, 34) : '', disabled: true,
      },
      {
        label: 'Tick every confident match', icon: 'check', keep: true,
        action: (s) => { for (const r of snap.results) if (r.status === 'found' && r.confident && r.writable) choice.get(r.id).on = true; refresh(s); },
      },
      { label: 'Untick everything', icon: 'unchecked', keep: true, action: (s) => { for (const c of choice.values()) c.on = false; refresh(s); } },
      { label: 'Also add the cover when a song has none', icon: 'image', value: art ? 'On' : 'Off', keep: true, action: (s) => { art = !art; refresh(s); } },
      ...(applied.length ? [{ label: `Undo the ${applied.length} change${applied.length === 1 ? '' : 's'} just saved`, icon: 'trash', keep: true, action: undo }] : []),
      { sep: true },
    ];
    for (const r of snap.results) {
      const ch = choice.get(r.id) || { pick: 0, on: false };
      const c = r.candidates[ch.pick];
      let value;
      let note = '';
      if (r.status === 'applied') value = 'saved';
      else if (!r.writable) value = 'cannot edit this file type';
      else if (r.status === 'same') value = 'already right';
      else if (r.status === 'none' || !c) value = r.status === 'error' ? 'could not look up' : 'no match found';
      else {
        value = `→ ${describeCandidate(c)}`;
        note = `${pct(c)}${r.candidates.length > 1 ? ` · ${ch.pick + 1}/${r.candidates.length}` : ''}`;
      }
      const usable = r.status === 'found' && r.writable && c;
      rows.push({
        label: describeCurrent(r), value, sm: note,
        icon: r.status === 'applied' ? 'check' : usable ? (ch.on ? 'check' : 'unchecked') : 'info',
        on: !!(usable && ch.on),
        disabled: !usable,
        keep: true,
        action: (s) => { ch.on = !ch.on; refresh(s); },
        adjust: usable ? (dir, s) => { ch.pick = (ch.pick + dir + r.candidates.length) % r.candidates.length; ch.on = true; refresh(s); } : undefined,
      });
    }
    return rows;
  };

  const sheet = new ListSheet(app, {
    title: `Identify songs · ${cut(title, 40)}`,
    wide: true,
    note: 'Each song is searched for online by its title and artist (or its file name). Tick the ones that are right, ← → shows other matches, then save: the details are written into the MP3 and FLAC files and can be undone. Nothing is changed until you save.',
    items: build(),
    onClose: () => { closed = true; if (snap.active) api.songsCancel().catch(() => {}); },
  });
  const refresh = (s = sheet) => s.setItems(build(), { keepSel: true });

  async function save() {
    const changes = ticked().map((r) => ({ id: r.id, pick: choice.get(r.id).pick, art }));
    applying = true;
    refresh();
    try {
      const out = await api.songsApply(changes);
      applied = out.done || [];
      toast(out.wrote ? `Saved details into ${out.wrote} file${out.wrote === 1 ? '' : 's'}. Undo is in this window` : out.failed || out.skipped ? `Nothing was saved${out.errors?.[0] ? `: ${out.errors[0]}` : ''}` : 'Those files already have these details', out.wrote ? 'check' : 'info', 6000);
      if (out.failed) toast(`${out.failed} file${out.failed === 1 ? '' : 's'} couldn't be saved (${out.errors?.[0] || 'in use or read-only'})`, 'info', 7000);
      for (const id of applied) choice.get(id).on = false;
      app.libraryChanged();
    } catch (e) {
      toast(e.message, 'info', 6000);
    }
    applying = false;
    await poll(true);
  }

  async function undo() {
    try {
      const r = await api.undoFiles(applied);
      toast(r.restored ? `Put ${r.restored} file${r.restored === 1 ? '' : 's'} back exactly as ${r.restored === 1 ? 'it was' : 'they were'}` : 'Nothing was restored: the files have changed since', r.restored ? 'trash' : 'info', 5000);
      applied = [];
      app.libraryChanged();
    } catch (e) {
      toast(e.message, 'info', 5000);
    }
    refresh();
  }

  async function poll(once = false) {
    while (!closed) {
      try {
        snap = await api.songs();
        take(snap.results);
        refresh();
      } catch {
        /* the next round tries again */
      }
      if (once || !snap.active) return;
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  app.openLayer(sheet);
  api.songsIdentify(ids).then(() => poll()).catch((e) => { toast(e.message, 'info', 5000); sheet.close(); });
}

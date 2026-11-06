// Tidy folder names, the page's side: turning shelf entries into requests, and keeping the page's own copy of the
// preferences in step when a rename changes the ids of the files. Pure, so it is tested without a browser.
// (The rules, and all the changing of files, live on the server: see server/tidy.js.)

/** A movie is one video that reads as a movie (home clips are not); a show is any show with episodes. */
export const isTidyable = (e) => !!e && (e.kind === 'show' ? Array.isArray(e.episodes) && e.episodes.length > 0 : e.kind === 'video' && e.parsed?.type === 'movie');

/** What to name the folder after, from an entry: the looked-up title and year when there are some, else the file name's. */
export function tidyTarget(e) {
  if (e.kind === 'show') {
    return {
      ids: e.episodes.map((x) => x.id), kind: 'show', title: e.title, year: e.year || e.episodes.find((x) => x.parsed?.year)?.parsed.year || null,
      label: e.title, looked: e.fetched === 2,
    };
  }
  return { ids: [e.id], kind: 'movie', title: e.title, year: e.year || null, label: e.displayTitle || e.title, looked: e.fetched === 2 };
}

export const tidyTargets = (entries) => (entries || []).filter(isTidyable).map(tidyTarget);

/** Only what the server needs, nothing the page keeps for itself. */
export const forServer = ({ ids, kind, title, year, name, looked }) => ({ ids, kind, title, year, looked: !!looked, ...(name ? { name } : {}) });

/** After a rename the files have new ids: point the targets at them, so a fresh plan finds them. */
export const followIds = (target, idMap) => ({ ...target, ids: target.ids.map((id) => idMap?.[id] || id) });

/** { ready, same, blocked } counts of a list of plans. */
export function summarize(plans) {
  const n = { ready: 0, same: 0, blocked: 0 };
  for (const p of plans) n[p.status] = (n[p.status] || 0) + 1;
  return n;
}

/** Short words for what a plan would do. */
export function actionText(plan) {
  if (plan.status === 'same') return 'already tidy';
  if (plan.status === 'blocked') return 'cannot be done';
  return plan.action === 'rename' ? 'rename folder' : 'put in its own folder';
}

const leaf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).at(-1) || '';

/** The line shown beside a plan: what the folder is called now, or what moves, or why not. */
export function detailText(plan) {
  if (plan.status === 'blocked') return plan.reason;
  if (plan.status === 'same') return plan.reason;
  if (plan.action === 'rename') return `was “${leaf(plan.from)}”`;
  return `${plan.files} file${plan.files === 1 ? '' : 's'} move${plan.files === 1 ? 's' : ''}`;
}

/** "D:\Movies\Heat.1995 → Heat (1995)", for the line under the title when a row is highlighted. */
export function pathText(plan) {
  if (plan.status !== 'ready') return '';
  return plan.action === 'rename' ? `${plan.from}  →  ${leaf(plan.to)}` : `${plan.from}  →  new folder ${leaf(plan.to)}`;
}

/**
 * Re-key the preferences that are keyed by a video's id, given { oldId: newId }. The server has already done this to
 * the saved copy; this brings the page's copy (and any change still waiting to be sent) into line. Values are lifted
 * out first so ids that swap places cannot clobber each other. Nulls (a pending "forget this") move too.
 */
export function migrateIds(prefs, idMap) {
  const pairs = Object.entries(idMap || {});
  if (!prefs || !pairs.length) return prefs;
  for (const k of ['progress', 'watched', 'lastPlayed', 'subDelay']) {
    const o = prefs[k];
    if (!o || typeof o !== 'object') continue;
    const lifted = [];
    for (const [a, b] of pairs) if (Object.hasOwn(o, a)) { lifted.push([b, o[a]]); delete o[a]; }
    for (const [b, v] of lifted) o[b] = v;
  }
  if (prefs.focus && typeof prefs.focus === 'object') {
    for (const [cat, v] of Object.entries(prefs.focus)) if (Object.hasOwn(idMap, v)) prefs.focus[cat] = idMap[v];
  }
  return prefs;
}

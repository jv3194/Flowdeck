// Subtitle display: draws cues itself (instead of <track>) so the look is consistent, the delay is
// adjustable, and cue text is only ever added as DOM text nodes, never parsed as HTML.

/** Text size as a share of the viewport height. */
export const SIZES = { S: 3.4, M: 4.4, L: 5.6 };
export const SIZE_NAMES = { S: 'Small', M: 'Medium', L: 'Large' };

let names = null;
try {
  names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
} catch {
  /* older runtime: show the raw code */
}

export function languageName(code) {
  if (!code) return '';
  try {
    return names?.of(code) || code;
  } catch {
    return code;
  }
}

export function trackLabel(t) {
  const lang = languageName(t.lang);
  let label = lang || t.name || (t.kind === 'file' ? 'Subtitles' : 'Track');
  if (lang && t.name && t.name.length < 32 && !t.name.toLowerCase().includes(lang.toLowerCase())) label += ` · ${t.name}`;
  if (t.forced) label += ' (forced)';
  if (t.sdh) label += ' (SDH)';
  return label;
}

export const trackDetail = (t) => `${t.kind === 'file' ? 'File' : 'Inside the video'} · ${t.ext.toUpperCase()}${t.supported === false ? ' · image-based, can’t be shown' : ''}`;

/** The track to switch on automatically: the remembered language, preferring full subtitles over forced/SDH ones. */
export function pickTrack(tracks, { on, lang } = {}) {
  if (!on) return null;
  const usable = tracks.filter((t) => t.supported !== false);
  const pool = lang ? usable.filter((t) => t.lang === lang) : usable;
  // Full dialogue first; forced-only, SDH and commentary tracks only if nothing better matches.
  const rank = (t) => (t.forced ? 2 : 0) + (t.sdh ? 1 : 0) + (/commentary/i.test(t.name || '') ? 4 : 0);
  return [...pool].sort((a, b) => rank(a) - rank(b))[0] || null;
}

export const fmtDelay = (s) => `${s > 0 ? '+' : ''}${s.toFixed(1)} s`;

/** `text` uses only <i> <b> <u> and newlines. Anything else is shown literally. */
function cueElement(text) {
  const box = document.createElement('div');
  box.className = 'cue';
  let node = box;
  const open = [];
  let last = 0;
  for (const m of text.matchAll(/<(\/?)([ibu])>|\n/g)) {
    if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[0] === '\n') node.append(document.createElement('br'));
    else if (!m[1]) {
      const el = document.createElement(m[2]);
      node.append(el);
      open.push(el);
      node = el;
    } else if (open.length && open[open.length - 1].localName === m[2]) {
      open.pop();
      node = open.length ? open[open.length - 1] : box;
    }
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
  return box;
}

export class SubtitleView {
  constructor(el) {
    this.el = el;
    this.cues = [];
    this.offset = 0; // seconds; positive shows subtitles later
    this.shown = null; // which cues are on screen ("3,4"), or null to force the next update to redraw
  }

  setCues(cues) {
    this.cues = cues || [];
    this.shown = null;
    this.el.textContent = '';
  }

  setOffset(seconds) {
    this.offset = seconds;
    this.shown = null; // what's on screen may no longer be right, even if nothing should show now
  }

  clear() {
    this.setCues([]);
  }

  /** Show whichever cues cover `time`. Cheap enough to call every frame: it only touches the DOM when the set changes. */
  update(time) {
    const { cues } = this;
    if (!cues.length) {
      if (this.shown !== '') this.setCues([]), (this.shown = '');
      return;
    }
    const t = time - this.offset;
    let lo = 0;
    let hi = cues.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const active = [];
    for (let i = at; i >= 0 && i > at - 8; i--) if (cues[i].e > t) active.push(i); // cues may overlap
    active.reverse();
    const key = active.join(',');
    if (key === this.shown) return;
    this.shown = key;
    this.el.replaceChildren(...active.map((i) => cueElement(cues[i].t)));
  }
}

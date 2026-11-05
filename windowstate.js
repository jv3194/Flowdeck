'use strict';
// Remembering the window between launches: its size, where it was, and whether it was maximised.
// Pure functions (no Electron), so the rules can be tested: main.js feeds them the real screens.
const fs = require('fs');
const path = require('path');

const DEFAULT = { width: 1280, height: 760 };
const MIN = { width: 900, height: 540 }; // the same minimum the window itself enforces
const VISIBLE = { width: 120, height: 80 }; // how much of a window must still be on a screen for its position to be trusted

const whole = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);

/** What a saved file may contain, cleaned: numbers only, never smaller than the window's minimum. */
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    x: whole(raw.x),
    y: whole(raw.y),
    width: Math.max(MIN.width, whole(raw.width) ?? DEFAULT.width),
    height: Math.max(MIN.height, whole(raw.height) ?? DEFAULT.height),
    maximized: raw.maximized === true,
  };
}

function load(file) {
  try {
    return clean(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null; // first run, or unreadable: open at the default size
  }
}

/** Written beside the real file and renamed into place, so a crash while saving can't leave half a file. */
function save(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean(state)));
    fs.renameSync(tmp, file);
  } catch {
    /* losing the window position is never worth an error */
  }
}

const overlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
const overlapY = (a, b) => Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

/**
 * The bounds to open with. The saved size is always kept (shrunk if it no longer fits any screen); the saved
 * position only if enough of the window would still be on a connected screen: a monitor that has been unplugged
 * must not leave the window somewhere off-screen. `areas` are the screens' usable rectangles { x, y, width, height }.
 */
function initialBounds(saved, areas) {
  const s = clean(saved) || clean({}); // cleaned again here, so a size below the minimum can never get through whoever calls this
  const out = { width: s.width, height: s.height, maximized: !!saved && s.maximized };
  const biggest = areas.reduce((m, a) => (a.width * a.height > m.width * m.height ? a : m), areas[0] || { x: 0, y: 0, width: 1e5, height: 1e5 });
  out.width = Math.min(out.width, Math.max(MIN.width, biggest.width));
  out.height = Math.min(out.height, Math.max(MIN.height, biggest.height));
  if (s.x !== undefined && s.y !== undefined) {
    const rect = { x: s.x, y: s.y, width: out.width, height: out.height };
    if (areas.some((a) => overlap(rect, a) >= VISIBLE.width && overlapY(rect, a) >= VISIBLE.height)) {
      out.x = s.x;
      out.y = s.y;
    }
  }
  return out;
}

module.exports = { load, save, initialBounds, clean, DEFAULT, MIN };

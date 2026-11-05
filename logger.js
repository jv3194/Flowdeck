'use strict';
// A small log file for bug reports: errors from the server, the window and the page, in the user's profile.
// It keeps the last two megabytes or so (the current file and one older one), and never throws.
const fs = require('fs');
const path = require('path');

const LINE_MAX = 4000; // one runaway message must not fill the file

/** One log argument as text: errors with their stack, objects as JSON, anything else as it prints. */
function text(part) {
  if (part instanceof Error) return part.stack || `${part.name}: ${part.message}`;
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function createLogger(dir, { maxBytes = 1_000_000, now = () => new Date() } = {}) {
  const file = path.join(dir, 'flowdeck.log');
  let size = -1;

  function rotate() {
    try {
      fs.renameSync(file, `${file}.1`); // replaces the older copy
    } catch {
      /* nothing to rotate */
    }
    size = 0;
  }

  function line(level, ...parts) {
    try {
      if (size < 0) {
        fs.mkdirSync(dir, { recursive: true });
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      const body = parts.map(text).join(' ').replace(/\r?\n/g, '\n    ').slice(0, LINE_MAX);
      const out = `${now().toISOString()} [${level}] ${body}\n`;
      if (size + out.length > maxBytes) rotate();
      fs.appendFileSync(file, out);
      size += out.length;
    } catch {
      /* a log that cannot be written must never take the app down with it */
    }
  }

  return { file, dir, line, info: (...a) => line('info', ...a), warn: (...a) => line('warn', ...a), error: (...a) => line('error', ...a) };
}

module.exports = { createLogger, text };

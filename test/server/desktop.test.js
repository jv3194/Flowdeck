'use strict';
// The desktop shell's own logic: remembering the window, and the log file. (Electron itself is exercised by the smoke run.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const windowState = require('../../windowstate.js');
const { createLogger } = require('../../logger.js');
const { tmp } = require('../support.js');

const screen = (x, y, width, height) => ({ x, y, width, height });
const one = [screen(0, 0, 1920, 1040)];

// ------------------------------------------------------------------ window state

test('first launch: the default size, centred by the system, not maximised', () => {
  assert.deepEqual(windowState.initialBounds(null, one), { width: 1280, height: 760, maximized: false });
});

test('a saved size and position are restored when the window would still be on a screen', () => {
  const b = windowState.initialBounds({ x: 200, y: 120, width: 1500, height: 900, maximized: false }, one);
  assert.deepEqual(b, { x: 200, y: 120, width: 1500, height: 900, maximized: false });
});

test('maximised is remembered', () => {
  assert.equal(windowState.initialBounds({ x: 10, y: 10, width: 1300, height: 800, maximized: true }, one).maximized, true);
});

test('a monitor that has been unplugged cannot leave the window off-screen: the position is dropped, the size kept', () => {
  const b = windowState.initialBounds({ x: 3000, y: 100, width: 1400, height: 800, maximized: false }, one);
  assert.deepEqual(b, { width: 1400, height: 800, maximized: false });
  assert.equal(windowState.initialBounds({ x: -2500, y: 0, width: 1400, height: 800 }, one).x, undefined);
});

test('only a sliver on a screen is not enough; a good part of the window is', () => {
  assert.equal(windowState.initialBounds({ x: 1880, y: 100, width: 1280, height: 760 }, one).x, undefined, '40 px visible');
  assert.equal(windowState.initialBounds({ x: 1700, y: 100, width: 1280, height: 760 }, one).x, 1700, '220 px visible');
  assert.equal(windowState.initialBounds({ x: 100, y: 1020, width: 1280, height: 760 }, one).x, undefined, 'nearly below the bottom edge');
});

test('several monitors, including ones left of or above the main one, are all valid places', () => {
  const two = [screen(-1920, 0, 1920, 1040), screen(0, 0, 2560, 1400)];
  assert.equal(windowState.initialBounds({ x: -1800, y: 50, width: 1280, height: 760 }, two).x, -1800);
  assert.equal(windowState.initialBounds({ x: 2000, y: 50, width: 1280, height: 760 }, two).x, 2000);
  const stacked = [screen(0, 0, 1920, 1040), screen(0, -1080, 1920, 1080)];
  assert.equal(windowState.initialBounds({ x: 100, y: -900, width: 1280, height: 760 }, stacked).y, -900);
});

test('a window bigger than the biggest screen is shrunk to fit, but never below the minimum', () => {
  const b = windowState.initialBounds({ x: 0, y: 0, width: 5000, height: 4000 }, one);
  assert.deepEqual([b.width, b.height], [1920, 1040]);
  const tiny = windowState.initialBounds({ width: 100, height: 100 }, [screen(0, 0, 640, 480)]);
  assert.deepEqual([tiny.width, tiny.height], [windowState.MIN.width, windowState.MIN.height]);
});

test('what is read back is cleaned: numbers only, never below the minimum size, junk ignored', () => {
  assert.deepEqual(windowState.clean({ x: '5', y: null, width: 10, height: 'tall', maximized: 'yes' }), { x: undefined, y: undefined, width: 900, height: 760, maximized: false });
  assert.equal(windowState.clean([1, 2]), null);
  assert.equal(windowState.clean('text'), null);
});

test('saving and loading round-trips; a missing or damaged file gives the defaults; saving never throws', () => {
  const t = tmp();
  try {
    const file = path.join(t.dir, 'sub', 'window.json');
    assert.equal(windowState.load(file), null);
    windowState.save(file, { x: 40, y: 50, width: 1400, height: 820, maximized: true });
    assert.deepEqual(windowState.load(file), { x: 40, y: 50, width: 1400, height: 820, maximized: true });
    assert.ok(!fs.existsSync(`${file}.tmp`), 'no half-written file is left behind');
    fs.writeFileSync(file, '{ not json');
    assert.equal(windowState.load(file), null);
    assert.doesNotThrow(() => windowState.save(path.join(t.dir, 'sub', 'window.json', 'impossible', 'x.json'), { width: 1 })); // a path under a file
  } finally {
    t.cleanup();
  }
});

// ----------------------------------------------------------------------- the log

test('log lines carry a timestamp and level; errors keep their stack; objects become JSON', () => {
  const t = tmp();
  try {
    const log = createLogger(path.join(t.dir, 'logs'), { now: () => new Date('2026-11-04T10:00:00.000Z') });
    log.info('started', { version: '1.2.0' });
    log.error('it broke:', new Error('boom'));
    log.warn('two\nlines');
    const lines = fs.readFileSync(log.file, 'utf8').split('\n');
    assert.equal(lines[0], '2026-11-04T10:00:00.000Z [info] started {"version":"1.2.0"}');
    assert.match(lines[1], /^2026-11-04T10:00:00\.000Z \[error\] it broke: Error: boom/);
    assert.ok(lines[2].includes('at '), 'the stack follows');
    assert.ok(fs.readFileSync(log.file, 'utf8').includes('[warn] two\n    lines'), 'continuation lines are indented under their entry');
  } finally {
    t.cleanup();
  }
});

test('the log is capped: it rotates to a single older copy instead of growing for ever', () => {
  const t = tmp();
  try {
    const log = createLogger(path.join(t.dir, 'logs'), { maxBytes: 2000 });
    for (let i = 0; i < 200; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    const files = fs.readdirSync(log.dir).sort();
    assert.deepEqual(files, ['flowdeck.log', 'flowdeck.log.1']);
    assert.ok(fs.statSync(log.file).size <= 2000);
    assert.ok(fs.readFileSync(log.file, 'utf8').includes('line 199'), 'the newest lines are in the current file');
    // a new run picks up the existing size instead of starting from zero
    const again = createLogger(log.dir, { maxBytes: 2000 });
    again.info('after restart');
    assert.ok(fs.statSync(again.file).size <= 2000);
  } finally {
    t.cleanup();
  }
});

test('one runaway message is cut short, and a log that cannot be written never throws', () => {
  const t = tmp();
  try {
    const log = createLogger(path.join(t.dir, 'logs'));
    log.error('x'.repeat(100000));
    assert.ok(fs.readFileSync(log.file, 'utf8').length < 4200);
    const blocked = path.join(t.dir, 'a-file');
    fs.writeFileSync(blocked, 'x');
    assert.doesNotThrow(() => createLogger(path.join(blocked, 'logs')).error('nowhere to write'));
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => log.info(circular));
  } finally {
    t.cleanup();
  }
});

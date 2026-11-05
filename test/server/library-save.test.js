'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../server/library.js');
const { tmp } = require('../support.js');

test('saving many times at once never fails, and the file on disk is the latest', async () => {
  const t = tmp();
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const lib = new Library(path.join(t.dir, 'data'));
    const saves = [];
    for (let i = 0; i < 12; i++) {
      lib.items.set(`id${i}`, { id: `id${i}`, kind: 'audio' });
      saves.push(lib.saveNow());
    }
    await Promise.all(saves);
    assert.deepEqual(errors, []);
    assert.equal(JSON.parse(fs.readFileSync(lib.file, 'utf8')).items.length, 12);
    assert.ok(fs.existsSync(`${lib.file}.bak`), 'the previous version is kept as a fallback');
  } finally {
    console.error = realError;
    t.cleanup();
  }
});

test('a damaged library file falls back to the backup, and starts empty when there is neither', async () => {
  const t = tmp();
  try {
    const dir = path.join(t.dir, 'data');
    const lib = new Library(dir);
    lib.items.set('a', { id: 'a', kind: 'audio' });
    await lib.saveNow();
    lib.items.set('b', { id: 'b', kind: 'audio' });
    await lib.saveNow(); // now library.json holds two items and library.json.bak holds one
    fs.writeFileSync(lib.file, '{ this is not json');
    const again = new Library(dir);
    await again.load();
    assert.deepEqual([...again.items.keys()], ['a']);
    fs.rmSync(`${lib.file}.bak`);
    const empty = new Library(dir);
    await empty.load();
    assert.equal(empty.items.size, 0);
  } finally {
    t.cleanup();
  }
});

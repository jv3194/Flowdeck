'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../server/library.js');
const { tmp } = require('../support.js');

test('a thumbnail remembers how big it is, ignores nonsense sizes, and a missing size is not guessed', async () => {
  const t = tmp();
  try {
    const lib = new Library(path.join(t.dir, 'data'));
    fs.mkdirSync(lib.coverDir, { recursive: true });
    lib.items.set('p', { id: 'p', kind: 'image', path: 'p.jpg' });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await lib.setThumb('p', jpg, { size: 1280 });
    assert.equal(lib.toClient(lib.items.get('p')).ts, 1280);
    await lib.setThumb('p', jpg, { size: 99999 }); // absurd
    assert.equal(lib.toClient(lib.items.get('p')).ts, undefined);
    await lib.setThumb('p', jpg, { size: 960 });
    await lib.setThumb('p', null, { width: 100 }); // metadata only: the picture, and so its size, is untouched
    assert.equal(lib.items.get('p').ts, 960);
    await lib.setThumb('p', jpg, {});
    assert.equal(lib.items.get('p').ts, undefined);
    lib.close?.();
  } finally {
    t.cleanup();
  }
});

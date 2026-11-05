'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../server/library.js');
const { tmp, touch, scanned, sleep, until } = require('../support.js');

/** A library over a music folder and a photo folder, scanning quickly after changes, with a count of the scans it runs. */
async function watched() {
  const t = tmp();
  touch(path.join(t.dir, 'media', 'song.mp3'));
  touch(path.join(t.dir, 'media', 'film.mkv'));
  touch(path.join(t.dir, 'pics', 'a.jpg'));
  const lib = new Library(path.join(t.dir, 'data'));
  lib.watchDelay = 120;
  const count = { scans: 0 };
  const scan = lib.scan.bind(lib);
  lib.scan = () => { count.scans++; return scan(); };
  const names = () => [...lib.items.values()].map((i) => path.basename(i.path)).sort();
  await lib.addRoot(path.join(t.dir, 'media'));
  await scanned(lib);
  return { t, lib, count, names, media: path.join(t.dir, 'media'), pics: path.join(t.dir, 'pics'), done: async () => { lib.close(); await lib.saveNow(); t.cleanup(); } };
}

test('a file added to a library folder shows up without a manual rescan', async () => {
  const w = await watched();
  try {
    assert.deepEqual(w.names(), ['film.mkv', 'song.mp3']);
    touch(path.join(w.media, 'Album', 'new.mp3'));
    await until(() => w.names().includes('new.mp3'));
  } finally {
    await w.done();
  }
});

test('a file deleted or renamed outside the app disappears or moves on its own', async () => {
  const w = await watched();
  try {
    fs.rmSync(path.join(w.media, 'film.mkv'));
    await until(() => !w.names().includes('film.mkv'));
    fs.renameSync(path.join(w.media, 'song.mp3'), path.join(w.media, 'renamed.mp3'));
    await until(() => w.names().includes('renamed.mp3') && !w.names().includes('song.mp3'));
  } finally {
    await w.done();
  }
});

test('photo folders are watched too, and add photos to the library', async () => {
  const w = await watched();
  try {
    await w.lib.addRoot(w.pics, true);
    await scanned(w.lib);
    assert.ok(w.names().includes('a.jpg'));
    touch(path.join(w.pics, 'Trip', 'b.jpg'));
    await until(() => w.names().includes('b.jpg'));
  } finally {
    await w.done();
  }
});

test('a burst of changes (a big copy) causes one or two rescans, not one per file', async () => {
  const w = await watched();
  try {
    const before = w.count.scans;
    for (let i = 0; i < 30; i++) touch(path.join(w.media, `copy-${i}.mp3`));
    await until(() => w.names().filter((n) => n.startsWith('copy-')).length === 30);
    await sleep(500);
    assert.ok(w.count.scans - before <= 3, `${w.count.scans - before} rescans for one burst`);
  } finally {
    await w.done();
  }
});

test('half-written files (our own temp files, downloads in progress) do not trigger a rescan', async () => {
  const w = await watched();
  try {
    const before = w.count.scans;
    for (const name of ['x.flowdeck-tmp', 'movie.mkv.partial', 'song.mp3.crdownload', 'data.tmp', 'doc~']) touch(path.join(w.media, name));
    await sleep(700);
    assert.equal(w.count.scans, before);
  } finally {
    await w.done();
  }
});

test('a removed folder is no longer watched, and closing the library stops everything', async () => {
  const w = await watched();
  try {
    await w.lib.addRoot(w.pics, true);
    await scanned(w.lib);
    assert.equal(w.lib._watchers.size, 2);
    w.lib.removeRoot(w.pics, true);
    assert.equal(w.lib._watchers.size, 1);
    const before = w.count.scans;
    touch(path.join(w.pics, 'late.jpg'));
    await sleep(500);
    assert.equal(w.count.scans, before, 'nothing watches the removed folder');

    w.lib.close();
    assert.equal(w.lib._watchers.size, 0);
    touch(path.join(w.media, 'after-close.mp3'));
    await sleep(500);
    assert.equal(w.count.scans, before, 'a closed library never rescans');
    // an event that was already on its way when the library closed must not start a rescan into a folder that may be gone
    w.lib._changed('late.mp3');
    await sleep(400);
    assert.equal(w.count.scans, before, 'a late event after closing is ignored');
  } finally {
    await w.done();
  }
});

test('the same folder added as music and as photos is watched once', async () => {
  const w = await watched();
  try {
    await w.lib.addRoot(w.media, true);
    assert.equal(w.lib._watchers.size, 1);
  } finally {
    await w.done();
  }
});

test('a folder that goes away (an unplugged drive) is survived, and watching resumes once it is back', async () => {
  const w = await watched();
  try {
    const away = `${w.media}-away`;
    fs.renameSync(w.media, away);
    w.lib.scan();
    await scanned(w.lib);
    assert.equal(w.lib.items.size, 2, 'items are kept while it is missing');
    fs.renameSync(away, w.media);
    w.lib.scan();
    await scanned(w.lib);
    touch(path.join(w.media, 'back.mp3'));
    await until(() => w.names().includes('back.mp3'));
  } finally {
    await w.done();
  }
});

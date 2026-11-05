'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../server/library.js');
const { tmp, touch, scanned } = require('../support.js');

/** A library over a folder holding a music/video folder and a photo folder, scanned and ready. */
async function sample() {
  const t = tmp();
  touch(path.join(t.dir, 'media', 'song.mp3'));
  touch(path.join(t.dir, 'media', 'film.mkv'));
  touch(path.join(t.dir, 'media', 'stray.jpg'));
  touch(path.join(t.dir, 'pics', 'a.jpg'));
  touch(path.join(t.dir, 'pics', 'sub', 'b.png'));
  touch(path.join(t.dir, 'pics', 'song2.mp3'));
  const lib = new Library(path.join(t.dir, 'data'));
  return { t, lib, media: path.join(t.dir, 'media'), pics: path.join(t.dir, 'pics'), names: () => [...lib.items.values()].map((i) => `${i.kind}:${path.basename(i.path)}`).sort(), done: async () => { lib.close(); await lib.saveNow(); t.cleanup(); } };
}

test('music and video folders never contribute photos', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await scanned(s.lib);
    assert.deepEqual(s.names(), ['audio:song.mp3', 'video:film.mkv']);
  } finally {
    await s.done();
  }
});

test('photo folders contribute photos only, including from subfolders', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.pics, true);
    await scanned(s.lib);
    assert.deepEqual(s.names(), ['image:a.jpg', 'image:b.png']);
  } finally {
    await s.done();
  }
});

test('one folder can be both kinds; each list owns its own files, and removing one leaves the other', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await s.lib.addRoot(s.media, true);
    await scanned(s.lib);
    assert.deepEqual(s.names(), ['audio:song.mp3', 'image:stray.jpg', 'video:film.mkv']);
    s.lib.removeRoot(s.media, true);
    assert.deepEqual(s.names(), ['audio:song.mp3', 'video:film.mkv']);
    s.lib.removeRoot(s.media);
    assert.deepEqual(s.names(), []);
  } finally {
    await s.done();
  }
});

test('photos found by an older version through a music folder are dropped when the library loads', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await scanned(s.lib);
    await s.lib.saveNow();
    const file = s.lib.file;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.items.push({ id: 'old1', path: path.join(s.media, 'stray.jpg'), root: s.media, kind: 'image', ext: 'jpg' });
    delete saved.photoRoots;
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = new Library(path.join(s.t.dir, 'data'));
    await again.load();
    assert.deepEqual([...again.items.values()].map((i) => i.kind).sort(), ['audio', 'video']);
    assert.deepEqual(again.photoRoots, []);
  } finally {
    await s.done();
  }
});

test('a folder that cannot be read (an unplugged drive) keeps its items instead of emptying the library', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await scanned(s.lib);
    const away = `${s.media}-away`;
    fs.renameSync(s.media, away);
    s.lib.scan();
    await scanned(s.lib);
    assert.equal(s.lib.items.size, 2, 'items survive while the folder is missing');
    fs.renameSync(away, s.media);
    s.lib.scan();
    await scanned(s.lib);
    assert.equal(s.lib.items.size, 2);
  } finally {
    await s.done();
  }
});

test('files that are deleted from a readable folder disappear on the next scan', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await scanned(s.lib);
    fs.rmSync(path.join(s.media, 'film.mkv'));
    s.lib.scan();
    await scanned(s.lib);
    assert.deepEqual(s.names(), ['audio:song.mp3']);
  } finally {
    await s.done();
  }
});

test('cover-art files beside music are not mistaken for photos in a photo folder either way round', async () => {
  const s = await sample();
  try {
    touch(path.join(s.media, 'cover.jpg'));
    await s.lib.addRoot(s.media);
    await scanned(s.lib);
    assert.ok(!s.names().some((n) => n.startsWith('image:')));
    assert.ok([...s.lib.items.values()].find((i) => i.kind === 'audio').folderArt, 'the music still finds its folder art');
  } finally {
    await s.done();
  }
});

test('the client snapshot carries both folder lists and the items, with the fields shelves rely on', async () => {
  const s = await sample();
  try {
    await s.lib.addRoot(s.media);
    await s.lib.addRoot(s.pics, true);
    await scanned(s.lib);
    const snap = s.lib.snapshot();
    assert.deepEqual([snap.roots, snap.photoRoots], [[s.media], [s.pics]]);
    const song = snap.items.find((i) => i.ext === 'mp3' && i.name === 'song');
    assert.deepEqual([song.kind, song.title, song.dir], ['audio', 'song', s.media]);
  } finally {
    await s.done();
  }
});

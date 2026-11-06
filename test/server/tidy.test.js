'use strict';
// "Tidy folder names" renames and moves real files, so every test here works on throwaway folders in the temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../server/library.js');
const { Tidy, folderName, customName, cleanTargets, migratePrefs } = require('../../server/tidy.js');
const { tmp, touch, scanned, sleep, until } = require('../support.js');

/** A library over a media folder holding the given files (paths relative to it, with "/"), and a Tidy over that. */
async function world(spec, { ops, busy } = {}) {
  const t = tmp();
  const media = path.join(t.dir, 'media');
  for (const f of spec) touch(path.join(media, ...f.split('/')));
  const dataDir = path.join(t.dir, 'data');
  const lib = new Library(dataDir);
  lib.watchDelay = 150;
  await lib.addRoot(media);
  await scanned(lib);
  const migrated = [];
  const tidy = new Tidy({ lib, dataDir, ops, busy, migrate: async (m) => migrated.push(m) });
  const here = (...p) => path.join(media, ...p.join('/').split('/'));
  const w = {
    t, lib, media, tidy, migrated, here,
    id: (rel) => [...lib.items.values()].find((i) => i.path === here(rel)).id,
    exists: (rel) => fs.existsSync(here(rel)),
    ls: (rel = '') => fs.readdirSync(here(rel)).sort(),
    movie: (rel, title, year, extra = {}) => ({ ids: [w.id(rel)], kind: 'movie', title, year, ...extra }),
    show: (rels, title, year) => ({ ids: rels.map(w.id), kind: 'show', title, year }),
    done: async () => { lib.close(); await lib.saveNow(); t.cleanup(); },
  };
  return w;
}

// ------------------------------------------------------------------ names

test('folder names: "Title (Year)", safe on Windows whatever the title holds', () => {
  assert.equal(folderName('The Matrix', 1999), 'The Matrix (1999)');
  assert.equal(folderName('The Matrix', null), 'The Matrix');
  assert.equal(folderName('Star Wars: A New Hope', 1977), 'Star Wars - A New Hope (1977)');
  assert.equal(folderName('Doctor Who (2005)', 2005), 'Doctor Who (2005)', 'a year already on the title is not doubled');
  assert.equal(folderName('Doctor Who [2005]', 2005), 'Doctor Who (2005)');
  assert.equal(folderName('What?* "Is" <This>|', 2001), 'What Is This (2001)');
  assert.equal(folderName('AC/DC: Live', 1991), 'AC - DC - Live (1991)');
  assert.equal(folderName('Amélie', 2001), 'Amélie (2001)');
  assert.equal(folderName('Ends with dots...   ', 2000), 'Ends with dots (2000)');
  assert.equal(folderName('Tab\tand\nnewline', 2000), 'Tab and newline (2000)');
  assert.equal(folderName('  ', 2000), '');
  assert.equal(folderName('..', 2000), '', 'a title of dots names nothing');
  assert.equal(folderName(undefined, 2000), '');
  assert.equal(folderName('Con', null), 'Con _', 'a name Windows reserves');
  assert.equal(folderName('Nul', 2000), 'Nul (2000)', 'with a year it is no longer a reserved name');
  for (const year of [5, 1869, 2101, 'soon', NaN, 1999.5]) assert.equal(folderName('Film', year), 'Film', `year ${year} is ignored`);
  const long = folderName('x'.repeat(400), 1999);
  assert.ok(long.length <= 150 && long.endsWith('(1999)'), 'long titles are cut, and keep the year');
  assert.equal(customName('  My: Own/Name?.  '), 'My - Own - Name');
});

test('a hostile title can only ever be a harmless folder name: no separators, no way out of the folder', () => {
  for (const title of ['..\\..\\Windows\\System32', '../../etc/passwd', 'C:\\Users\\x', '\\\\server\\share', 'a/../../b', '....//....//']) {
    for (const make of [() => folderName(title, 2000), () => customName(title)]) {
      const name = make();
      assert.ok(!/[\\/:]/.test(name), `${JSON.stringify(title)} -> ${JSON.stringify(name)} has a separator`);
      assert.ok(!name || path.basename(path.join('parent', name)) === name, 'it is one path segment');
      assert.ok(name !== '.' && name !== '..');
    }
  }
});

test('targets from the page are cleaned: bad ids dropped, sizes capped, nothing unexpected kept', () => {
  const got = cleanTargets([
    { ids: ['0123456789abcdef', '0123456789abcdef', '../../x', 7, null, 'ZZZ'], kind: 'show', title: 't'.repeat(999), year: 2001, name: '  ', extra: 'drop me' },
    { ids: 'nope', kind: 'weird', year: '1999' },
    null,
  ]);
  assert.deepEqual(got[0], { ids: ['0123456789abcdef'], kind: 'show', title: 't'.repeat(300), year: 2001, name: '', looked: false });
  assert.deepEqual(got[1], { ids: [], kind: 'movie', title: '', year: 1999, name: '', looked: false });
  assert.deepEqual(got[2], { ids: [], kind: 'movie', title: '', year: null, name: '', looked: false });
  assert.deepEqual(cleanTargets([{ year: null }, { year: '' }, { year: 0 }, { year: -5 }, { year: '1999' }, { year: 'abc' }]).map((x) => x.year), [null, null, null, null, 1999, null], 'unknown stays unknown: null is not the year 0');
  assert.equal(cleanTargets([{ looked: true }, { looked: 'yes' }])[0].looked, true);
  assert.equal(cleanTargets([{ looked: true }, { looked: 'yes' }])[1].looked, false, 'only a real true counts');
  assert.deepEqual(cleanTargets('x'), []);
  assert.equal(cleanTargets(Array.from({ length: 5000 }, () => ({}))).length, 3000);
});

test('preferences keyed by id follow the ids, even when two ids swap places', () => {
  const prefs = { progress: { a: 100, z: 5 }, watched: { a: 1 }, lastPlayed: { b: 2 }, subDelay: { a: -0.5 }, focus: { video: 'a', music: 'album:x' }, other: { a: 'untouched' } };
  migratePrefs(prefs, new Map([['a', 'b'], ['b', 'a']]));
  assert.deepEqual(prefs.progress, { b: 100, z: 5 });
  assert.deepEqual(prefs.watched, { b: 1 });
  assert.deepEqual(prefs.lastPlayed, { a: 2 });
  assert.deepEqual(prefs.subDelay, { b: -0.5 });
  assert.deepEqual(prefs.focus, { video: 'b', music: 'album:x' });
  assert.deepEqual(prefs.other, { a: 'untouched' }, 'only the maps keyed by video id are touched');
  assert.deepEqual(migratePrefs({}, new Map([['a', 'b']])), {});
  assert.equal(migratePrefs(undefined, new Map([['a', 'b']])), undefined);
  assert.doesNotThrow(() => migratePrefs({ progress: { a: 1 } }, new Map([['__proto__', 'x']])));
});

// ------------------------------------------------------------------ planning

test('plan: a movie in a folder named after its release is renamed, with its extras along for the ride', async () => {
  const w = await world(['Heat.1995.1080p.BluRay.x264-GRP/Heat.1995.1080p.BluRay.x264-GRP.mkv', 'Heat.1995.1080p.BluRay.x264-GRP/Subs/en.srt', 'Heat.1995.1080p.BluRay.x264-GRP/Heat.nfo']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat.1995.1080p.BluRay.x264-GRP/Heat.1995.1080p.BluRay.x264-GRP.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'ready');
    assert.equal(p.action, 'rename');
    assert.equal(p.name, 'Heat (1995)');
    assert.equal(p.from, w.here('Heat.1995.1080p.BluRay.x264-GRP'));
    assert.equal(p.to, w.here('Heat (1995)'));
    assert.deepEqual(p.moves, [{ from: p.from, to: p.to, isDir: true }]);
    assert.deepEqual(p.warnings, []);
    assert.ok(w.exists('Heat.1995.1080p.BluRay.x264-GRP/Heat.nfo'), 'planning changes nothing');
    assert.deepEqual(w.migrated, []);
  } finally {
    await w.done();
  }
});

test('plan: an already tidy folder is left alone', async () => {
  const w = await world(['Heat (1995)/Heat.mkv']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat (1995)/Heat.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'same');
    assert.deepEqual(p.moves, []);
    assert.match(p.reason, /Already named “Heat \(1995\)”/);
  } finally {
    await w.done();
  }
});

test('plan: it never renames onto a folder that is already there', async () => {
  const w = await world(['Heat 1995 rip/heat.mkv', 'Heat (1995)/other.mkv']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat 1995 rip/heat.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'blocked');
    assert.match(p.reason, /already exists/);
    assert.deepEqual(p.moves, []);
  } finally {
    await w.done();
  }
});

test('plan: a loose movie in the library folder gets a folder of its own, taking its subtitles and artwork but nobody else\'s', async () => {
  const w = await world([
    'Heat.1995.1080p.mkv', 'Heat.1995.1080p.en.srt', 'Heat.1995.1080p.nfo', 'Heat.1995.1080p-poster.jpg', 'Heat.1995.1080p.mkv.part',
    'Heat.1995.1080p.2.srt', 'Heat.1995.1080p Remastered.srt', // the player shows these for it too: its name, then a separator
    'Ronin.1998.mkv', 'Ronin.1998.en.srt', 'notes.txt',
  ]);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat.1995.1080p.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'ready');
    assert.equal(p.action, 'organize');
    assert.equal(p.to, w.here('Heat (1995)'));
    assert.deepEqual(p.created, [w.here('Heat (1995)')]);
    const moved = p.moves.map((m) => path.basename(m.from)).sort();
    assert.deepEqual(moved, ['Heat.1995.1080p Remastered.srt', 'Heat.1995.1080p-poster.jpg', 'Heat.1995.1080p.2.srt', 'Heat.1995.1080p.en.srt', 'Heat.1995.1080p.mkv', 'Heat.1995.1080p.nfo']);
    assert.ok(p.moves.every((m) => !m.isDir && path.dirname(m.to) === p.to));
    assert.equal(p.files, 6);
  } finally {
    await w.done();
  }
});

test('plan: a video\'s subtitles are not taken by a shorter-named video beside it', async () => {
  const w = await world(['Alien.mkv', 'Alien.en.srt', 'Alien 3.mkv', 'Alien 3.en.srt', 'Alien 3.fr.srt', 'Alien 3.nfo', 'Alien.nfo']);
  try {
    const [a] = await w.tidy.plan([w.movie('Alien.mkv', 'Alien', 1979)]);
    assert.deepEqual(a.moves.map((m) => path.basename(m.from)).sort(), ['Alien.en.srt', 'Alien.mkv', 'Alien.nfo']);
    const [b] = await w.tidy.plan([w.movie('Alien 3.mkv', 'Alien 3', 1992)]);
    assert.deepEqual(b.moves.map((m) => path.basename(m.from)).sort(), ['Alien 3.en.srt', 'Alien 3.fr.srt', 'Alien 3.mkv', 'Alien 3.nfo']);
  } finally {
    await w.done();
  }
});

test('plan: in a collection folder a movie gets a folder inside it, but a folder with only versions of one movie is not touched', async () => {
  const w = await world(['Action/Heat.1995.mkv', 'Action/Ronin.1998.mkv', 'Cuts/Heat.1080p.mkv', 'Cuts/Heat.4K.mkv']);
  try {
    const [c] = await w.tidy.plan([w.movie('Action/Heat.1995.mkv', 'Heat', 1995)]);
    assert.equal(c.status, 'ready');
    assert.equal(c.action, 'organize');
    assert.equal(c.to, w.here('Action', 'Heat (1995)'));
    const [v] = await w.tidy.plan([w.movie('Cuts/Heat.1080p.mkv', 'Heat', 1995)]);
    assert.equal(v.status, 'blocked');
    assert.match(v.reason, /more than one version/);
  } finally {
    await w.done();
  }
});

test('plan: a movie in a CD1 folder renames the movie\'s folder, not the CD folder', async () => {
  const w = await world(['Heat.1995.rip/CD1/heat-cd1.mkv']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat.1995.rip/CD1/heat-cd1.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'ready');
    assert.equal(p.from, w.here('Heat.1995.rip'));
    assert.equal(p.to, w.here('Heat (1995)'));
  } finally {
    await w.done();
  }
});

test('plan: a show\'s folder (season folders and all) is renamed, however the seasons are named', async () => {
  const w = await world([
    'The.Expanse.1080p.WEB/Season 1/The.Expanse.S01E01.mkv', 'The.Expanse.1080p.WEB/Season 1/The.Expanse.S01E02.mkv',
    'The.Expanse.1080p.WEB/S2/The.Expanse.S02E01.mkv', 'The.Expanse.1080p.WEB/extras/readme.txt',
  ]);
  try {
    const eps = ['Season 1/The.Expanse.S01E01.mkv', 'Season 1/The.Expanse.S01E02.mkv', 'S2/The.Expanse.S02E01.mkv'].map((f) => `The.Expanse.1080p.WEB/${f}`);
    const [p] = await w.tidy.plan([w.show(eps, 'The Expanse', 2015)]);
    assert.equal(p.status, 'ready');
    assert.equal(p.action, 'rename');
    assert.equal(p.from, w.here('The.Expanse.1080p.WEB'));
    assert.equal(p.to, w.here('The Expanse (2015)'));
  } finally {
    await w.done();
  }
});

test('plan: loose episodes are filed into "Show (Year)/Season NN", specials into "Specials"', async () => {
  const w = await world(['Dark.S01E01.mkv', 'Dark.S01E01.en.srt', 'Dark.S01E02.mkv', 'Dark.S02E01.mkv', 'Dark.S00E01.mkv', 'Other.Show.S01E01.mkv']);
  try {
    const [p] = await w.tidy.plan([w.show(['Dark.S01E01.mkv', 'Dark.S01E02.mkv', 'Dark.S02E01.mkv', 'Dark.S00E01.mkv'], 'Dark', 2017)]);
    assert.equal(p.status, 'ready');
    assert.equal(p.action, 'organize');
    const dest = Object.fromEntries(p.moves.map((m) => [path.basename(m.from), path.relative(w.media, path.dirname(m.to)).split(path.sep).join('/')]));
    assert.deepEqual(dest, {
      'Dark.S01E01.mkv': 'Dark (2017)/Season 01', 'Dark.S01E01.en.srt': 'Dark (2017)/Season 01', 'Dark.S01E02.mkv': 'Dark (2017)/Season 01',
      'Dark.S02E01.mkv': 'Dark (2017)/Season 02', 'Dark.S00E01.mkv': 'Dark (2017)/Specials',
    });
    assert.deepEqual(p.created.map((d) => path.relative(w.media, d).split(path.sep).join('/')), ['Dark (2017)', 'Dark (2017)/Season 01', 'Dark (2017)/Season 02', 'Dark (2017)/Specials']);
  } finally {
    await w.done();
  }
});

test('plan: filing episodes into a show folder that already exists adds to it, and never replaces a file', async () => {
  const w = await world(['Dark (2017)/Season 01/Dark.S01E01.mkv', 'Dark.S01E02.mkv', 'Dark.S01E03.mkv']);
  try {
    const [ok] = await w.tidy.plan([w.show(['Dark.S01E02.mkv'], 'Dark', 2017)]);
    assert.equal(ok.status, 'ready');
    assert.ok(ok.warnings.some((x) => /Adds to the folder/.test(x)));
    assert.deepEqual(ok.created, [], 'the folders are already there');
    touch(w.here('Dark (2017)/Season 01/Dark.S01E03.mkv'), 'different');
    const [clash] = await w.tidy.plan([w.show(['Dark.S01E03.mkv'], 'Dark', 2017)]);
    assert.equal(clash.status, 'blocked');
    assert.match(clash.reason, /already in “Dark \(2017\)”/);
  } finally {
    await w.done();
  }
});

test('plan: episodes spread over several folders are not guessed at', async () => {
  const w = await world(['Dark S1/Dark.S01E01.mkv', 'Dark S2/Dark.S02E01.mkv']);
  try {
    const [p] = await w.tidy.plan([w.show(['Dark S1/Dark.S01E01.mkv', 'Dark S2/Dark.S02E01.mkv'], 'Dark', 2017)]);
    assert.equal(p.status, 'blocked');
    assert.match(p.reason, /several different folders/);
  } finally {
    await w.done();
  }
});

test('plan: library folders themselves are never renamed, and neither is a folder holding one', async () => {
  const t = tmp();
  try {
    touch(path.join(t.dir, 'Movies.2020/Heat.1995.mkv'));
    touch(path.join(t.dir, 'Movies.2020/inner/Ronin.1998.mkv'));
    const lib = new Library(path.join(t.dir, 'data'));
    await lib.addRoot(path.join(t.dir, 'Movies.2020')); // the folder a movie sits in is itself a library folder
    await scanned(lib);
    const tidy = new Tidy({ lib, dataDir: path.join(t.dir, 'data') });
    const heat = [...lib.items.values()].find((i) => /Heat/.test(i.path));
    const [p] = await tidy.plan([{ ids: [heat.id], kind: 'movie', title: 'Heat', year: 1995 }]);
    assert.notEqual(p.action, 'rename', 'the library folder is not renamed');
    assert.ok(p.action === 'organize' || p.status === 'blocked');
    // …and a parent of a library folder is out of reach too
    const lib2 = new Library(path.join(t.dir, 'data2'));
    await lib2.addRoot(path.join(t.dir, 'Movies.2020', 'inner'));
    lib2.roots.push(path.join(t.dir, 'Movies.2020', 'inner'));
    await scanned(lib2);
    const inner = [...lib2.items.values()][0];
    const tidy2 = new Tidy({ lib: lib2, dataDir: path.join(t.dir, 'data2') });
    const [q] = await tidy2.plan([{ ids: [inner.id], kind: 'movie', title: 'Ronin', year: 1998 }]);
    assert.notEqual(q.action, 'rename');
    lib.close();
    lib2.close();
  } finally {
    t.cleanup();
  }
});

test('plan: two items cannot both claim one folder name, and things that are not movies or shows are refused', async () => {
  const w = await world(['Heat 1995 a/heat.mkv', 'Heat 1995 b/heat.mkv', 'VID_20200101_120000.mp4', 'Heat 1995 a/song.mp3']);
  try {
    const [first, second] = await w.tidy.plan([w.movie('Heat 1995 a/heat.mkv', 'Heat', 1995), w.movie('Heat 1995 b/heat.mkv', 'Heat', 1995)]);
    assert.equal(first.status, 'blocked', 'folder "Heat 1995 a" also holds a song from the library');
    const [one, two] = await w.tidy.plan([w.movie('Heat 1995 b/heat.mkv', 'Heat', 1995), w.movie('Heat 1995 b/heat.mkv', 'Heat', 1995)]);
    assert.equal(one.status, 'ready');
    assert.equal(two.status, 'blocked');
    assert.match(two.reason, /same folder name|same name/);
    assert.equal(second.status, 'ready');
    const [clip, gone, music, empty, asShow] = await w.tidy.plan([
      w.movie('VID_20200101_120000.mp4', 'Clip', 2020),
      { ids: ['0123456789abcdef'], kind: 'movie', title: 'Ghost', year: 2000 },
      { ids: [w.id('Heat 1995 a/song.mp3')], kind: 'movie', title: 'Song', year: 2000 },
      w.movie('Heat 1995 b/heat.mkv', '', null),
      w.show(['Heat 1995 b/heat.mkv'], 'Heat', 1995),
    ]);
    assert.match(clip.reason, /home video/);
    assert.match(gone.reason, /no longer in the library/);
    assert.match(music.reason, /no longer in the library/, 'music is not a video');
    assert.match(empty.reason, /no title/);
    assert.match(asShow.reason, /not all episodes/);
  } finally {
    await w.done();
  }
});

test('plan: a name the user typed replaces the proposed one, and is made safe', async () => {
  const w = await world(['Heat.1995/heat.mkv']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat.1995/heat.mkv', 'Heat', 1995, { name: '  Heat: Director\'s Cut / 1995?  ' })]);
    assert.equal(p.name, 'Heat - Director\'s Cut - 1995');
    assert.equal(p.to, w.here('Heat - Director\'s Cut - 1995'));
  } finally {
    await w.done();
  }
});

test('plan: folders managed by Sonarr or Radarr, or being downloaded into, come with a warning', async () => {
  const w = await world(['Sonarr/Dark.S01E01.1080p/Dark.S01E01.mkv', 'Downloads/Heat.1995/heat.mkv', 'Plain/Ronin.1998/ronin.mkv']);
  try {
    const [s] = await w.tidy.plan([w.show(['Sonarr/Dark.S01E01.1080p/Dark.S01E01.mkv'], 'Dark', 2017)]);
    assert.equal(s.status, 'ready');
    assert.ok(s.warnings.some((x) => /Sonarr or Radarr/.test(x)));
    const [d] = await w.tidy.plan([w.movie('Downloads/Heat.1995/heat.mkv', 'Heat', 1995)]);
    assert.ok(d.warnings.some((x) => /downloads folder/.test(x)));
    const [p] = await w.tidy.plan([w.movie('Plain/Ronin.1998/ronin.mkv', 'Ronin', 1998)]);
    assert.deepEqual(p.warnings, []);
  } finally {
    await w.done();
  }
});

test('plan: a Subs folder beside loose files is flagged, because it will not travel with them', async () => {
  const w = await world(['Heat.1995.mkv', 'Subs/Heat.1995.en.srt']);
  try {
    const [p] = await w.tidy.plan([w.movie('Heat.1995.mkv', 'Heat', 1995)]);
    assert.ok(p.warnings.some((x) => /Subs folder/.test(x)));
  } finally {
    await w.done();
  }
});

test('plan: a path that would be too long for Windows is refused', async () => {
  const w = await world(['Heat.1995/heat.mkv']);
  try {
    const id = w.id('Heat.1995/heat.mkv');
    const it = w.lib.get(id);
    it.path = path.join(path.dirname(it.path), `${'x'.repeat(210)}.mkv`); // as the library would hold a very long file name
    const [p] = await w.tidy.plan([{ ids: [id], kind: 'movie', title: 'Heat', year: 1995 }]);
    assert.equal(p.status, 'blocked');
    assert.match(p.reason, /too long/);
  } finally {
    await w.done();
  }
});

// ------------------------------------------------------------------ doing it

test('apply: renames the folder on disk, and the library keeps everything it knew about the file', async () => {
  const w = await world(['Heat.1995.1080p-GRP/Heat.mkv', 'Heat.1995.1080p-GRP/Heat.en.srt', 'Ronin.1998/ronin.mkv']);
  try {
    const old = w.id('Heat.1995.1080p-GRP/Heat.mkv');
    const it = w.lib.get(old);
    it.fetched = { src: 'tmdb', at: 1, found: true };
    it.meta = { title: 'Heat', year: 1995, src: 'tmdb' };
    it.cf = 'jpg';
    fs.writeFileSync(path.join(w.lib.coverDir, `${old}.jpg`), 'frame');
    it.pf = 'jpg';
    fs.writeFileSync(path.join(w.lib.coverDir, `${old}.poster.jpg`), 'poster');
    it.duration = 170;
    const added = it.added;

    const out = await w.tidy.apply([w.movie('Heat.1995.1080p-GRP/Heat.mkv', 'Heat', 1995)]);
    assert.deepEqual([out.folders, out.files, out.failed, out.skipped], [1, 0, [], 0]);
    assert.deepEqual(w.ls(), ['Heat (1995)', 'Ronin.1998']);
    assert.deepEqual(w.ls('Heat (1995)'), ['Heat.en.srt', 'Heat.mkv'], 'everything in the folder came along');

    const fresh = w.id('Heat (1995)/Heat.mkv');
    assert.notEqual(fresh, old, 'the id comes from the path, so it changed');
    assert.deepEqual(out.idMap, { [old]: fresh });
    assert.equal(w.lib.get(old), undefined);
    const moved = w.lib.get(fresh);
    assert.deepEqual([moved.fetched.src, moved.meta.title, moved.duration, moved.added], ['tmdb', 'Heat', 170, added], 'fetched details and the rest were carried along');
    assert.deepEqual(moved.parsed, { type: 'movie', title: 'Heat' }, 'what is guessed from the path is guessed again, from the new path');
    assert.equal(w.lib.get(fresh).path, w.here('Heat (1995)/Heat.mkv'));
    assert.equal(fs.readFileSync(path.join(w.lib.coverDir, `${fresh}.jpg`), 'utf8'), 'frame', 'thumbnail renamed with it');
    assert.equal(fs.readFileSync(path.join(w.lib.coverDir, `${fresh}.poster.jpg`), 'utf8'), 'poster', 'and the poster');
    assert.ok(!fs.existsSync(path.join(w.lib.coverDir, `${old}.jpg`)));
    assert.equal(w.migrated.length, 1, 'what else is keyed by id was told');
    assert.equal(w.migrated[0].get(old), fresh);
  } finally {
    await w.done();
  }
});

test('apply: the library\'s own rescan afterwards finds nothing new, so nothing is forgotten', async () => {
  const w = await world(['Heat.1995-GRP/Heat.mkv']);
  try {
    const old = w.id('Heat.1995-GRP/Heat.mkv');
    w.lib.get(old).fetched = { src: 'tmdb', at: 1, found: true };
    await w.tidy.apply([w.movie('Heat.1995-GRP/Heat.mkv', 'Heat', 1995)]);
    const fresh = w.id('Heat (1995)/Heat.mkv');
    w.lib.scan();
    await sleep(50);
    await scanned(w.lib);
    assert.equal(w.lib.items.size, 1);
    assert.equal(w.lib.get(fresh).fetched.src, 'tmdb', 'the scan kept the record: same size and time, new place');
  } finally {
    await w.done();
  }
});

test('apply: a scan that was due while it worked runs afterwards, not in the middle', async () => {
  const w = await world(['Heat.1995-GRP/Heat.mkv']);
  try {
    let during = null;
    const real = w.tidy.ops.rename;
    w.tidy.ops.rename = async (a, b) => {
      w.lib.scan(); // the watcher noticing the change, mid-rename
      during = w.lib.scanning;
      return real(a, b);
    };
    await w.tidy.apply([w.movie('Heat.1995-GRP/Heat.mkv', 'Heat', 1995)]);
    assert.equal(during, false, 'no scan ran while the files were moving');
    await sleep(50);
    await scanned(w.lib);
    assert.equal(w.lib.items.size, 1);
  } finally {
    await w.done();
  }
});

test('apply: filing loose files moves them with their subtitles into new folders, and undo puts every one back', async () => {
  const w = await world(['Dark.S01E01.mkv', 'Dark.S01E01.en.srt', 'Dark.S02E01.mkv', 'Heat.1995.mkv', 'Heat.1995.nfo']);
  try {
    const before = w.ls();
    const targets = [w.show(['Dark.S01E01.mkv', 'Dark.S02E01.mkv'], 'Dark', 2017), w.movie('Heat.1995.mkv', 'Heat', 1995)];
    const out = await w.tidy.apply(targets);
    assert.equal(out.failed.length, 0);
    assert.deepEqual(w.ls(), ['Dark (2017)', 'Heat (1995)']);
    assert.deepEqual(w.ls('Dark (2017)'), ['Season 01', 'Season 02']);
    assert.deepEqual(w.ls('Dark (2017)/Season 01'), ['Dark.S01E01.en.srt', 'Dark.S01E01.mkv']);
    assert.deepEqual(w.ls('Heat (1995)'), ['Heat.1995.mkv', 'Heat.1995.nfo']);
    assert.equal(out.files, 5);
    assert.equal(w.lib.get(w.id('Dark (2017)/Season 02/Dark.S02E01.mkv')).parsed.season, 2);

    const history = await w.tidy.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].id, out.batch);
    assert.equal(history[0].files, 5);
    const undone = await w.tidy.undo(out.batch);
    assert.deepEqual([undone.undone, undone.failed], [2, []]);
    assert.deepEqual(w.ls(), before, 'the folder is exactly as it was, with the folders we made removed again');
    assert.ok(w.lib.get(w.id('Dark.S01E01.mkv')), 'and the library points at the old places again');
    assert.deepEqual(await w.tidy.history(), []);
  } finally {
    await w.done();
  }
});

test('undo: a renamed folder gets its old name back; if that is no longer possible it is left alone and said so', async () => {
  const w = await world(['Heat.1995-GRP/Heat.mkv', 'Ronin.1998-X/ronin.mkv']);
  try {
    const a = await w.tidy.apply([w.movie('Heat.1995-GRP/Heat.mkv', 'Heat', 1995)]);
    const b = await w.tidy.apply([w.movie('Ronin.1998-X/ronin.mkv', 'Ronin', 1998)]);
    assert.deepEqual(w.ls(), ['Heat (1995)', 'Ronin (1998)']);

    fs.renameSync(w.here('Ronin (1998)'), w.here('Ronin renamed by hand')); // someone changed it since
    const bad = await w.tidy.undo(b.batch);
    assert.equal(bad.undone, 0);
    assert.match(bad.failed[0], /moved or deleted/);
    assert.ok(w.exists('Ronin renamed by hand'), 'nothing was touched');
    assert.equal((await w.tidy.history()).length, 2, 'it stays in the list');

    fs.mkdirSync(w.here('Heat.1995-GRP')); // the old name is taken
    const taken = await w.tidy.undo(a.batch);
    assert.equal(taken.undone, 0);
    assert.match(taken.failed[0], /already there/);
    assert.ok(w.exists('Heat (1995)/Heat.mkv'));
    fs.rmdirSync(w.here('Heat.1995-GRP'));
    assert.equal((await w.tidy.undo(a.batch)).undone, 1, 'once it is free, undo works');
    assert.ok(w.exists('Heat.1995-GRP/Heat.mkv'));
    await assert.rejects(w.tidy.undo('0000000000'), /no longer in the undo list/);
  } finally {
    await w.done();
  }
});

test('apply: if something goes wrong halfway, everything done so far is put back and nothing else is touched', async () => {
  const w = await world(['Heat.1995.mkv', 'Heat.1995.en.srt', 'Heat.1995.nfo', 'Ronin.1998-X/ronin.mkv']);
  try {
    const real = w.tidy.ops.rename;
    let n = 0;
    w.tidy.ops.rename = async (a, b) => {
      if (/Heat/.test(path.basename(a)) && ++n === 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return real(a, b);
    };
    const before = w.ls();
    const out = await w.tidy.apply([w.movie('Heat.1995.mkv', 'Heat', 1995), w.movie('Ronin.1998-X/ronin.mkv', 'Ronin', 1998)]);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].index, 0);
    assert.match(out.failed[0].reason, /in use/);
    assert.ok(w.exists('Heat.1995.mkv') && w.exists('Heat.1995.en.srt') && w.exists('Heat.1995.nfo'), 'the files already moved were put back');
    assert.ok(!w.exists('Heat (1995)'), 'and the folder made for them removed');
    assert.ok(w.exists('Ronin (1998)/ronin.mkv'), 'the other item, which did not fail, still went through');
    assert.deepEqual(w.ls().filter((x) => !/Ronin/.test(x)), before.filter((x) => !/Ronin/.test(x)));
    assert.ok(w.lib.get(w.id('Heat.1995.mkv')), 'the library still points at the old file');
    assert.equal((await w.tidy.history())[0].folders, 1, 'only what really happened is in the undo list');
  } finally {
    await w.done();
  }
});

test('apply: a folder that is in use (Windows refuses to rename it) is reported and left exactly as it was', async () => {
  const w = await world(['Heat.1995-GRP/Heat.mkv']);
  try {
    w.tidy.ops.rename = async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    const out = await w.tidy.apply([w.movie('Heat.1995-GRP/Heat.mkv', 'Heat', 1995)]);
    assert.equal(out.batch, '');
    assert.match(out.failed[0].reason, /close any player/);
    assert.ok(w.exists('Heat.1995-GRP/Heat.mkv'));
    assert.deepEqual(await w.tidy.history(), []);
  } finally {
    await w.done();
  }
});

test('apply: never overwrites a file that appeared after the plan was made', async () => {
  const w = await world(['Heat.1995.mkv']);
  try {
    const from = w.here('Heat.1995.mkv');
    fs.mkdirSync(w.here('Heat (1995)'));
    touch(w.here('Heat (1995)/Heat.1995.mkv'), 'precious');
    await assert.rejects(w.tidy._execute({ created: [], moves: [{ from, to: w.here('Heat (1995)/Heat.1995.mkv'), isDir: false }] }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(w.here('Heat (1995)/Heat.1995.mkv'), 'utf8'), 'precious');
    assert.ok(w.exists('Heat.1995.mkv'));
    const [p] = await w.tidy.plan([w.movie('Heat.1995.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'blocked', 'and a plan made now says so');
    await assert.rejects(w.tidy._execute({ created: [], moves: [{ from: w.here('missing.mkv'), to: w.here('x.mkv'), isDir: false }] }), { code: 'ENOENT' });
  } finally {
    await w.done();
  }
});

test('apply: refuses while a lookup is running, and a hostile name cannot make a folder anywhere but beside the original', async () => {
  let reason = 'Wait for the artwork lookup to finish first';
  const w = await world(['Heat.1995/heat.mkv'], { busy: () => reason });
  try {
    await assert.rejects(w.tidy.apply([w.movie('Heat.1995/heat.mkv', 'Heat', 1995)]), { status: 409 });
    assert.ok(w.exists('Heat.1995/heat.mkv'));
    reason = '';
    const out = await w.tidy.apply([w.movie('Heat.1995/heat.mkv', 'x', 1995, { name: '..\\..\\..\\Windows\\evil' })]);
    assert.equal(out.failed.length, 0);
    const outside = fs.readdirSync(path.dirname(w.media));
    assert.deepEqual(outside.sort(), ['data', 'media'], 'nothing appeared outside the library');
    assert.equal(w.ls().length, 1);
    assert.ok(!/[\\/]/.test(w.ls()[0]));
  } finally {
    await w.done();
  }
});

test('apply: a case-only rename works (on Windows, where Heat and heat are the same folder)', { skip: process.platform !== 'win32' }, async () => {
  const w = await world(['heat (1995)/Heat.mkv']);
  try {
    const [p] = await w.tidy.plan([w.movie('heat (1995)/Heat.mkv', 'Heat', 1995)]);
    assert.equal(p.status, 'ready', 'it is not "already exists": it is the same folder');
    const out = await w.tidy.apply([w.movie('heat (1995)/Heat.mkv', 'Heat', 1995)]);
    assert.equal(out.failed.length, 0);
    assert.deepEqual(w.ls(), ['Heat (1995)']);
  } finally {
    await w.done();
  }
});

test('the undo list survives a restart and keeps only the last ten changes', async () => {
  const w = await world(Array.from({ length: 12 }, (_, i) => `Movie.${2000 + i}-x/m${i}.mkv`));
  try {
    for (let i = 0; i < 12; i++) await w.tidy.apply([w.movie(`Movie.${2000 + i}-x/m${i}.mkv`, `Movie ${i}`, 2000 + i)]);
    const list = await w.tidy.history();
    assert.equal(list.length, 10);
    assert.match(list[0].label, /^Movie 11 \(2011\)$/, 'newest first');
    const again = new Tidy({ lib: w.lib, dataDir: path.join(w.t.dir, 'data') });
    assert.deepEqual(await again.history(), list);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.t.dir, 'data', 'tidy-undo.json'), 'utf8')).batches.length, 10);
  } finally {
    await w.done();
  }
});

test('library: moving paths carries records, covers and album links; unrelated items are untouched', async () => {
  const w = await world(['Folder/a.mkv', 'Folder/b.mkv', 'Other/c.mkv']);
  try {
    const a = w.id('Folder/a.mkv');
    const c = w.id('Other/c.mkv');
    w.lib.get(a).fetched = { src: 'x', at: 1, found: true, art: a };
    fs.renameSync(w.here('Folder'), w.here('Renamed'));
    const map = await w.lib.movePaths([{ from: w.here('Folder'), to: w.here('Renamed'), isDir: true }]);
    assert.equal(map.size, 2);
    assert.ok(!map.has(c));
    assert.equal(w.lib.get(c).path, w.here('Other/c.mkv'));
    assert.equal(w.lib.get(map.get(a)).fetched.art, map.get(a), 'a link to another item follows too');
    assert.equal(w.lib.items.size, 3);
    // a case-insensitive match of the old folder on Windows
    if (process.platform === 'win32') assert.equal((await w.lib.movePaths([{ from: w.here('RENAMED'), to: w.here('Folder'), isDir: true }])).size, 2);
  } finally {
    await w.done();
  }
});

test('library: paused() waits for a running scan, holds new ones back, and runs the deferred one after', async () => {
  const w = await world(['a.mkv']);
  try {
    w.lib.scan();
    const log = [];
    const run = w.lib.paused(async () => {
      log.push(`start scanning=${w.lib.scanning}`);
      w.lib.scan();
      w.lib.scan();
      await sleep(40);
      log.push(`end scanning=${w.lib.scanning}`);
      return 'result';
    });
    assert.equal(await run, 'result');
    assert.deepEqual(log, ['start scanning=false', 'end scanning=false']);
    await until(() => !w.lib.scanning);
    assert.equal(w.lib._deferred, false);
    await assert.rejects(w.lib.paused(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(w.lib._hold, 0, 'a failing job still releases the hold');
  } finally {
    await w.done();
  }
});

test('plan: when only a file name was known, the folder\'s own name fills in the year and the capitals, and a good name is not made worse', async () => {
  const w = await world(['Ronin.1998.720p-RARBG/ronin.mp4', 'Se7en (1995)/se7en.mkv', 'The.Expanse.2015.1080p.WEB/Season 1/The.Expanse.S01E01.mkv', 'Heat Collection 1995/heat.mkv']);
  try {
    // what the page knows for a movie not looked up yet: the file name's title, no year
    const [ronin] = await w.tidy.plan([w.movie('Ronin.1998.720p-RARBG/ronin.mp4', 'ronin', null)]);
    assert.equal(ronin.name, 'Ronin (1998)', 'the year and the capital R come from the folder');
    assert.equal(ronin.to, w.here('Ronin (1998)'));
    const [seven] = await w.tidy.plan([w.movie('Se7en (1995)/se7en.mkv', 'se7en', null)]);
    assert.equal(seven.status, 'same', 'a folder that is already tidy is left as it is, not turned into "se7en"');
    assert.equal(seven.name, 'Se7en (1995)');
    const [expanse] = await w.tidy.plan([w.show(['The.Expanse.2015.1080p.WEB/Season 1/The.Expanse.S01E01.mkv'], 'The Expanse', null)]);
    assert.equal(expanse.name, 'The Expanse (2015)', 'a show too');
    const [mixed] = await w.tidy.plan([w.movie('Heat Collection 1995/heat.mkv', 'Heat', null)]);
    assert.equal(mixed.name, 'Heat (1995)', 'a different title in the folder: the page\'s title is kept, the folder only adds the year');
    // once it was looked up, the lookup is what counts
    const [looked] = await w.tidy.plan([w.movie('Ronin.1998.720p-RARBG/ronin.mp4', 'Ronin', 1999, { looked: true })]);
    assert.equal(looked.name, 'Ronin (1999)');
    const [typed] = await w.tidy.plan([w.movie('Ronin.1998.720p-RARBG/ronin.mp4', 'ronin', null, { name: 'My Ronin' })]);
    assert.equal(typed.name, 'My Ronin', 'and so is a name somebody typed');
  } finally {
    await w.done();
  }
});

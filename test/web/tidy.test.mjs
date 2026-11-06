// The page's side of "Tidy folder names": requests built from shelf entries, and the local preferences kept in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionText, detailText, followIds, forServer, isTidyable, migrateIds, pathText, summarize, tidyTarget, tidyTargets } from '../../web/js/tidy.js';
import { buildCollections } from '../../web/js/library.js';

const video = (id, name, parsed, over = {}) => ({ id, kind: 'video', ext: 'mkv', name, title: name, size: 1, mtime: 1, added: 1, dir: 'D:\\Media', parsed, fetched: 0, ...over });

test('a movie entry becomes a request named after its looked-up title and year, else the file name\'s', () => {
  const shelf = buildCollections([
    video('a1', 'Heat.1995.1080p', { type: 'movie', title: 'Heat', year: 1995 }, { fetched: 2, meta: { title: 'Heat', year: 1995, src: 'tmdb' } }),
    video('b1', 'ronin', { type: 'movie', title: 'Ronin' }),
    video('c1', 'VID_20200101_120000', { type: 'clip', title: 'VID 20200101 120000' }),
    video('d1', 'Dark.S01E01', { type: 'episode', title: 'Dark', show: 'Dark', season: 1, episode: 1, year: 2017 }, { fetched: 2, meta: { show: { name: 'Dark', year: 2017 }, src: 'tvmaze' } }),
    video('d2', 'Dark.S01E02', { type: 'episode', title: 'Dark', show: 'Dark', season: 1, episode: 2, year: 2017 }, { fetched: 2, meta: { show: { name: 'Dark', year: 2017 }, src: 'tvmaze' } }),
  ]);
  const entries = [...shelf.video, ...shelf.unmatched];
  const targets = tidyTargets(entries);
  const by = Object.fromEntries(targets.map((t) => [t.title, t]));
  assert.deepEqual(by.Heat, { ids: ['a1'], kind: 'movie', title: 'Heat', year: 1995, label: 'Heat (1995)', looked: true });
  assert.deepEqual([by.Ronin.year, by.Ronin.looked], [null, false], 'no year known, and not looked up: the name comes from the file');
  assert.deepEqual([by.Dark.kind, by.Dark.ids, by.Dark.year, by.Dark.looked], ['show', ['d1', 'd2'], 2017, true]);
  assert.equal(targets.length, 3, 'the home clip is not offered');
  assert.equal(isTidyable(entries.find((e) => e.id === 'c1')), false);
  assert.equal(isTidyable(null), false);
  assert.equal(isTidyable({ kind: 'show', episodes: [] }), false);
  assert.deepEqual(tidyTargets(undefined), []);
});

test('a show with no looked-up year takes the year from its episodes\' file names', () => {
  const t = tidyTarget({ kind: 'show', title: 'Doctor Who', year: undefined, fetched: 0, episodes: [video('e1', 'x', { type: 'episode', show: 'Doctor Who', season: 1, episode: 1 }), video('e2', 'y', { type: 'episode', show: 'Doctor Who', season: 1, episode: 2, year: 2005 })] });
  assert.equal(t.year, 2005);
});

test('only the fields the server needs are sent, and a typed name only when there is one', () => {
  const t = { ids: ['a'], kind: 'movie', title: 'Heat', year: 1995, label: 'Heat (1995)', looked: true };
  assert.deepEqual(forServer(t), { ids: ['a'], kind: 'movie', title: 'Heat', year: 1995, looked: true });
  assert.deepEqual(forServer({ ...t, name: 'Heat - Cut', looked: false }), { ids: ['a'], kind: 'movie', title: 'Heat', year: 1995, looked: false, name: 'Heat - Cut' });
  assert.deepEqual(followIds(t, { a: 'z' }).ids, ['z']);
  assert.deepEqual(followIds(t, { other: 'z' }).ids, ['a']);
  assert.deepEqual(followIds(t, undefined).ids, ['a']);
});

test('plans are described in plain words', () => {
  const rename = { status: 'ready', action: 'rename', from: 'D:\\Movies\\Heat.1995.1080p', to: 'D:\\Movies\\Heat (1995)', name: 'Heat (1995)', files: 0, warnings: [] };
  const organize = { status: 'ready', action: 'organize', from: 'D:\\Movies', to: 'D:\\Movies\\Heat (1995)', name: 'Heat (1995)', files: 3 };
  assert.deepEqual([actionText(rename), detailText(rename)], ['rename folder', 'was “Heat.1995.1080p”']);
  assert.deepEqual([actionText(organize), detailText(organize)], ['put in its own folder', '3 files move']);
  assert.equal(detailText({ ...organize, files: 1 }), '1 file moves');
  assert.equal(pathText(rename), 'D:\\Movies\\Heat.1995.1080p  →  Heat (1995)');
  assert.equal(pathText(organize), 'D:\\Movies  →  new folder Heat (1995)');
  assert.deepEqual([actionText({ status: 'same' }), detailText({ status: 'same', reason: 'Already named “X”' })], ['already tidy', 'Already named “X”']);
  assert.deepEqual([actionText({ status: 'blocked' }), detailText({ status: 'blocked', reason: 'Folder exists' }), pathText({ status: 'blocked' })], ['cannot be done', 'Folder exists', '']);
  assert.deepEqual(summarize([{ status: 'ready' }, { status: 'ready' }, { status: 'same' }, { status: 'blocked' }]), { ready: 2, same: 1, blocked: 1 });
});

test('the page\'s preferences follow renamed ids, including ones still waiting to be sent, and ids that swap', () => {
  const prefs = { progress: { a: 100, z: 1 }, watched: { a: 5 }, lastPlayed: { b: 7 }, subDelay: { a: 0.5 }, focus: { video: 'a', music: 'album:q' }, sort: { a: 'x' } };
  migrateIds(prefs, { a: 'b', b: 'a' });
  assert.deepEqual(prefs.progress, { b: 100, z: 1 });
  assert.deepEqual(prefs.watched, { b: 5 });
  assert.deepEqual(prefs.lastPlayed, { a: 7 });
  assert.deepEqual(prefs.subDelay, { b: 0.5 });
  assert.deepEqual(prefs.focus, { video: 'b', music: 'album:q' });
  assert.deepEqual(prefs.sort, { a: 'x' }, 'unrelated maps are left alone');
  const pending = { progress: { old1: null, old2: 30 }, watched: { old1: 9 } }; // a queued patch: null means "forget this"
  migrateIds(pending, { old1: 'new1', old2: 'new2' });
  assert.deepEqual(pending, { progress: { new1: null, new2: 30 }, watched: { new1: 9 } });
  assert.deepEqual(migrateIds({}, { a: 'b' }), {});
  assert.equal(migrateIds(undefined, { a: 'b' }), undefined);
  assert.deepEqual(migrateIds({ progress: { a: 1 } }, {}), { progress: { a: 1 } });
  assert.doesNotThrow(() => migrateIds({ progress: { a: 1 } }, JSON.parse('{"__proto__":"x","constructor":"y"}')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { carriesFiles, droppedPaths, likelyKind } from '../../web/js/dropfolder.js';

test('only a drag that carries files counts: not selected text or a link', () => {
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain', 'Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain'] }), false);
  assert.equal(carriesFiles({ types: [] }), false);
  assert.equal(carriesFiles({}), false);
  assert.equal(carriesFiles(null), false);
});

test('dropped items are placed by the desktop app; anything it cannot place is skipped, and each place is listed once', () => {
  const files = [{ n: 'a' }, { n: 'b' }, { n: 'a-again' }, { n: 'web' }];
  const where = { a: 'D:\\Music', b: 'D:\\Pictures', 'a-again': 'D:\\Music', web: '' };
  assert.deepEqual(droppedPaths({ files }, (f) => where[f.n]), ['D:\\Music', 'D:\\Pictures']);
  assert.deepEqual(droppedPaths({ files }, undefined), [], 'outside the desktop app there is no way to know');
  assert.deepEqual(droppedPaths({ files: [] }, () => 'x'), []);
  assert.deepEqual(droppedPaths(null, () => 'x'), []);
});

test('a folder of pictures is offered as a photo folder first; anything else as music and video', () => {
  assert.equal(likelyKind({ audio: 0, video: 0, image: 40 }), 'photos');
  assert.equal(likelyKind({ audio: 12, video: 0, image: 3 }), 'media');
  assert.equal(likelyKind({ audio: 0, video: 2, image: 40 }), 'media');
  assert.equal(likelyKind({ audio: 0, video: 0, image: 0 }), 'media', 'a folder of folders holds nothing directly');
  assert.equal(likelyKind(undefined), 'media');
});

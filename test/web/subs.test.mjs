import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtDelay, pickTrack, trackDetail, trackLabel } from '../../web/js/subs.js';

const t = (key, lang, extra = {}) => ({ key, lang, kind: 'file', ext: 'srt', supported: true, forced: false, sdh: false, name: '', ...extra });

test('no automatic subtitles unless they were left on', () => {
  assert.equal(pickTrack([t('f0', 'en')], { on: false }), null);
  assert.equal(pickTrack([t('f0', 'en')], {}), null);
});

test('the remembered language is picked, with full dialogue before forced, SDH and commentary tracks', () => {
  const tracks = [t('f0', 'en', { forced: true }), t('f1', 'en', { sdh: true }), t('f2', 'en', { name: 'Director Commentary' }), t('f3', 'en'), t('f4', 'es')];
  assert.equal(pickTrack(tracks, { on: true, lang: 'en' }).key, 'f3');
  assert.equal(pickTrack(tracks, { on: true, lang: 'es' }).key, 'f4');
  assert.equal(pickTrack(tracks.slice(0, 3), { on: true, lang: 'en' }).key, 'f1', 'SDH beats forced-only, and both beat commentary');
  assert.equal(pickTrack(tracks, { on: true, lang: 'fr' }), null);
});

test('with no remembered language, any usable track is chosen; image-based ones never are', () => {
  assert.equal(pickTrack([t('e0', 'en', { supported: false }), t('f1', 'de')], { on: true }).key, 'f1');
  assert.equal(pickTrack([t('e0', 'en', { supported: false })], { on: true }), null);
});

test('track labels name the language and the things that make a track special', () => {
  assert.match(trackLabel(t('f', 'en')), /English/);
  assert.match(trackLabel(t('f', 'en', { forced: true })), /\(forced\)/);
  assert.match(trackLabel(t('f', 'en', { sdh: true })), /\(SDH\)/);
  assert.equal(trackLabel(t('f', null, { name: 'Commentary' })), 'Commentary');
  assert.equal(trackLabel(t('f', null)), 'Subtitles');
  assert.equal(trackLabel(t('e', null, { kind: 'embedded' })), 'Track');
  assert.match(trackDetail(t('e', 'en', { kind: 'embedded', ext: 'pgs', supported: false })), /image-based/);
});

test('the subtitle delay reads as a signed number of seconds', () => {
  assert.deepEqual([fmtDelay(0), fmtDelay(0.5), fmtDelay(-1.25)], ['0.0 s', '+0.5 s', '-1.3 s']);
});

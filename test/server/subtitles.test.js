'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmp, touch } = require('../support.js');
const { parseSubtitle, decodeSubtitle, cleanText, normalizeLang, findSidecars } = require('../../server/subtitles.js');

const srt = (sep) => Buffer.from(['1', '00:00:01,000 --> 00:00:02,000', 'One', sep, '2', '00:00:03,000 --> 00:00:04,000', 'Two', '', '3', '00:00:05,000 --> 00:00:06,000', 'Three'].join('\n'));
const texts = (buf, ext = 'srt') => parseSubtitle(buf, ext).map((c) => c.t);

test('SRT cues are split at blank lines, even ones holding stray spaces or tabs', () => {
  for (const sep of ['', ' ', '\t', '  \t ']) assert.deepEqual(texts(srt(sep)), ['One', 'Two', 'Three'], JSON.stringify(sep));
  const crlf = 'a\r\n00:00:01,000 --> 00:00:02,000\r\nOne\r\n \r\nb\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\n';
  assert.deepEqual(texts(Buffer.from(crlf)), ['One', 'Two']);
});

test('cue times are read in seconds, with or without hours, with a comma or a dot', () => {
  const [a] = parseSubtitle(Buffer.from('1\n01:02:03,500 --> 01:02:04,000\nHi'), 'srt');
  assert.deepEqual([a.s, a.e], [3723.5, 3724]);
  const [b] = parseSubtitle(Buffer.from('WEBVTT\n\n01:02.250 --> 01:03.000\nHi'), 'vtt');
  assert.deepEqual([b.s, b.e], [62.25, 63]);
});

test('cue text keeps only <i> <b> <u> and newlines; every other tag and override is dropped', () => {
  const [c] = parseSubtitle(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n<font color="red">Hi</font> <I>there</I>\n{\\an8}<script>x</script>bye'), 'srt');
  assert.equal(c.t, 'Hi <i>there</i>\nxbye');
});

test('entities are decoded last, so decoded angle brackets are plain text (the player shows cue text as text, never as markup)', () => {
  const [c] = parseSubtitle(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n&lt;b&gt;not bold&lt;/b&gt; &amp; more'), 'srt');
  assert.equal(c.t, '<b>not bold</b> & more');
});

test('ASS dialogue: times, line breaks, italics from overrides, and drawings are skipped', () => {
  const ass = ['[Script Info]', '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nthere, friend',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}',
    'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,hidden'].join('\n');
  const cues = parseSubtitle(Buffer.from(ass), 'ass');
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].s, cues[0].e, cues[0].t], [1, 2.5, '<i>Hello</i>\nthere, friend']);
});

test('text encodings: BOMs are honoured, valid UTF-8 is kept, old files fall back to a Windows code page', () => {
  assert.equal(decodeSubtitle(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.equal(decodeSubtitle(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi');
  assert.equal(decodeSubtitle(Buffer.from('café', 'utf8')), 'café');
  assert.equal(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café'); // Windows-1252
  assert.equal(decodeSubtitle(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'ru'), 'Привет'); // Windows-1251, picked by language
});

test('language names and codes all become two-letter codes; unknown ones are null', () => {
  for (const [input, want] of [['eng', 'en'], ['English', 'en'], ['pt-BR', 'pt'], ['fra', 'fr'], ['ger', 'de'], ['und', null], ['xx', null], ['', null]]) {
    assert.equal(normalizeLang(input), want, input);
  }
});

test('cleanText drops orphan closing tags left behind when a tag was stripped', () => {
  assert.equal(cleanText('</i>plain <b>bold</b></b>'), 'plain <b>bold</b>');
});

test('sidecar subtitles: matched by name, and a longer-named sibling video keeps its own', async () => {
  const t = tmp();
  try {
    for (const f of ['Alien.mkv', 'Alien 3.mkv', 'Alien.en.srt', 'Alien.srt', 'Alien 3.srt', 'Alien 3.fr.srt', 'Aliens.srt']) touch(path.join(t.dir, f), '');
    const names = async (video) => (await findSidecars(path.join(t.dir, video))).map((s) => path.basename(s.file)).sort();
    assert.deepEqual(await names('Alien.mkv'), ['Alien.en.srt', 'Alien.srt']);
    assert.deepEqual(await names('Alien 3.mkv'), ['Alien 3.fr.srt', 'Alien 3.srt']);
  } finally {
    t.cleanup();
  }
});

test('sidecar subtitles: language and flags come from the file name, and Subs/ folders are searched', async () => {
  const t = tmp();
  try {
    touch(path.join(t.dir, 'Movie.mkv'), '');
    touch(path.join(t.dir, 'Movie.en.forced.srt'), '');
    touch(path.join(t.dir, 'Subs', 'Movie.es.sdh.srt'), '');
    touch(path.join(t.dir, 'Subs', 'Movie', '2_French.srt'), '');
    const found = await findSidecars(path.join(t.dir, 'Movie.mkv'));
    const by = Object.fromEntries(found.map((s) => [path.basename(s.file), s]));
    assert.deepEqual([by['Movie.en.forced.srt'].lang, by['Movie.en.forced.srt'].forced], ['en', true]);
    assert.deepEqual([by['Movie.es.sdh.srt'].lang, by['Movie.es.sdh.srt'].sdh], ['es', true]);
    assert.equal(by['2_French.srt'].lang, 'fr');
  } finally {
    t.cleanup();
  }
});

test('a single video in a folder claims any subtitle file there', async () => {
  const t = tmp();
  try {
    touch(path.join(t.dir, 'Some Release Name.mkv'), '');
    touch(path.join(t.dir, 'english.srt'), '');
    assert.equal((await findSidecars(path.join(t.dir, 'Some Release Name.mkv'))).length, 1);
  } finally {
    t.cleanup();
  }
});

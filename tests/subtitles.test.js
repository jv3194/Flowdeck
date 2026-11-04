'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSubtitle, cleanText, decodeSubtitle, describeName, normalizeLang, findSidecars } = require('../server/subtitles');

const parse = (text, ext = 'srt', lang) => parseSubtitle(Buffer.from(text, 'utf8'), ext, lang);

test('srt: indexes, comma timings, multi-line text, tags, entities, CRLF and a BOM', () => {
  const srt = [
    '﻿1', '00:00:01,500 --> 00:00:03,000', 'Hello <i>there</i>', '<font color="#ff0000">Red</font> &amp; blue', '',
    '2', '00:01:02,250 --> 00:01:04,000 X1:100 X2:200', '{\\an8}Top line', '',
    '3', '01:00:00,000 --> 01:00:01,000', '', '',
    '4', '00:00:10,5 --> 00:00:11,5', 'Short fraction',
  ].join('\r\n');
  assert.deepEqual(parse(srt), [
    { s: 1.5, e: 3, t: 'Hello <i>there</i>\nRed & blue' },
    { s: 10.5, e: 11.5, t: 'Short fraction' },
    { s: 62.25, e: 64, t: 'Top line' },
  ]);
});

test('webvtt: header, NOTE/STYLE blocks, cue ids, settings, optional hours', () => {
  const vtt = ['WEBVTT - a title', '', 'NOTE a comment', '', 'STYLE', '::cue { color: red }', '', 'intro', '00:01.000 --> 00:02.500 align:start position:0%', 'First <b>cue</b>', '', '01:00:00.000 --> 01:00:02.000', 'Hour mark'].join('\n');
  assert.deepEqual(parse(vtt, 'vtt'), [
    { s: 1, e: 2.5, t: 'First <b>cue</b>' },
    { s: 3600, e: 3602, t: 'Hour mark' },
  ]);
});

test('ass: commas in text, \\N, style overrides, comments and drawings', () => {
  const ass = [
    '[Script Info]', 'Title: x', '', '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, {\\i1}world{\\i0}\\Nsecond line',
    'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,not shown',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}',
    'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\an8\\b1}Top\\hspaced',
  ].join('\n');
  assert.deepEqual(parse(ass, 'ass'), [
    { s: 1, e: 3.5, t: 'Hello, <i>world</i>\nsecond line' },
    { s: 2, e: 4, t: '<b>Top spaced' },
  ]);
});

test('ass: honours a custom Format order', () => {
  const ass = '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Reordered, with commas';
  assert.deepEqual(parse(ass, 'ssa'), [{ s: 1, e: 2, t: 'Reordered, with commas' }]);
});

test('an ASS file saved with an .srt extension is still read as ASS', () => {
  const ass = '[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,,Mislabelled';
  assert.equal(parse(ass, 'srt')[0].t, 'Mislabelled');
});

test('cleanText keeps only i/b/u tags and never lets markup through', () => {
  assert.equal(cleanText('<I>a</I> <font size=5>b</font> <u>c</u>'), '<i>a</i> b <u>c</u>');
  assert.equal(cleanText('<script>alert(1)</script><img src=x onerror=alert(1)>Hi'), 'alert(1)Hi');
  assert.equal(cleanText('<b onclick="x()">bold</b>'), 'bold', 'attributes make a tag disallowed, so it is dropped');
  // A decoded "<" is plain text, not a tag: the player builds DOM text nodes and never uses innerHTML.
  assert.equal(cleanText('I &lt;3 you &amp; &quot;them&quot;'), 'I <3 you & "them"');
  assert.equal(cleanText('a<br/>b<br>c'), 'a\nb\nc');
  assert.equal(cleanText('  \n x \n\n y  \n'), 'x\ny');
  assert.equal(cleanText('&#169; &#x263A; &#0;'), '© ☺', 'control characters are dropped and the line is trimmed');
});

test('cues are sorted, and zero-length cues get a short duration', () => {
  const cues = parse('2\n00:00:05,000 --> 00:00:06,000\nlater\n\n1\n00:00:01,000 --> 00:00:01,000\nzero length');
  assert.deepEqual(cues.map((c) => [c.s, c.e, c.t]), [[1, 3, 'zero length'], [5, 6, 'later']]);
});

test('encodings: UTF-16 with BOM, UTF-8, Windows-1252, and the language\'s code page', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCafé ☕', 'utf16le')]);
  assert.equal(parseSubtitle(utf16, 'srt')[0].t, 'Café ☕');
  assert.equal(parse('1\n00:00:01,000 --> 00:00:02,000\nCafé ☕')[0].t, 'Café ☕');
  const latin = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'), Buffer.from([0x43, 0x61, 0x66, 0xe9])]); // "Café" in Windows-1252
  assert.equal(parseSubtitle(latin, 'srt')[0].t, 'Café');
  const cyrillic = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])]); // "Привет" in Windows-1251
  assert.equal(parseSubtitle(cyrillic, 'srt', 'ru')[0].t, 'Привет');
  assert.equal(decodeSubtitle(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
});

test('languages: codes, regions and English names all land on the two-letter code', () => {
  for (const [input, want] of [['eng', 'en'], ['en-US', 'en'], ['English', 'en'], ['fre', 'fr'], ['fra', 'fr'], ['ger', 'de'], ['pt-BR', 'pt'], ['jpn', 'ja'], ['spanish', 'es'], ['zho', 'zh']]) {
    assert.equal(normalizeLang(input), want, input);
  }
  for (const input of ['und', 'xx', '', null, 'klingon']) assert.equal(normalizeLang(input), null, String(input));
  assert.equal(normalizeLang('it', { allowTwoLetter: false }), null);
  assert.equal(normalizeLang('ita', { allowTwoLetter: false }), 'it');
});

// ------------------------------------------------------------------ sidecars

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-subs-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function tree(name, files) {
  const root = path.join(tmp, name);
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  return root;
}
const summary = (list) => list.map((s) => [path.relative(tmp, s.file).split(path.sep).slice(1).join('/'), s.lang, s.forced, s.sdh]);

test('sidecars: named like the video, language and flags from the suffix, Subs folders included', async () => {
  const root = tree('a', [
    'Movie.2019.mkv', 'Movie.2019.srt', 'Movie.2019.en.srt', 'Movie.2019.eng.forced.srt', 'Movie.2019.Spanish.SDH.ass', 'Movie.2019.es.txt', 'Movie.2019.de.vtt',
    'Subs/Movie.2019.fr.srt', 'Subs/Movie.2019/2_English.srt', 'Subs/Unrelated.srt', 'Notes/Movie.2019.it.srt',
  ]);
  const got = summary(await findSidecars(path.join(root, 'Movie.2019.mkv')));
  assert.deepEqual(got.sort((a, b) => a[0].localeCompare(b[0])), [
    ['Movie.2019.de.vtt', 'de', false, false],
    ['Movie.2019.en.srt', 'en', false, false],
    ['Movie.2019.eng.forced.srt', 'en', true, false],
    ['Movie.2019.Spanish.SDH.ass', 'es', false, true],
    ['Movie.2019.srt', null, false, false],
    ['Subs/Movie.2019.fr.srt', 'fr', false, false],
    ['Subs/Movie.2019/2_English.srt', 'en', false, false],
    ['Subs/Unrelated.srt', null, false, false], // the folder holds a single video, so an unnamed subtitle belongs to it
  ]);
});

test('sidecar names keep only the words that add information', () => {
  const name = (rest) => describeName(rest).name;
  assert.equal(name('.en'), '');
  assert.equal(name('.eng.forced'), '');
  assert.equal(name('2_English'), '');
  assert.equal(name('.Commentary.en'), 'Commentary');
  assert.equal(name('.hostile'), 'hostile');
  assert.deepEqual(describeName('.fr.Director Commentary.sdh'), { lang: 'fr', forced: false, sdh: true, name: 'Director Commentary' });
});

test('sidecars: with several videos in a folder, only matching names count', async () => {
  const root = tree('b', ['Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S01E01.en.srt', 'Show.S01E02.en.srt', 'Show.S01E02.fr.srt', 'Random.srt']);
  assert.deepEqual(summary(await findSidecars(path.join(root, 'Show.S01E01.mkv'))), [['Show.S01E01.en.srt', 'en', false, false]]);
  assert.deepEqual(summary(await findSidecars(path.join(root, 'Show.S01E02.mkv'))).map((r) => r[0]), ['Show.S01E02.en.srt', 'Show.S01E02.fr.srt']);
});

test('sidecars: a title that looks like a language code is not misread', async () => {
  const root = tree('c', ['No Country for Old Men.mkv', 'No Country for Old Men.srt', 'It.srt']);
  const got = await findSidecars(path.join(root, 'No Country for Old Men.mkv'));
  assert.equal(got.find((s) => s.file.endsWith('It.srt')).lang, null, 'a bare "It" is not Italian');
  assert.equal(got.find((s) => s.file.endsWith('Men.srt')).lang, null, 'the title\'s "No" is not Norwegian');
});

test('sidecars: a missing folder just yields nothing', async () => {
  assert.deepEqual(await findSidecars(path.join(tmp, 'nope', 'x.mkv')), []);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseVideoName, similarity } = require('../../server/names.js');

const root = path.resolve('/library');
const parse = (...parts) => parseVideoName(path.join(root, ...parts), root);

test('a bare number is a movie title, not a camera clip', () => {
  for (const [file, title] of [['1917.mkv', '1917'], ['2012.mp4', '2012'], ['300.mkv', '300'], ['21.mkv', '21']]) {
    assert.deepEqual(parse(file), { type: 'movie', title });
  }
});

test('camera and phone files are clips', () => {
  for (const file of ['IMG_2043.MOV', 'VID_0001.mp4', '20230514_123456.mp4', '2023-05-14.mp4', '123456.mp4']) {
    assert.equal(parse(file).type, 'clip', file);
  }
});

test('a movie keeps its year and loses the release junk', () => {
  assert.deepEqual(parse('Dune.2021.2160p.WEB-DL.mkv'), { type: 'movie', title: 'Dune', year: 2021 });
  assert.deepEqual(parse('1408 (2007).mkv'), { type: 'movie', title: '1408', year: 2007 });
  assert.deepEqual(parse('Blade Runner 2049 (2017).mkv'), { type: 'movie', title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(parse('Wonder.Woman.1984.2020.1080p.BluRay.x264.mkv'), { type: 'movie', title: 'Wonder Woman 1984', year: 2020 });
});

test('a title that ends in a year-like number is read as title + year (the lookup retries with it in the title)', () => {
  assert.deepEqual(parse('Wonder Woman 1984.mkv'), { type: 'movie', title: 'Wonder Woman', year: 1984 });
});

test('episodes: season, episode and the show name, in the usual spellings', () => {
  assert.deepEqual(parse('Lost S06E17 The End.mkv'), { type: 'episode', title: 'Lost', show: 'Lost', season: 6, episode: 17, epHint: 'The End' });
  assert.equal(parse('The Office (US) S01E01.mkv').show, 'The Office (US)');
  assert.deepEqual(parse('Show 2x05.mkv'), { type: 'episode', title: 'Show', show: 'Show', season: 2, episode: 5 });
});

test('episodes keep the year that tells remakes apart, whichever way it is written', () => {
  for (const file of [['Doctor Who (2005) S01E01.mkv'], ['Doctor.Who.2005.S01E01.1080p.mkv'], ['Doctor Who (2005)', 'Season 1', 'S01E01.mkv']]) {
    const p = parse(...file);
    assert.equal(p.show, 'Doctor Who', file.join('/'));
    assert.equal(p.year, 2005, file.join('/'));
  }
  assert.equal(parse('Battlestar Galactica [2004] S01E01.mkv').year, 2004);
});

test('a show named by a number keeps it', () => {
  const p = parse('1923', 'Season 1', '1923.S01E01.mkv');
  assert.equal(p.show, '1923');
  assert.equal(p.year, undefined);
});

test('a numbered file inside a season folder takes its show from the folder above', () => {
  const p = parse('Show (2010)', 'Season 2', '03 - Pilot.mkv');
  assert.deepEqual(p, { type: 'episode', title: 'Show', show: 'Show', season: 2, episode: 3, year: 2010, epHint: 'Pilot' });
});

test('similarity: exact, accents and punctuation ignored, containment strong, unrelated weak', () => {
  assert.equal(similarity('Karma Police', 'karma police!'), 1);
  assert.equal(similarity('Beyoncé', 'Beyonce'), 1);
  assert.ok(similarity('Blade Runner', 'Blade Runner 2049') > 0.78);
  assert.ok(similarity('Dune', 'Heat') < 0.3);
  assert.equal(similarity('', 'x'), 0);
});

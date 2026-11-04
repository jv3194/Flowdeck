'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { normalize, parseVideoName, similarity } = require('../server/names');

const root = path.join('C:', 'Media');
const parse = (...parts) => parseVideoName(path.join(root, ...parts), root);

test('movies: title and year come out of release-style names', () => {
  assert.deepEqual(parse('The.Matrix.1999.1080p.BluRay.x264-GRP.mkv'), { type: 'movie', title: 'The Matrix', year: 1999 });
  assert.deepEqual(parse('Inception (2010).mp4'), { type: 'movie', title: 'Inception', year: 2010 });
  assert.deepEqual(parse('2001 A Space Odyssey (1968) 720p.mkv'), { type: 'movie', title: '2001 A Space Odyssey', year: 1968 });
  assert.deepEqual(parse('Blade_Runner_2049_2017_WEB-DL_x265.mkv'), { type: 'movie', title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(parse('Alien.mkv'), { type: 'movie', title: 'Alien' });
});

test('movies: a generic file name falls back to its folder', () => {
  assert.deepEqual(parse('Heat (1995)', 'movie.mkv'), { type: 'movie', title: 'Heat', year: 1995 });
});

test('episodes: S01E02, 1x02 and "Season 1 Episode 2" forms', () => {
  assert.deepEqual(parse('Breaking.Bad.S01E02.720p.HDTV.x264.mkv'), { type: 'episode', title: 'Breaking Bad', show: 'Breaking Bad', season: 1, episode: 2 });
  const b = parse('Better Call Saul - 3x05 - Chicanery.avi');
  assert.equal(b.show, 'Better Call Saul');
  assert.equal(b.season, 3);
  assert.equal(b.episode, 5);
  assert.equal(b.epHint, 'Chicanery');
  assert.equal(parse('Mr. Robot S02E10 eps2.8_h1dden-pr0cess.b4ckd00r.mkv').show, 'Mr Robot');
  assert.equal(parse('Show Name Season 4 Episode 12.mp4').episode, 12);
});

test('episodes: show and season can come from the folders', () => {
  const a = parse('Severance', 'Season 2', '03 - Who Is Alive.mkv');
  assert.deepEqual([a.type, a.show, a.season, a.episode, a.epHint], ['episode', 'Severance', 2, 3, 'Who Is Alive']);
  const b = parse('Fargo (2014)', 'S01E04.mkv');
  assert.deepEqual([b.type, b.show, b.season, b.episode], ['episode', 'Fargo', 1, 4]);
});

test('camera clips are never treated as movies', () => {
  assert.equal(parse('VID_20230415_120000.mp4').type, 'clip');
  assert.equal(parse('IMG_0042.mov').type, 'clip');
  assert.equal(parse('20230415_120000.mp4').type, 'clip');
});

test('resolution strings are not mistaken for episode numbers', () => {
  assert.equal(parse('Holiday Footage 1920x1080.mp4').type, 'movie');
});

test('normalize drops accents, punctuation, qualifiers and a leading "the"', () => {
  assert.equal(normalize('The Dark Side of the Moon (Remastered)'), 'dark side of the moon');
  assert.equal(normalize('Beyoncé — Lemonade'), 'beyonce lemonade');
  assert.equal(normalize('Guns N\' Roses & Friends'), 'guns n roses and friends');
});

test('similarity ranks the right title above near misses', () => {
  assert.equal(similarity('Discovery', 'discovery (deluxe edition)'), 1);
  assert.ok(similarity('Discovery', 'Discovery Live') > similarity('Discovery', 'Random Access Memories'));
  assert.ok(similarity('The Matrix', 'The Matrix Reloaded') < 0.95);
  assert.ok(similarity('The Matrix', 'The Matrix Reloaded') > 0.7);
  assert.ok(similarity('Breaking Bad', 'Breaking Bd') > 0.8);
  assert.ok(similarity('Abbey Road', 'Kind of Blue') < 0.3);
  assert.equal(similarity('', 'x'), 0);
});

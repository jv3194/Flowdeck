'use strict';
// The subtitle endpoints, against real files in a temp library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../server/index');
const { mkv, cluster, simpleBlock, blockGroup } = require('./helpers/mkv-builder');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-subs-http-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SRT = (text) => `1\n00:00:01,000 --> 00:00:03,000\n${text}\n`;
const media = path.join(tmp, 'media');
const put = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(media, rel)), { recursive: true });
  fs.writeFileSync(path.join(media, rel), data);
};
put('Movie.2019.webm', Buffer.alloc(200, 1));
put('Movie.2019.en.srt', SRT('Hello <i>world</i>'));
put('Movie.2019.es.srt', Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nAdi'), Buffer.from([0xf3, 0x73])])); // "Adiós" in Windows-1252
put('Movie.2019.hostile.srt', SRT('<script>alert(1)</script><img src=x onerror=alert(1)>Hi'));
put('Show.S01E01.mkv', mkv({
  tracks: [{ number: 1, type: 1, codec: 'V_VP9' }, { number: 3, type: 17, codec: 'S_TEXT/UTF8', lang: 'eng' }, { number: 5, type: 17, codec: 'S_HDMV/PGS', lang: 'spa' }],
  clusters: [cluster(1000, simpleBlock(1, 0, 'v'), blockGroup(3, 0, 'Embedded line', 2000))],
}));
put('song.mp3', Buffer.alloc(64, 2));

test('endpoints: list tracks, serve cues, cache embedded extractions, refuse everything else', async () => {
  const dataDir = path.join(tmp, 'data');
  const srv = await startServer({ port: 0, dataDir, webDir: path.join(__dirname, '..', 'web') });
  try {
    const api = (p, init) => fetch(srv.url + p.replace(/^\//, ''), init);
    await api('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: media }) });
    while (srv.lib.scanning) await new Promise((r) => setTimeout(r, 20));
    const idOf = (name) => [...srv.lib.items.values()].find((i) => i.path.endsWith(name)).id;
    const movie = idOf('Movie.2019.webm');

    // Sidecar tracks
    const list = (await (await api(`/api/subs/${movie}`)).json()).tracks;
    assert.deepEqual(list.map((t) => [t.key, t.kind, t.ext, t.lang, t.supported]), [
      ['f0', 'file', 'srt', 'en', true], ['f1', 'file', 'srt', 'es', true], ['f2', 'file', 'srt', null, true],
    ]);
    assert.ok(list.every((t) => !('file' in t) && !JSON.stringify(t).includes(media.replace(/\\/g, '\\\\'))), 'no file paths reach the page');
    assert.deepEqual((await (await api(`/api/subs/${movie}/f0`)).json()).cues, [{ s: 1, e: 3, t: 'Hello <i>world</i>' }]);
    assert.equal((await (await api(`/api/subs/${movie}/f1`)).json()).cues[0].t, 'Adiós', 'legacy encodings are decoded using the language hint');
    const hostile = (await (await api(`/api/subs/${movie}/f2`)).json()).cues[0].t;
    assert.equal(hostile, 'alert(1)Hi');

    // A new sidecar shows up without rescanning
    put('Movie.2019.fr.srt', SRT('Bonjour'));
    assert.equal((await (await api(`/api/subs/${movie}`)).json()).tracks.some((t) => t.lang === 'fr'), true);

    // Embedded tracks
    const show = idOf('Show.S01E01.mkv');
    const emb = (await (await api(`/api/subs/${show}`)).json()).tracks;
    assert.deepEqual(emb.map((t) => [t.key, t.kind, t.ext, t.lang, t.supported]), [['e3', 'embedded', 'srt', 'en', true], ['e5', 'embedded', 'pgs', 'es', false]]);
    assert.deepEqual((await (await api(`/api/subs/${show}/e3`)).json()).cues, [{ s: 1, e: 3, t: 'Embedded line' }]);
    const cached = fs.readdirSync(path.join(dataDir, 'subs'));
    assert.equal(cached.length, 1, 'the extraction was cached on disk');
    // Served from the cache: even with the video's contents destroyed, the same cues come back.
    const before = fs.readFileSync(path.join(media, 'Show.S01E01.mkv'));
    fs.writeFileSync(path.join(media, 'Show.S01E01.mkv'), Buffer.alloc(before.length));
    fs.utimesSync(path.join(media, 'Show.S01E01.mkv'), srv.lib.get(show).mtime / 1000, srv.lib.get(show).mtime / 1000); // keep the mtime the cache is keyed on
    assert.equal((await (await api(`/api/subs/${show}/e3`)).json()).cues[0].t, 'Embedded line');
    fs.writeFileSync(path.join(media, 'Show.S01E01.mkv'), before);

    // Refusals
    assert.equal((await api(`/api/subs/${show}/e5`)).status, 404, 'image-based tracks cannot be served');
    assert.equal((await api(`/api/subs/${movie}/f9`)).status, 404);
    assert.equal((await api(`/api/subs/${movie}/..%2F..%2Fsecret`)).status, 404);
    assert.equal((await api(`/api/subs/${idOf('song.mp3')}`)).status, 404, 'only videos have subtitles');
    assert.equal((await api('/api/subs/0123456789abcdef')).status, 404);
    assert.equal((await api(`/api/subs/${movie}`, { headers: { Origin: 'http://evil.example' } })).status, 403);
  } finally {
    await srv.close();
  }
});

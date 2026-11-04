import { describe } from '../library.js';
import { coverEl, dominantColor } from '../covers.js';
import { fmtLong, fmtTime, h, icon } from '../util.js';

export class AlbumScreen {
  constructor(app) {
    this.app = app;
    this.art = h('div', { class: 'album-art' });
    this.head = h('div');
    this.playBtn = h('button', { class: 'btn primary', tabindex: '-1', onclick: () => this.playAll(false) }, icon('play'), 'Play');
    this.shuffleBtn = h('button', { class: 'btn', tabindex: '-1', onclick: () => this.playAll(true) }, icon('shuffle'), 'Shuffle');
    this.list = h('ol', { class: 'tracks' });
    this.panel = h('div', { class: 'panel album-panel' }, this.head, h('div', { class: 'actions' }, this.playBtn, this.shuffleBtn), this.list);
    this.el = h('section', { class: 'screen album' }, h('div', { class: 'album-wrap' }, this.art, this.panel));
    this.zone = 'track';
    this.btn = 0;
    this.sel = 0;
    app.audio.on('track', () => this.mark());
    app.audio.on('state', () => this.el.classList.toggle('paused', !app.audio.playing));
  }

  coverEl() { return this.art; }

  enter({ album }) {
    this.album = album;
    const d = describe('music', album);
    this.art.replaceChildren(coverEl('music', d));
    const n = album.tracks.length;
    this.head.replaceChildren(
      h('h2', {}, album.title),
      h('p', { class: 'sub' }, album.artist),
      h('p', { class: 'stats' }, [album.year, album.genre, `${n} track${n === 1 ? '' : 's'}`, fmtLong(album.duration)].filter(Boolean).join('  ·  ')),
    );
    this.list.replaceChildren(...album.tracks.map((t, i) => this.row(t, i)));
    const cur = album.tracks.findIndex((t) => t.id === this.app.audio.track?.id);
    this.zone = 'track';
    this.sel = Math.max(0, cur);
    this.mark();
    this.paint();
    this.list.scrollTop = 0;
    const token = (this.token = {});
    if (d.cover) dominantColor(d.cover).then((c) => token === this.token && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55));
    else this.app.setTint(d.hue, 0.55);
  }

  leave() { this.token = null; }

  resume() {
    const d = describe('music', this.album);
    const token = (this.token = {});
    if (d.cover) dominantColor(d.cover).then((c) => token === this.token && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55));
    else this.app.setTint(d.hue, 0.55);
  }

  row(t, i) {
    const showArtist = this.album.variousArtists;
    const r = h('li', { class: 'track', 'data-i': i, onclick: () => this.play(i) },
      h('span', { class: 'num' }, h('span', {}, t.track || i + 1), h('span', { class: 'eq' }, h('i'), h('i'), h('i'))),
      h('span', { class: 't' }, t.title),
      showArtist ? h('span', { class: 'a' }, t.artist) : h('span'),
      h('span', { class: 'd' }, t.duration ? fmtTime(t.duration) : ''));
    r.addEventListener('pointermove', () => { if (this.zone !== 'track' || this.sel !== i) { this.zone = 'track'; this.sel = i; this.paint(false); } });
    return r;
  }

  mark() {
    const id = this.app.audio.track?.id;
    this.list.querySelectorAll('.track').forEach((r, i) => r.classList.toggle('playing', this.album?.tracks[i].id === id));
    this.el.classList.toggle('paused', !this.app.audio.playing);
  }

  paint(scroll = true) {
    this.list.querySelector('.track.sel')?.classList.remove('sel');
    this.playBtn.classList.toggle('sel', this.zone === 'btn' && this.btn === 0);
    this.shuffleBtn.classList.toggle('sel', this.zone === 'btn' && this.btn === 1);
    if (this.zone === 'track') {
      const r = this.list.children[this.sel];
      r?.classList.add('sel');
      if (scroll) r?.scrollIntoView({ block: 'nearest' });
    }
  }

  play(i) {
    const { audio } = this.app;
    audio.coverFor = (t) => this.app.trackCover(t, this.album);
    audio.load(this.album.tracks, i);
    this.app.nav.push('nowplaying');
  }

  playAll(shuffle) {
    const { audio } = this.app;
    audio.shuffle = shuffle;
    audio.emit('mode');
    this.play(shuffle ? Math.floor(Math.random() * this.album.tracks.length) : 0);
  }

  hints() {
    return [
      { pad: 'cross', key: 'Enter', label: 'Play' },
      { pad: 'D-pad', key: '↑ ↓', label: 'Browse' },
      { pad: 'triangle', key: 'Tab', label: 'Options' },
      { pad: 'circle', key: 'Esc', label: 'Back' },
    ];
  }

  onAction(a) {
    const n = this.album.tracks.length;
    switch (a) {
      case 'up':
        if (this.zone === 'track') {
          if (this.sel > 0) this.sel--;
          else this.zone = 'btn';
        }
        break;
      case 'down':
        if (this.zone === 'btn') { this.zone = 'track'; this.sel = 0; }
        else this.sel = Math.min(n - 1, this.sel + 1);
        break;
      case 'left': if (this.zone === 'btn') this.btn = 0; else return false; break;
      case 'right': if (this.zone === 'btn') this.btn = 1; else return false; break;
      case 'first': this.zone = 'track'; this.sel = 0; break;
      case 'last': this.zone = 'track'; this.sel = n - 1; break;
      case 'confirm':
        if (this.zone === 'btn') this.playAll(this.btn === 1);
        else this.play(this.sel);
        return true;
      case 'back': this.app.nav.back(); return true;
      default: return false;
    }
    this.paint();
    return true;
  }
}

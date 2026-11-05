import { describe, nextEpisode } from '../library.js';
import { coverEl, dominantColor } from '../covers.js';
import { fmtTime, h, icon, pointerMoved } from '../util.js';

/** A TV show: poster and details on the left, episodes grouped by season on the right. */
export class ShowScreen {
  constructor(app) {
    this.app = app;
    this.art = h('div', { class: 'album-art poster' });
    this.head = h('div');
    this.playLabel = h('span');
    this.playBtn = h('button', { class: 'btn primary', tabindex: '-1', onclick: () => this.play(this.resumeIndex) }, icon('play'), this.playLabel);
    this.list = h('ol', { class: 'tracks' });
    this.panel = h('div', { class: 'panel album-panel' }, this.head, h('div', { class: 'actions' }, this.playBtn), this.list);
    this.el = h('section', { class: 'screen album show' }, h('div', { class: 'album-wrap' }, this.art, this.panel));
    this.zone = 'btn';
    this.sel = 0;
    this.rows = [];
  }

  coverEl() { return this.art; }

  enter({ show }) {
    this.show = show;
    const d = describe('video', show);
    this.art.replaceChildren(coverEl('video', d));
    const m = show.meta || {};
    const n = show.episodes.length;
    const line = (cls, text) => (text ? h('p', { class: cls }, text) : null);
    this.head.replaceChildren(
      h('h2', {}, show.title),
      line('sub', [show.year, m.network, (m.genres || []).slice(0, 3).join(' / ')].filter(Boolean).join('  ·  ')),
      line('stats', [`${show.seasons.length} season${show.seasons.length === 1 ? '' : 's'}`, `${n} episode${n === 1 ? '' : 's'}`, m.rating && `★ ${m.rating}`, m.status].filter(Boolean).join('  ·  ')),
      line('blurb', m.summary),
    );
    this.zone = 'btn';
    this.render();
    const token = (this.token = {});
    const apply = (c) => token === this.token && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55);
    if (d.cover) dominantColor(d.cover).then(apply);
    else apply(null);
  }

  leave() { this.token = null; }

  resume() {
    this.render(); // progress may have changed while watching
    const d = describe('video', this.show);
    const token = (this.token = {});
    if (d.cover) dominantColor(d.cover).then((c) => token === this.token && this.app.setTint(c ? c.hue : d.hue, c ? c.sat : 0.55));
  }

  /** Index to continue from: the episode in progress, else the next one after those finished (see library.js). */
  get resumeIndex() {
    return nextEpisode(this.show);
  }

  render() {
    const { episodes } = this.show;
    const progress = this.app.prefs.progress || {};
    const watched = this.app.prefs.watched || {};
    const i = this.resumeIndex;
    const resuming = !!progress[episodes[i].id];
    const e = episodes[i];
    const tag = `S${e.parsed.season}E${e.parsed.episode}`;
    const some = episodes.some((x) => watched[x.id]);
    const all = episodes.every((x) => watched[x.id]);
    this.playLabel.textContent = resuming ? `Continue ${tag}` : all ? 'Play again' : some ? `Next: ${tag}` : 'Play';
    this.rows = [];
    const kids = [];
    let season = null;
    episodes.forEach((ep, idx) => {
      if (ep.parsed.season !== season) {
        season = ep.parsed.season;
        kids.push(h('li', { class: 'season' }, season ? `Season ${season}` : 'Specials'));
      }
      const mins = ep.duration ? fmtTime(ep.duration) : ep.meta?.runtime ? `${ep.meta.runtime} min` : '';
      const row = h('li', { class: 'track ep', onclick: () => this.play(idx) },
        h('span', { class: 'num' }, ep.parsed.episode),
        h('span', { class: 't' }, ep.title),
        h('span', { class: `d${progress[ep.id] ? ' resume' : ''}` }, progress[ep.id] ? `▶ ${fmtTime(progress[ep.id])}` : watched[ep.id] ? `✓ ${mins}`.trim() : mins));
      row.addEventListener('pointermove', (e) => { if (pointerMoved(e) && (this.zone !== 'track' || this.sel !== idx)) { this.zone = 'track'; this.sel = idx; this.paint(false); } });
      this.rows.push(row);
      kids.push(row);
    });
    this.list.replaceChildren(...kids);
    this.sel = Math.min(this.sel, episodes.length - 1);
    this.paint();
    if (this.zone === 'btn') this.list.scrollTop = 0;
  }

  paint(scroll = true) {
    this.rows.forEach((r) => r.classList.remove('sel'));
    this.playBtn.classList.toggle('sel', this.zone === 'btn');
    if (this.zone === 'track') {
      const r = this.rows[this.sel];
      r?.classList.add('sel');
      if (scroll && r) {
        if (this.sel === 0) this.list.scrollTo({ top: 0 }); // keeps the first season header in view
        else r.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  play(index) {
    this.app.nav.push('video', { list: this.show.episodes, index });
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
    const n = this.show.episodes.length;
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
      case 'first': this.zone = 'track'; this.sel = 0; break;
      case 'last': this.zone = 'track'; this.sel = n - 1; break;
      case 'confirm':
        this.play(this.zone === 'btn' ? this.resumeIndex : this.sel);
        return true;
      case 'back': this.app.nav.back(); return true;
      default: return false;
    }
    this.paint();
    return true;
  }
}

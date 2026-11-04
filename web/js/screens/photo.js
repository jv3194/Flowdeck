import { toast } from '../ui.js';
import { clamp, fmtBytes, h, icon } from '../util.js';

const IDLE_MS = 2600;
const SLIDE_MS = 4500;

export class PhotoScreen {
  constructor(app) {
    this.app = app;
    this.imgs = [h('img', { alt: '', draggable: 'false' }), h('img', { alt: '', draggable: 'false' })];
    this.front = 0;
    this.stage = h('div', { class: 'p-stage' }, ...this.imgs);
    this.title = h('h3');
    this.count = h('small');
    this.playBtn = this.btn('slideshow', 'Slideshow', () => this.toggleShow());
    this.info = h('div', { class: 'panel p-info' });
    this.top = h('div', { class: 'p-bar top' }, this.btn('back', 'Back', () => app.nav.back()), this.title, this.count);
    this.bottom = h('div', { class: 'p-bar bottom' }, this.btn('prev', 'Previous', () => this.step(-1)), this.playBtn, this.btn('next', 'Next', () => this.step(1)),
      this.btn('info', 'Details', () => this.toggleInfo()), this.btn('fullscreen', 'Fullscreen', () => app.toggleFullscreen()));
    this.el = h('section', { class: 'screen photo' }, this.stage, this.top, this.bottom, this.info);
    this.z = 1;
    this.px = 0;
    this.py = 0;
    this.bind();
  }

  btn(name, label, fn) {
    return h('button', { class: 'round', tabindex: '-1', title: label, 'aria-label': label, onclick: fn }, icon(name));
  }

  coverEl() { return null; }

  enter({ list, index }) {
    this.active = true;
    this.list = list;
    this.index = -1;
    this.show(index, 0);
    this.wake();
  }

  leave() {
    this.active = false;
    this.stopShow();
    clearTimeout(this.idle);
    this.info.classList.remove('show');
    for (const i of this.imgs) i.classList.remove('on');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async show(i, dir) {
    i = clamp(i, 0, this.list.length - 1);
    if (i === this.index) return;
    const item = this.list[i];
    const token = (this.token = {});
    this.index = i;
    this.title.textContent = item.title;
    this.count.textContent = `${i + 1} / ${this.list.length}`;
    const next = this.imgs[1 - this.front];
    next.src = `/media/${item.id}`;
    try {
      await next.decode();
    } catch {
      if (token === this.token) toast(`Can't open ${item.title}`);
      return;
    }
    if (token !== this.token) return;
    this.resetZoom();
    next.classList.add('on');
    this.imgs[this.front].classList.remove('on');
    this.front = 1 - this.front;
    this.renderInfo(item, next);
    this.app.patchPrefs({ focus: { photo: item.id } });
    // Warm the cache for the neighbours so stepping through feels instant.
    for (const n of [i + 1, i - 1]) if (this.list[n]) new Image().src = `/media/${this.list[n].id}`;
  }

  renderInfo(item, img) {
    const row = (k, v) => v && h('div', {}, h('span', {}, `${k}  `), v);
    this.info.replaceChildren(
      row('File', `${item.name}.${item.ext}`),
      row('Size', `${img.naturalWidth} × ${img.naturalHeight}  ·  ${fmtBytes(item.size)}`),
      row('Modified', new Date(item.mtime).toLocaleString()),
      row('Folder', item.dir),
    );
  }

  step(d) {
    const i = this.index + d;
    if (i < 0 || i >= this.list.length) return false;
    this.show(i, d);
    this.wake();
    return true;
  }

  toggleInfo() { this.info.classList.toggle('show'); }

  toggleShow() {
    if (this.timer) {
      this.stopShow();
      toast('Slideshow stopped', 'slideshow', 1200);
    } else {
      this.timer = setInterval(() => { if (!this.step(1)) this.show(0, 1); }, SLIDE_MS);
      toast('Slideshow', 'slideshow', 1200);
    }
    this.playBtn.classList.toggle('on', !!this.timer);
  }

  stopShow() {
    clearInterval(this.timer);
    this.timer = null;
    this.playBtn.classList.remove('on');
  }

  // ------------------------------------------------------------------ zoom

  resetZoom() {
    this.z = 1;
    this.px = this.py = 0;
    this.applyZoom();
  }

  zoomBy(f) {
    this.z = clamp(this.z * f, 1, 6);
    if (this.z === 1) this.px = this.py = 0;
    this.applyZoom();
  }

  applyZoom() {
    this.stage.style.setProperty('--z', this.z);
    this.stage.style.setProperty('--px', `${this.px}px`);
    this.stage.style.setProperty('--py', `${this.py}px`);
  }

  bind() {
    let drag = null;
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    this.stage.addEventListener('dblclick', () => (this.z > 1 ? this.resetZoom() : this.zoomBy(2.5)));
    this.stage.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, px: this.px, py: this.py, moved: false };
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener('pointermove', (e) => {
      this.wake();
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (this.z > 1) {
        this.px = drag.px + dx / this.z;
        this.py = drag.py + dy / this.z;
        this.stage.classList.add('dragging');
        this.applyZoom();
      }
    });
    this.stage.addEventListener('pointerup', (e) => {
      if (drag && this.z === 1) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 70) this.step(dx < 0 ? 1 : -1); // swipe
      }
      drag = null;
      this.stage.classList.remove('dragging');
    });
  }

  wake() {
    this.el.classList.remove('idle');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.el.classList.add('idle'), IDLE_MS);
  }

  hints() {
    return [
      { pad: 'D-pad', key: '← →', label: 'Previous / next' },
      { pad: 'cross', key: 'Space', label: 'Slideshow' },
      { pad: 'D-pad', key: '↑ ↓', label: 'Zoom' },
      { pad: 'triangle', key: 'I', label: 'Details' },
      { pad: 'circle', key: 'Esc', label: 'Back' },
    ];
  }

  onAction(a, ev) {
    this.wake();
    switch (a) {
      case 'left': case 'prev': case 'catPrev': this.step(-1); return true;
      case 'right': case 'next': case 'catNext': this.step(1); return true;
      case 'up': this.zoomBy(1.25); return true;
      case 'down': this.zoomBy(0.8); return true;
      case 'confirm': case 'playpause': this.toggleShow(); return true;
      case 'options': this.toggleInfo(); return true;
      case 'first': this.show(0, -1); return true;
      case 'last': this.show(this.list.length - 1, 1); return true;
      case 'back': this.app.nav.back(); return true;
      case 'char': {
        const k = ev.key.toLowerCase();
        if (k === 'i') this.toggleInfo();
        else if (k === 'f') this.app.toggleFullscreen();
        else if (k === 's') this.toggleShow();
        else if (k === '0') this.resetZoom();
        else return false;
        return true;
      }
      default: return false;
    }
  }
}

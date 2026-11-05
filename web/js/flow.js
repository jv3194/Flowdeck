// Cover-flow carousel (and a plain grid alternative) for a list of items.
// Position is a float that eases toward the target, so wheel, drag and key repeat all feel fluid.
import { placement, REACH } from './layouts.js';
import { clamp, h, reducedMotion } from './util.js';

export class Flow {
  /**
   * @param root   element containing `.flow-stage` and `.flow-grid`
   * @param hooks  { renderCover(item) -> Element, caption(item) -> string, onFocus(i, item), onActivate(i, item) }
   */
  constructor(root, hooks) {
    this.root = root;
    this.stage = root.querySelector('.flow-stage');
    this.grid = root.querySelector('.flow-grid');
    this.hooks = hooks;
    this.items = [];
    this.mode = 'flow';
    this.ratio = 1;
    this.style = 'slab';
    this.tilt = 58;
    this.cw = 240;
    this.pos = 0;
    this.target = 0;
    this.focus = -1;
    this.nodes = new Map();
    this.raf = 0;
    this.last = 0;
    this.W = Infinity; // the stage's width, once known: used to skip covers that are off to the sides
    this.dragging = false;
    this.bind();
    new ResizeObserver(() => this.layout()).observe(root);
  }

  get index() { return clamp(Math.round(this.target), 0, Math.max(0, this.items.length - 1)); }
  get item() { return this.items[this.index]; }
  get focusedNode() { return this.nodes.get(this.index) || null; }
  /** True while the shelf is gliding or being dragged: a good moment to leave other work (thumbnails) for later. */
  get moving() { return this.mode === 'flow' && (this.dragging || this.pos !== this.target); }

  setShape(ratio) {
    this.ratio = ratio;
    this.layout();
  }

  /** Change how the covers are arranged (see layouts.js). Cards glide to their new places. */
  setLayout(style, tilt = 58) {
    if (style === this.style && tilt === this.tilt) return;
    const restyle = style !== this.style;
    this.style = style;
    this.tilt = tilt;
    if (this.mode !== 'flow') return;
    if (restyle && this.nodes.size && !reducedMotion()) {
      this.stage.classList.add('relayout');
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.stage.classList.remove('relayout'), 600);
    }
    this.render();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pos = this.target;
    this.rebuild();
  }

  /**
   * `dir` slides the new shelf in from that side (+1 right, -1 left).
   * `keepPos` keeps a scroll animation going when the list is only being refreshed.
   */
  setItems(items, { focus = 0, dir = 0, keepPos = false } = {}) {
    const last = Math.max(0, items.length - 1);
    this.items = items;
    this.focus = -1;
    this.target = clamp(focus, 0, last);
    this.pos = keepPos ? clamp(this.pos, 0, last) : this.mode === 'flow' ? this.target - 5 * dir : this.target;
    this.rebuild();
  }

  /** Re-render one card in place (e.g. when its thumbnail arrives). */
  refresh(i) {
    const old = this.nodes.get(i);
    if (!old) return;
    const fresh = this.makeNode(i, this.mode === 'grid');
    fresh.className = old.className;
    fresh.style.cssText = old.style.cssText;
    old.replaceWith(fresh);
    this.nodes.set(i, fresh);
  }

  rebuild() {
    this.stage.textContent = '';
    this.grid.textContent = '';
    this.nodes.clear();
    this.focus = -1;
    this.io?.disconnect();
    if (this.mode === 'grid') {
      // A big shelf must not cost a pause to open: the cards start as empty boxes (they have a size already, see the
      // stylesheet) and get their cover and caption as they scroll near the screen.
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.io.unobserve(e.target);
          this.fill(e.target);
        }
      }, { root: this.grid, rootMargin: '500px 0px' });
      const frag = document.createDocumentFragment();
      this.items.forEach((_, i) => {
        const node = h('div', { class: 'card', 'data-i': i });
        this.nodes.set(i, node);
        frag.append(node);
      });
      this.grid.append(frag);
      for (const node of this.nodes.values()) this.io.observe(node);
    }
    this.layout();
    this.changed(true);
    this.kick();
  }

  /** Put the cover and caption into a grid card that was made empty. */
  fill(node) {
    const item = this.items[Number(node.dataset.i)];
    if (!item || node.firstChild) return;
    const cover = this.hooks.renderCover(item, true);
    cover.append(h('div', { class: 'shade' }));
    node.append(cover, h('div', { class: 'cap' }, this.hooks.caption(item)));
  }

  makeNode(i, lazy) {
    const item = this.items[i];
    const cover = this.hooks.renderCover(item, lazy);
    cover.append(h('div', { class: 'shade' }));
    return h('div', { class: 'card', 'data-i': i }, cover, h('div', { class: 'cap' }, this.hooks.caption(item)));
  }

  layout() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    this.W = W;
    this.cw = Math.max(110, Math.min(W * 0.33, H * 0.7 * this.ratio));
    this.stage.style.setProperty('--cw', `${this.cw}px`);
    this.stage.style.setProperty('--ch', `${this.cw / this.ratio}px`);
    this.root.style.setProperty('--ratio', this.ratio);
    this.root.style.setProperty('--gw', `${this.ratio > 1.5 ? 230 : this.ratio > 1.1 ? 200 : 168}px`);
    this.kick();
  }

  // -------------------------------------------------------------- movement

  step(d) {
    if (this.mode === 'flow') this.moveTo(Math.round(this.target) + d);
    else this.gridMove(d, 0);
  }

  /** Grid-aware 2D move; in flow mode up/down do nothing. */
  gridMove(dx, dy) {
    if (this.mode !== 'grid') return dx && this.step(dx);
    const cols = getComputedStyle(this.grid).gridTemplateColumns.split(' ').length || 1;
    const next = this.index + dx + dy * cols;
    if (next >= 0 && next < this.items.length) this.moveTo(next);
    else if (dy > 0 && this.index < this.items.length - 1 && this.index + dy * cols >= this.items.length) this.moveTo(this.items.length - 1);
  }

  moveTo(i, { instant = false } = {}) {
    if (!this.items.length) return;
    this.target = clamp(i, 0, this.items.length - 1);
    if (instant || Math.abs(this.target - this.pos) > 12) this.pos = this.target - Math.sign(this.target - this.pos) * (instant ? 0 : 6);
    this.changed();
    this.kick();
  }

  changed(force) {
    const i = this.index;
    if (i === this.focus && !force) return;
    this.focus = i;
    if (this.mode === 'grid') {
      this.grid.querySelector('.card.focus')?.classList.remove('focus');
      const node = this.nodes.get(i);
      if (node) {
        node.classList.add('focus');
        node.scrollIntoView({ block: 'nearest', behavior: force ? 'instant' : 'smooth' });
      }
    }
    if (this.items.length) this.hooks.onFocus(i, this.items[i]);
  }

  // ------------------------------------------------------------- rendering

  kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    this.raf = 0;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.mode !== 'flow') return;
    const diff = this.target - this.pos;
    this.pos = Math.abs(diff) > 0.0008 ? this.pos + diff * (1 - Math.exp(-dt * 11)) : this.target;
    this.render();
    if (this.pos !== this.target) this.kick();
  }

  render() {
    const n = this.items.length;
    if (!n) return;
    const lo = Math.max(0, Math.ceil(this.pos - REACH));
    const hi = Math.min(n - 1, Math.floor(this.pos + REACH));
    // Every card on screen costs the browser compositing time each time anything behind it changes, so only the ones
    // that can actually be seen get a node: the rest (off the sides of the window, or faded out) are left out entirely.
    const show = new Map();
    for (let i = lo; i <= hi; i++) {
      const p = placement(this.style, i - this.pos, this.cw, this.tilt);
      if (this.visible(p)) show.set(i, p);
    }
    for (const [i, node] of this.nodes) {
      if (!show.has(i)) {
        node.remove();
        this.nodes.delete(i);
      }
    }
    for (const [i, p] of show) {
      let node = this.nodes.get(i);
      if (!node) {
        node = this.makeNode(i, false);
        this.nodes.set(i, node);
        this.stage.append(node);
      }
      this.place(node, i - this.pos, p);
    }
  }

  /** Whether a card at this placement shows at all: not faded out, and not wholly beyond the sides of the stage. */
  visible(p) {
    if (p.opacity < 0.03) return false;
    if (this.style === 'fan') return true; // fan cards swing about a distant point, so x alone doesn't say where they are
    const k = 1500 / Math.max(400, 1500 - p.z); // the stage's perspective pulls cards that are pushed back toward the middle
    return Math.abs(p.x) * k - (this.cw * p.scale * k) / 2 < this.W / 2 + 12;
  }

  place(node, d, p = placement(this.style, d, this.cw, this.tilt)) {
    const ad = Math.abs(d);
    const st = node.style;
    st.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,${p.z.toFixed(1)}px) rotate(${p.rotZ.toFixed(2)}deg) rotateY(${p.rotY.toFixed(2)}deg) scale(${p.scale.toFixed(3)})`;
    st.transformOrigin = p.origin;
    st.opacity = p.opacity >= 1 ? 1 : p.opacity.toFixed(3);
    st.zIndex = 100 - Math.round(ad * 10);
    node.firstChild.lastChild.style.opacity = p.shade.toFixed(3);
    node.classList.toggle('focus', ad < 0.5);
  }

  // ----------------------------------------------------------------- input

  bind() {
    const st = this.stage;
    let drag = null;

    st.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, t0: this.target, moved: false, samples: [[e.timeStamp, e.clientX]] };
    });
    st.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 6) {
        drag.moved = true;
        this.dragging = true;
        st.setPointerCapture(e.pointerId);
      }
      if (!drag.moved) return;
      drag.samples.push([e.timeStamp, e.clientX]);
      if (drag.samples.length > 5) drag.samples.shift();
      this.target = clamp(drag.t0 - dx / (this.cw * 0.5), 0, this.items.length - 1);
      this.changed();
      this.kick();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      this.dragging = false;
      if (!d.moved) {
        const card = e.target.closest?.('.card');
        if (!card) return;
        const i = Number(card.dataset.i);
        if (i === this.index) this.hooks.onActivate(i, this.items[i]);
        else this.moveTo(i);
        return;
      }
      const [t1, x1] = d.samples[0];
      const [t2, x2] = d.samples[d.samples.length - 1];
      const v = t2 > t1 ? (x2 - x1) / (t2 - t1) : 0; // px per ms
      this.moveTo(Math.round(this.target - (v * 220) / (this.cw * 0.5)));
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', () => { drag = null; this.dragging = false; this.moveTo(this.index); });

    let snap = 0;
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.target = clamp(this.target + d / 150, 0, this.items.length - 1);
      this.changed();
      this.kick();
      clearTimeout(snap);
      snap = setTimeout(() => this.moveTo(Math.round(this.target)), 130);
    }, { passive: false });

    this.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const i = Number(card.dataset.i);
      this.moveTo(i);
      this.hooks.onActivate(i, this.items[i]);
    });
  }
}

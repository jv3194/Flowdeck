import { clearThumbQueue, coverEl, ensureThumb } from '../covers.js';
import { Flow } from '../flow.js';
import { describe } from '../library.js';
import { h } from '../util.js';

/** One photo album (a folder): its pictures as a grid. Choosing one opens it in the photo viewer, with this album as the list to page through. */
export class PhotoAlbumScreen {
  constructor(app) {
    this.app = app;
    this.title = h('h2');
    this.sub = h('p', { class: 'sub' });
    this.head = h('div', { class: 'pa-head' }, h('div', {}, this.title, this.sub)); // Back is the status bar's button, as on every screen
    this.flowRoot = h('div', { class: 'flow-root' }, h('div', { class: 'flow-stage' }), h('div', { class: 'flow-grid' }));
    this.el = h('section', { class: 'screen pgrid' }, this.head, this.flowRoot);
    this.flow = new Flow(this.flowRoot, {
      renderCover: (photo, lazy) => {
        ensureThumb(photo, (item, meta) => this.thumbReady(item, meta));
        return coverEl('photo', describe('photo', photo), lazy);
      },
      caption: (photo) => photo.title,
      onFocus: () => {},
      onActivate: (i) => this.open(i),
    });
    this.flow.setMode('grid');
    this.flow.setShape(4 / 3);
  }

  coverEl() { return null; }

  enter({ album }) {
    this.album = album;
    const n = album.photos.length;
    this.title.textContent = album.title;
    this.sub.textContent = [album.parent && `in ${album.parent}`, `${n} photo${n === 1 ? '' : 's'}`].filter(Boolean).join('  ·  ');
    clearThumbQueue();
    this.flow.setItems(album.photos, { focus: 0 });
    this.app.setTint(168, 0.55);
  }

  leave() {}

  /** Back from the viewer: land on the photo that was being looked at. */
  resume() {
    const want = this.app.prefs.focus?.photo;
    const i = this.album.photos.findIndex((p) => p.id === want);
    if (i >= 0) this.flow.moveTo(i, { instant: true });
  }

  open(i) {
    this.app.nav.push('photo', { list: this.album.photos, index: i });
  }

  thumbReady(item, meta) {
    item.cover = 1;
    item.cv = (item.cv || 0) + 1; // a sharper thumbnail replaces an older one
    Object.assign(item, Object.fromEntries(Object.entries(meta).filter(([, v]) => v > 0)));
    const i = this.album.photos.indexOf(item);
    if (i >= 0) this.flow.refresh(i);
  }

  hints() {
    return [
      { pad: 'cross', key: 'Enter', label: 'Open' },
      { pad: 'D-pad', key: '← → ↑ ↓', label: 'Browse' },
      { pad: 'triangle', key: 'Tab', label: 'Options' },
      { pad: 'circle', key: 'Esc', label: 'Back' },
    ];
  }

  onAction(a) {
    const { flow } = this;
    switch (a) {
      case 'left': flow.gridMove(-1, 0); return true;
      case 'right': flow.gridMove(1, 0); return true;
      case 'up': flow.gridMove(0, -1); return true;
      case 'down': flow.gridMove(0, 1); return true;
      case 'first': flow.moveTo(0); return true;
      case 'last': flow.moveTo(this.album.photos.length - 1); return true;
      case 'confirm': this.open(flow.index); return true;
      case 'back': this.app.nav.back(); return true;
      default: return false;
    }
  }
}

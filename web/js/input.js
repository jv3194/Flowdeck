// Turns keyboard and gamepad input into the same small set of abstract actions.
// dispatch(action, event?) returns true when something handled the action.

const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'confirm', Escape: 'back', Backspace: 'back', Tab: 'options', ContextMenu: 'options',
  PageUp: 'catPrev', PageDown: 'catNext', '[': 'catPrev', ']': 'catNext',
  ' ': 'playpause', MediaPlayPause: 'playpause', MediaTrackNext: 'next', MediaTrackPrevious: 'prev',
  '=': 'picZoomIn', '+': 'picZoomIn', '-': 'picZoomOut', _: 'picZoomOut', // zoom the picture, in the video player
  F11: 'fullscreen', Home: 'first', End: 'last',
};

// Standard-mapping gamepad: A/✕ confirm, B/○ back, X/□ view, Y/△ options, bumpers switch category.
const PAD = [
  ['confirm', (p) => p.buttons[0]?.pressed],
  ['back', (p) => p.buttons[1]?.pressed],
  ['view', (p) => p.buttons[2]?.pressed],
  ['options', (p) => p.buttons[3]?.pressed],
  ['catPrev', (p) => p.buttons[4]?.pressed],
  ['catNext', (p) => p.buttons[5]?.pressed],
  ['prev', (p) => p.buttons[6]?.pressed],
  ['next', (p) => p.buttons[7]?.pressed],
  ['playpause', (p) => p.buttons[9]?.pressed],
  ['shape', (p) => p.buttons[10]?.pressed],
  ['up', (p) => p.buttons[12]?.pressed || p.axes[1] < -0.6],
  ['down', (p) => p.buttons[13]?.pressed || p.axes[1] > 0.6],
  ['left', (p) => p.buttons[14]?.pressed || p.axes[0] < -0.6],
  ['right', (p) => p.buttons[15]?.pressed || p.axes[0] > 0.6],
];
const REPEATING = new Set(['up', 'down', 'left', 'right']);

export class Input {
  constructor({ dispatch, onDevice }) {
    this.dispatch = dispatch;
    this.onDevice = onDevice;
    this.device = 'kbd';
    this.held = new Map();
    addEventListener('keydown', (e) => this.key(e));
    addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.dispatch('options', e);
    });
    // A mouse's "back" side button does what Esc does.
    addEventListener('mouseup', (e) => {
      if (e.button !== 3) return;
      e.preventDefault();
      this.dispatch('back', e);
    });
    addEventListener('gamepadconnected', () => this.startPolling());
    if ([...(navigator.getGamepads?.() || [])].some(Boolean)) this.startPolling();
  }

  setDevice(d) {
    if (d === this.device) return;
    this.device = d;
    this.onDevice(d);
  }

  key(e) {
    // Ctrl and + / - / 0 change the interface size (the one Ctrl combination the app uses).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const zoom = e.key === '+' || e.key === '=' ? 'zoomIn' : e.key === '-' || e.key === '_' ? 'zoomOut' : e.key === '0' ? 'zoomReset' : null;
      if (zoom && !e.target.matches?.('input, textarea') && this.dispatch(zoom, e)) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, textarea')) return;
    this.setDevice('kbd');
    const action = KEYS[e.key];
    const handled = action ? this.dispatch(action, e) : /^[\p{L}\p{N},.<>?/]$/u.test(e.key) ? this.dispatch('char', e) : false;
    if (handled) e.preventDefault();
    else if (e.key === 'Tab') e.preventDefault();
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    const tick = (now) => {
      const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
      const down = new Set();
      for (const p of pads) for (const [name, test] of PAD) if (test(p)) down.add(name);
      for (const name of down) {
        const h = this.held.get(name);
        if (!h) {
          this.held.set(name, { next: now + 380 });
          this.setDevice('pad');
          this.dispatch(name);
        } else if (REPEATING.has(name) && now >= h.next) {
          h.next = now + 85;
          this.dispatch(name);
        }
      }
      for (const name of [...this.held.keys()]) if (!down.has(name)) this.held.delete(name);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

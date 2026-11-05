'use strict';
// Electron shell: runs the Flowdeck server in-process and shows the UI in a window.
const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { version } = require('./package.json');
const { createLogger } = require('./logger');
const windowState = require('./windowstate');

const smoke = process.env.FLOWDECK_SMOKE === '1';

/**
 * A throwaway profile for a smoke run. Chromium still has a few files open when a run quits, so a run can't fully
 * delete its own folder: the next run clears away old ones instead (only ones that are clearly finished).
 */
function makeSmokeDir() {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith('flowdeck-smoke-')) continue;
    const old = path.join(tmp, name);
    try {
      if (Date.now() - fs.statSync(old).mtimeMs > 5 * 60 * 1000) fs.rmSync(old, { recursive: true, force: true });
    } catch {
      /* still in use, or already gone */
    }
  }
  return fs.mkdtempSync(path.join(tmp, 'flowdeck-smoke-'));
}

// A smoke run gets a throwaway profile, so checking the app can never touch (or be confused with) the real library.
const smokeDir = smoke ? makeSmokeDir() : null;
if (smokeDir) app.setPath('userData', smokeDir);

// A log for bug reports, in the user's profile. Anything the server prints with console.error / warn lands in it too
// (the server runs in this process), as do crashes and the page's own errors.
const logger = createLogger(path.join(app.getPath('userData'), 'logs'));
for (const level of ['error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logger[level](...args);
    original(...args);
  };
}
process.on('uncaughtExceptionMonitor', (e) => logger.error('uncaught exception:', e));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection:', e));
logger.info(`Flowdeck ${version} starting (Electron ${process.versions.electron}, ${process.platform} ${os.release()})`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win;
  let srv;
  let closing = false;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('render-process-gone', (_e, _contents, details) => logger.error('the page crashed:', details));

  app.whenReady().then(async () => {
    const { startServer } = require('./server');
    srv = await startServer({
      port: 0,
      dataDir: process.env.FLOWDECK_DATA ? path.resolve(process.env.FLOWDECK_DATA) : path.join(app.getPath('userData'), 'data'),
      webDir: path.join(__dirname, 'web'),
    });

    // Open where the window was last left (a smoke run always opens at the default size).
    const stateFile = path.join(app.getPath('userData'), 'window.json');
    const bounds = windowState.initialBounds(smoke ? null : windowState.load(stateFile), screen.getAllDisplays().map((d) => d.workArea));

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: windowState.MIN.width,
      minHeight: windowState.MIN.height,
      title: 'Flowdeck',
      backgroundColor: '#090c1e',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      autoHideMenuBar: true,
      show: !smoke,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
        preload: path.join(__dirname, 'preload.js'), // two narrow abilities for the page: see preload.js
      },
    });
    if (bounds.maximized) win.maximize();

    let remember;
    const rememberWindow = (now) => {
      clearTimeout(remember);
      const write = () => {
        if (smoke || win.isDestroyed() || win.isMinimized()) return;
        windowState.save(stateFile, { ...win.getNormalBounds(), maximized: win.isMaximized() }); // the un-maximised size, so un-maximising later restores it
      };
      if (now) write();
      else remember = setTimeout(write, 400);
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, () => rememberWindow(false));
    win.on('close', () => rememberWindow(true));

    // The page may ask for the log folder to be shown, but only the app's own page, and only that one folder.
    ipcMain.handle('flowdeck:open-logs', (event) => {
      if (!event.senderFrame?.url?.startsWith(srv.url)) return '';
      return shell.openPath(logger.dir);
    });

    // The page never needs another window, and must not navigate away from the local server.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(srv.url)) e.preventDefault(); });
    win.webContents.on('did-fail-load', (_e, code, description, url) => logger.error(`the page failed to load (${code} ${description}):`, url));
    win.webContents.on('console-message', (...args) => {
      // Electron passes either (event, level, message, line, source) or one event object, depending on its version.
      const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const level = typeof d.level === 'string' ? d.level : ['verbose', 'info', 'warning', 'error'][d.level] || 'info';
      if (level === 'error') logger.error(`page: ${d.message} (${String(d.sourceId || '').split('/').slice(-2).join('/')}:${d.lineNumber})`);
    });
    win.loadURL(srv.url);

    if (smoke) {
      // Headless self-check: boot the UI, report what rendered, quit.
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          const report = await win.webContents.executeJavaScript(
            `JSON.stringify({ title: document.title, screens: document.querySelectorAll('.screen').length, active: document.querySelector('.screen.active')?.className, app: !!window.flowdeck, theme: window.flowdeck?.themes?.activeId, mode: document.documentElement.dataset.mode, backdrop: window.flowdeck?.bg?.cfg?.style, layout: window.flowdeck?.nav?.screens?.home?.flow?.style, ffmpeg: window.flowdeck?.ffmpeg?.state, host: { pathForFile: typeof window.flowdeckHost?.pathForFile, openLogs: typeof window.flowdeckHost?.openLogs, setZoom: typeof window.flowdeckHost?.setZoom }, exposed: Object.keys(window.flowdeckHost || {}).sort() })`,
          );
          console.log(`SMOKE ${report}`);
          // The bridge's zoom must really change the page's size (a 1.5x zoom shrinks the layout width by a third), and
          // the graphics tier must have given the backdrop canvas its pixels.
          const before = await win.webContents.executeJavaScript('({ w: innerWidth, dpr: devicePixelRatio, screenW: screen.width, tier: window.flowdeck?.tier, canvas: [document.querySelector("#bg").width, document.querySelector("#bg").height] })');
          await win.webContents.executeJavaScript('window.flowdeckHost.setZoom(1.5)');
          await new Promise((r) => setTimeout(r, 400));
          const after = await win.webContents.executeJavaScript('({ w: innerWidth, dpr: devicePixelRatio })');
          await win.webContents.executeJavaScript('window.flowdeckHost.setZoom(99)'); // clamped to 2
          await new Promise((r) => setTimeout(r, 300));
          const clamped = await win.webContents.executeJavaScript('innerWidth');
          console.log(`SMOKE-ZOOM ${JSON.stringify({ before, after, clampedWidth: clamped })}`);
          console.log(`SMOKE-LOG ${JSON.stringify({ file: logger.file, exists: fs.existsSync(logger.file), starts: fs.existsSync(logger.file) && fs.readFileSync(logger.file, 'utf8').includes('starting') })}`);
          app.quit();
        }, 2500);
      });
    }
  });

  app.on('window-all-closed', () => app.quit());

  // Flush the library cache before exiting.
  app.on('will-quit', (e) => {
    if (closing || !srv) return;
    e.preventDefault();
    closing = true;
    srv.close().finally(() => {
      if (smokeDir) {
        try {
          fs.rmSync(smokeDir, { recursive: true, force: true });
        } catch {
          /* Chromium may still hold a cache file; it's only a temp folder */
        }
      }
      app.exit(0);
    });
  });
}

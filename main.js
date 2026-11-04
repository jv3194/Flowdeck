'use strict';
// Electron shell: runs the Flowdeck server in-process and shows the UI in a window.
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  app.whenReady().then(async () => {
    const { startServer } = require('./server');
    srv = await startServer({
      port: 0,
      dataDir: process.env.FLOWDECK_DATA ? path.resolve(process.env.FLOWDECK_DATA) : path.join(app.getPath('userData'), 'data'),
      webDir: path.join(__dirname, 'web'),
    });

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1280,
      height: 760,
      minWidth: 900,
      minHeight: 540,
      title: 'Flowdeck',
      backgroundColor: '#090c1e',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      autoHideMenuBar: true,
      show: !smoke,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    // The page never needs another window, and must not navigate away from the local server.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(srv.url)) e.preventDefault(); });
    win.loadURL(srv.url);

    if (smoke) {
      // Headless self-check: boot the UI, report what rendered, quit.
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          const report = await win.webContents.executeJavaScript(
            `JSON.stringify({ title: document.title, screens: document.querySelectorAll('.screen').length, active: document.querySelector('.screen.active')?.className, app: !!window.flowdeck, theme: window.flowdeck?.themes?.activeId, mode: document.documentElement.dataset.mode, backdrop: window.flowdeck?.bg?.cfg?.style, layout: window.flowdeck?.nav?.screens?.home?.flow?.style, ffmpeg: window.flowdeck?.ffmpeg?.state })`,
          );
          console.log(`SMOKE ${report}`);
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

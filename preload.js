'use strict';
// The only things the page may ask the desktop app for. The page runs sandboxed with no Node access; this bridge
// hands it three narrow abilities and nothing else:
//   pathForFile(file)  where a file or folder dropped onto the window lives on disk (browsers hide this)
//   openLogs()         show the log folder in Explorer, for bug reports (the folder is fixed: the page cannot pick a path)
//   setZoom(factor)    make the whole interface larger or smaller (clamped to 0.75 to 2; affects only this window)
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('flowdeckHost', {
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  openLogs: () => ipcRenderer.invoke('flowdeck:open-logs'),
  setZoom: (factor) => {
    const f = Number(factor);
    if (Number.isFinite(f)) webFrame.setZoomFactor(Math.min(2, Math.max(0.75, f)));
  },
});

// Test bootstrap: installed BEFORE loading main.js, including in the unsigned
// packaged probe. No URL or local-path action can reach the operating system.
const { app, shell, ipcMain } = require('electron');
const seen = globalThis.tdagOutbound = {
  external: [], windows: [], navigation: [], local: [], localRequests: [], registrations: [],
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, (event, ...args) => {
  if (channel === 'local:open') seen.localRequests.push(args[0]);
  return handler(event, ...args);
});
shell.openExternal = async (url) => { seen.external.push(url); };
shell.openPath = async (path) => { seen.local.push({ kind: 'open', path }); return ''; };
shell.showItemInFolder = (path) => { seen.local.push({ kind: 'reveal', path }); };
app.setAsDefaultProtocolClient = (...args) => { seen.registrations.push(args); return true; };
// Packaging must not query/download an update during the probe.
if (app.isPackaged) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.checkForUpdates = async () => null;
  autoUpdater.downloadUpdate = async () => { throw new Error('probe forbids downloads'); };
  autoUpdater.quitAndInstall = () => { throw new Error('probe forbids installs'); };
}
app.on('web-contents-created', (_event, contents) => {
  const setHandler = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) => setHandler((details) => {
    const result = handler(details);
    seen.windows.push({ url: details.url, disposition: details.disposition, action: result.action });
    return result;
  });
  // Install the observer after the shell has registered its navigation guard.
  setImmediate(() => {
    for (const event of ['will-navigate', 'will-redirect']) {
      contents.on(event, (e, url) => seen.navigation.push({ event, url, prevented: e.defaultPrevented }));
    }
  });
});
require('./main.js');

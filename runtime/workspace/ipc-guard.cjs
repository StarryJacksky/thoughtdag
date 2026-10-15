// Who may call into the desktop shell. A call there reads and writes the
// person's real files and starts agents on their machine, so it is accepted
// from one place only: the top frame of the app's own window, showing the
// app's own origin. A frame inside the page, another window, or the app
// window after it was sent somewhere else is refused, whatever it asks for.
// The same origin test says where the app window's top frame may navigate.
'use strict';

/** Whether `url` lies inside the app's own origin. */
function isAppUrl(url, origin) {
  if (typeof origin !== 'string' || !origin) return false;
  try { return new URL(String(url)).origin === origin; } catch { return false; }
}

/**
 * `sender` describes the frame an IPC message came from:
 *   { url, isMainFrame, webContentsId }
 * `app` describes the one frame that is trusted:
 *   { origin, webContentsId }
 * Returns `{ trusted: true }` or `{ trusted: false, reason }`.
 */
function checkSender(sender, app) {
  if (!app || typeof app.origin !== 'string' || !app.origin) return { trusted: false, reason: 'the app has no origin yet' };
  if (!sender || sender.webContentsId !== app.webContentsId) return { trusted: false, reason: 'the call did not come from the app window' };
  if (!sender.isMainFrame) return { trusted: false, reason: 'the call came from a frame inside the page' };
  if (!isAppUrl(sender.url, app.origin)) return { trusted: false, reason: 'the app window is not showing the app' };
  return { trusted: true };
}

/** The sender of an Electron IPC event, in the shape checkSender reads. */
function senderOf(event) {
  const frame = event?.senderFrame ?? null;
  return {
    url: frame?.url ?? '',
    // the top frame has no parent
    isMainFrame: !!frame && frame.parent === null,
    webContentsId: event?.sender?.id ?? null,
  };
}

module.exports = { checkSender, senderOf, isAppUrl };

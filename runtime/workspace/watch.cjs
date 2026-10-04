// A signal that something in a workspace folder changed. Only a signal: the
// events a file system reports can repeat, arrive out of order, name the
// wrong file or not arrive at all, so nothing is decided from them. Each
// burst of events, once quiet, asks for one rescan, and the rescan reads the
// disk (see reconcile.cjs). A rescan can also be asked for directly, which
// is what covers the events that never came.
'use strict';

const fs = require('node:fs');
const { METADATA_DIR } = require('./path-policy.cjs');

/** What this application writes itself and need not be told about. */
function isOwnNoise(filename) {
  if (typeof filename !== 'string') return false; // an unnamed event may be about anything
  const steps = filename.split(/[\\/]/);
  if (steps[0].toLowerCase() === METADATA_DIR) return true;
  return steps[steps.length - 1].includes('.tdag-save-');
}

/**
 * Watch `rootPath` and call `onSignal()` once after each burst of changes.
 *   watchFn     how to watch (fs.watch by default; tests pass their own)
 *   quietMs     how long the folder must be quiet before the signal
 * Returns `{ close() }`. Closing stops this watcher and nothing else.
 */
function watchWorkspace({ rootPath, onSignal, watchFn = fs.watch, quietMs = 200 }) {
  let timer = null;
  let closed = false;
  const signal = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!closed) onSignal(); }, quietMs);
    timer.unref?.();
  };
  let watcher = null;
  try {
    watcher = watchFn(rootPath, { recursive: true, persistent: false }, (_eventType, filename) => { if (!isOwnNoise(filename)) signal(); });
    // a watcher that fails later (the folder was removed) must not take the app down
    watcher.on?.('error', () => {});
  } catch {
    // no recursive watching on this platform or volume: explicit rescans still work
  }
  return {
    watching: () => watcher !== null,
    close() {
      closed = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
  };
}

module.exports = { watchWorkspace, isOwnNoise };

// A signal that something in a workspace folder changed. Only a signal: the
// events a file system reports can repeat, arrive out of order, name the
// wrong file or not arrive at all, so nothing is decided from them. Each
// burst of events, once quiet, asks for one rescan, and the rescan reads the
// disk (see reconcile.cjs). A rescan can also be asked for directly, which
// is what covers the events that never came.
//
// Some never come because of the watching itself, and for those a watcher
// asks for a rescan of its own. A watcher hears nothing of what happened
// before it started, nor until the system starts reporting to it, which is
// a moment later and on another thread: once started, it asks for one. And
// on macOS all of a process's recursive watchers share one stream of news
// from the file system, which is closed and made anew whenever one of them
// starts or stops: for that moment none of them hears anything, and what
// was on its way to them is dropped. So when one starts or stops, every
// other one made with the same watch function asks for one too. Like any
// other signal, these wait until the folder has been quiet a moment.
'use strict';

const fs = require('node:fs');
const { METADATA_DIR } = require('./path-policy.cjs');

/** What this application writes itself and need not be told about. */
function isOwnNoise(filename) {
  if (typeof filename !== 'string') return false; // an unnamed event may be about anything
  const steps = filename.split(/[\\/]/);
  if (steps[0].toLowerCase() === METADATA_DIR) return true;
  // the files this application writes beside a file while it saves or creates it
  return steps[steps.length - 1].includes('.tdag-save-') || steps[steps.length - 1].includes('.tdag-create-');
}

// The watchers that are running, by the watch function that made them: the
// ones that share what the system tells them. Each is held as its signal.
const running = new WeakMap();
/** Every running watcher of `watchFn` but `except` looks at its folder again. */
const othersLookAgain = (watchFn, except) => { for (const signal of running.get(watchFn) ?? []) if (signal !== except) signal(); };

/**
 * Watch `rootPath` and call `onSignal()` once after each burst of changes,
 * and once after it has started (see above).
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
  if (watcher) {
    if (!running.has(watchFn)) running.set(watchFn, new Set());
    running.get(watchFn).add(signal);
    othersLookAgain(watchFn, signal);
    signal();
  }
  return {
    watching: () => watcher !== null,
    close() {
      closed = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      if (watcher && running.get(watchFn)?.delete(signal)) othersLookAgain(watchFn, signal);
      watcher = null;
    },
  };
}

module.exports = { watchWorkspace, isOwnNoise };

// The operation journal of one workspace: what a file operation set out to
// do, and whether it finished. It is what lets a retry of the same operation
// return the same answer instead of doing the work twice, and what lets the
// next start find an operation a crash cut short.
//
// Append-only, one JSON object per line, flushed before the operation goes
// on. A line that does not parse (the tail a crash left half-written) is
// skipped: it never hides the lines before it, and it is closed off with a
// line break before anything is appended, so it never swallows the line
// after it either.
//
// An operation can be tried more than once under one id: it fails, and is
// asked again. Each `intent` starts a new attempt, and the state of the
// operation is the state of its latest attempt. An earlier failure says
// nothing about an attempt that came after it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { METADATA_DIR } = require('./path-policy.cjs');

const fsp = fs.promises;
const JOURNAL_FILE = 'journal.jsonl';

/**
 * Entries are `{ opId, kind, phase, at, ... }`. `phase` is 'intent' (about
 * to start), any number of named steps, then 'done' (with the result) or
 * 'failed'. A read-only workspace has no journal: nothing is written, and
 * nothing in it changes.
 */
function createJournal({ rootPath, readOnly = false, now = () => new Date().toISOString() }) {
  const file = path.join(rootPath, METADATA_DIR, JOURNAL_FILE);
  let ops = null;        // Map<opId, { kind, entries: [the latest attempt's], done, failed }>
  let loading = null;
  let tornTail = false;  // the file ends in half a line
  // one append at a time, in the order asked: a line is never written into the middle of another
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  function load() {
    loading ??= (async () => {
      const loaded = new Map();
      let text = '';
      try { text = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; } // a torn line
        if (!entry || typeof entry.opId !== 'string' || typeof entry.phase !== 'string') continue;
        note(loaded, entry);
      }
      tornTail = text.length > 0 && !text.endsWith('\n');
      ops = loaded;
      return loaded;
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  function note(into, entry) {
    let op = into.get(entry.opId);
    if (!op) { op = { kind: entry.kind, entries: [], done: null, failed: false }; into.set(entry.opId, op); }
    if (entry.phase === 'intent') {
      // a new attempt: what the one before it left behind is not this one's
      op.entries = [];
      op.failed = false;
    }
    op.entries.push(entry);
    if (entry.phase === 'done') op.done = entry;
    if (entry.phase === 'failed') op.failed = true;
  }

  return {
    /** Record one step and flush it to disk before returning. */
    append: (entry) => serial(async () => {
      await load();
      const full = { ...entry, at: now() };
      if (!readOnly) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const handle = await fsp.open(file, 'a');
        try {
          await handle.writeFile((tornTail ? '\n' : '') + JSON.stringify(full) + '\n');
          await handle.sync();
          tornTail = false;
        } finally {
          await handle.close();
        }
      }
      note(ops, full);
      return full;
    }),

    /** The 'done' entry of an operation that already finished, or null. */
    async completed(opId) {
      return (await load()).get(opId)?.done ?? null;
    },

    /** The entries of an operation's latest attempt that neither finished nor failed, or null. */
    async attempt(opId) {
      const op = (await load()).get(opId);
      return op && !op.done && !op.failed ? op.entries : null;
    },

    /** Operations whose latest attempt started and neither finished nor failed, oldest first, with that attempt's entries. */
    async pending() {
      return [...(await load()).entries()].filter(([, op]) => !op.done && !op.failed).map(([opId, op]) => ({ opId, kind: op.kind, entries: op.entries }));
    },
  };
}

module.exports = { createJournal, JOURNAL_FILE };

// The operation journal of one workspace: what a file operation set out to
// do, and whether it finished. It is what lets a retry of the same operation
// return the same answer instead of doing the work twice, and what lets the
// next start find an operation a crash cut short.
//
// Append-only, one JSON object per line, flushed before the operation goes
// on. A line that does not parse (the tail a crash left half-written) is
// skipped: it never hides the lines before it.
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
  let ops = null; // Map<opId, { kind, entries: [...], done, failed }>

  async function load() {
    if (ops) return ops;
    ops = new Map();
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // a torn line
      if (!entry || typeof entry.opId !== 'string' || typeof entry.phase !== 'string') continue;
      note(entry);
    }
    return ops;
  }

  function note(entry) {
    let op = ops.get(entry.opId);
    if (!op) { op = { kind: entry.kind, entries: [], done: null, failed: false }; ops.set(entry.opId, op); }
    op.entries.push(entry);
    if (entry.phase === 'done') op.done = entry;
    if (entry.phase === 'failed') op.failed = true;
  }

  return {
    /** Record one step and flush it to disk before returning. */
    async append(entry) {
      await load();
      const full = { ...entry, at: now() };
      if (!readOnly) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const handle = await fsp.open(file, 'a');
        try {
          await handle.writeFile(JSON.stringify(full) + '\n');
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      note(full);
      return full;
    },

    /** The 'done' entry of an operation that already finished, or null. */
    async completed(opId) {
      return (await load()).get(opId)?.done ?? null;
    },

    /** Operations that started and neither finished nor failed, oldest first. */
    async pending() {
      return [...(await load()).entries()].filter(([, op]) => !op.done && !op.failed).map(([opId, op]) => ({ opId, kind: op.kind, entries: op.entries }));
    },
  };
}

module.exports = { createJournal, JOURNAL_FILE };

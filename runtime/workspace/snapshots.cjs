// What a run was given: a file's content frozen at the moment the run was
// prepared, kept in the workspace's own records (<root>/.thoughtdag/
// snapshots/<sha256 hex>), out of reach of the file door. A snapshot is
// named by the hash of its bytes, written whole before it has that name, and
// never changed or replaced: the same content frozen again is the same
// snapshot. Reading one checks its bytes against its name. Nothing here
// removes a snapshot; which ones a run still needs is for the run records
// to say (runtime/execution/run-records.cjs).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { METADATA_DIR } = require('./path-policy.cjs');

const SNAPSHOT_DIR = 'snapshots';
const SNAPSHOT_ID = /^snap_([0-9a-f]{64})$/;

const snapshotRoot = (rootPath) => path.join(rootPath, METADATA_DIR, SNAPSHOT_DIR);
const hexOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Whether a string is a snapshot's name, and the hash in it. */
function parseSnapshotId(snapshotId) {
  const m = typeof snapshotId === 'string' ? SNAPSHOT_ID.exec(snapshotId) : null;
  return m ? m[1] : null;
}

/**
 * Keep `bytes` as a snapshot. Resolves with `{ snapshotId, contentHash }`
 * only when the whole of them is there under that name: written beside it,
 * flushed, read back, and put in place in one step. Something already under
 * the name counts only if it hashes to it.
 */
async function keepSnapshot(rootPath, bytes, io = fs.promises) {
  const hex = hexOf(bytes);
  const dir = snapshotRoot(rootPath);
  const target = path.join(dir, hex);
  await io.mkdir(dir, { recursive: true });
  const existing = await io.readFile(target).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing && hexOf(existing) === hex) {
    // kept again: new again, so that cleaning up (run-records.cjs) gives the run that froze it time to record it
    const now = new Date();
    if (typeof io.utimes === 'function') await io.utimes(target, now, now).catch(() => {});
  } else {
    const temp = path.join(dir, `.${hex}.tdag-snap-${randomUUID().slice(0, 8)}`);
    try {
      const handle = await io.open(temp, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (hexOf(await io.readFile(temp)) !== hex) throw new Error('the snapshot does not read back as it was written');
      await io.rename(temp, target);
    } catch (e) {
      await io.rm(temp, { force: true }).catch(() => {});
      throw e;
    }
  }
  return { snapshotId: `snap_${hex}`, contentHash: `sha256:${hex}` };
}

/** The bytes of a snapshot, or null when there is none of that name whose bytes hash to it. */
async function readSnapshot(rootPath, snapshotId, io = fs.promises) {
  const hex = parseSnapshotId(snapshotId);
  if (!hex) return null;
  let bytes;
  try { bytes = await io.readFile(path.join(snapshotRoot(rootPath), hex)); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return hexOf(bytes) === hex ? bytes : null;
}

module.exports = { keepSnapshot, readSnapshot, parseSnapshotId, snapshotRoot, SNAPSHOT_DIR };

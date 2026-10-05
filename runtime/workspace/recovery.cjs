// The workspace's recovery area: what a file held before a save replaced it,
// and files that were trashed when the system trash was not available. It
// lives in the workspace's own records (<root>/.thoughtdag/recovery), out of
// reach of the file door, and nothing here is ever chosen as model input.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { METADATA_DIR } = require('./path-policy.cjs');

const RECOVERY_DIR = 'recovery';

const recoveryRoot = (rootPath) => path.join(rootPath, METADATA_DIR, RECOVERY_DIR);
const hex = (contentHash) => String(contentHash).replace(/^sha256:/, '');
const hashOf = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/**
 * Keep the bytes a file held under `revision`, before they are replaced.
 * Resolves, with where they were kept relative to the recovery area, only
 * when the whole of them is there under that name: they are written beside
 * it, flushed, and put in place in one step. Something already under that
 * name counts only if it hashes to the revision; part of a copy left by an
 * earlier failure is replaced, never taken for the whole. Rejects when the
 * copy could not be made, and the caller then must not replace the file.
 */
async function keepPreviousVersion(rootPath, fileId, revision, bytes, io = fs.promises) {
  if (hashOf(bytes) !== revision) throw new Error('the bytes to keep are not the revision they are kept as');
  const dir = path.join(recoveryRoot(rootPath), 'versions', fileId);
  const target = path.join(dir, hex(revision));
  const kept = path.join('versions', fileId, hex(revision));
  await io.mkdir(dir, { recursive: true });
  const existing = await io.readFile(target).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing && hashOf(existing) === revision) return kept;

  const temp = path.join(dir, `.${hex(revision)}.tdag-keep-${randomUUID().slice(0, 8)}`);
  try {
    const handle = await io.open(temp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (hashOf(await io.readFile(temp)) !== revision) throw new Error('the kept copy does not read back as it was written');
    await io.rename(temp, target);
  } catch (e) {
    await io.rm(temp, { force: true }).catch(() => {});
    throw e;
  }
  return kept;
}

/** The bytes kept for a file's earlier revision, or null when none were kept whole. */
async function readPreviousVersion(rootPath, fileId, revision, io = fs.promises) {
  let bytes;
  try { bytes = await io.readFile(path.join(recoveryRoot(rootPath), 'versions', fileId, hex(revision))); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return hashOf(bytes) === revision ? bytes : null;
}

/**
 * Move a file into the recovery area instead of the system trash. It stays
 * in the workspace's records until someone restores or clears it. Resolves
 * with where it went, relative to the recovery area.
 */
async function moveToRecoveryTrash(rootPath, receiptId, absolute, io = fs.promises) {
  const dir = path.join(recoveryRoot(rootPath), 'trash', receiptId);
  await io.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(absolute));
  await io.rename(absolute, target);
  return path.join('trash', receiptId, path.basename(absolute));
}

module.exports = { keepPreviousVersion, readPreviousVersion, moveToRecoveryTrash, recoveryRoot, RECOVERY_DIR };

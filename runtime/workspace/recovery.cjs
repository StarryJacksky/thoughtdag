// The workspace's recovery area: what a file held before a save replaced it,
// and files that were trashed when the system trash was not available. It
// lives in the workspace's own records (<root>/.thoughtdag/recovery), out of
// reach of the file door, and nothing here is ever chosen as model input.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { METADATA_DIR } = require('./path-policy.cjs');

const fsp = fs.promises;
const RECOVERY_DIR = 'recovery';

const recoveryRoot = (rootPath) => path.join(rootPath, METADATA_DIR, RECOVERY_DIR);
const hex = (contentHash) => String(contentHash).replace(/^sha256:/, '');

/**
 * Keep the bytes a file held under `revision`, before they are replaced.
 * One copy per file and revision; keeping it again is a no-op. Resolves
 * with where it was kept, relative to the recovery area.
 */
async function keepPreviousVersion(rootPath, fileId, revision, bytes) {
  const dir = path.join(recoveryRoot(rootPath), 'versions', fileId);
  const target = path.join(dir, hex(revision));
  await fsp.mkdir(dir, { recursive: true });
  try {
    const handle = await fsp.open(target, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; // already kept
  }
  return path.join('versions', fileId, hex(revision));
}

/** The bytes kept for a file's earlier revision, or null when none were kept. */
async function readPreviousVersion(rootPath, fileId, revision) {
  try { return await fsp.readFile(path.join(recoveryRoot(rootPath), 'versions', fileId, hex(revision))); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Move a file into the recovery area instead of the system trash. It stays
 * in the workspace's records until someone restores or clears it. Resolves
 * with where it went, relative to the recovery area.
 */
async function moveToRecoveryTrash(rootPath, receiptId, absolute) {
  const dir = path.join(recoveryRoot(rootPath), 'trash', receiptId);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(absolute));
  await fsp.rename(absolute, target);
  return path.join('trash', receiptId, path.basename(absolute));
}

module.exports = { keepPreviousVersion, readPreviousVersion, moveToRecoveryTrash, recoveryRoot, RECOVERY_DIR };

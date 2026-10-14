// The workspace's recovery area: what a file held before a save replaced it,
// and files that were trashed when the system trash was not available. It
// lives in the workspace's own records (<root>/.thoughtdag/recovery), out of
// reach of the file door, and nothing here is ever chosen as model input.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { METADATA_DIR, WorkspaceAccessError } = require('./path-policy.cjs');

const RECOVERY_DIR = 'recovery';

const recoveryRoot = (rootPath) => path.join(rootPath, METADATA_DIR, RECOVERY_DIR);
const hex = (contentHash) => String(contentHash).replace(/^sha256:/, '');
const hashOf = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const tooLarge = () => new WorkspaceAccessError('too-large', 'the file is too large to be read here');

/**
 * The bytes from an open handle's current position to its end, but never
 * more than `limit` of them: past it, `too-large` is thrown and nothing more
 * is read. The size seen before is not trusted to hold while reading.
 */
async function readBounded(handle, limit = Infinity) {
  if (!Number.isFinite(limit)) return handle.readFile();
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(limit + 1, 1 << 20)));
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw tooLarge();
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

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

/**
 * The bytes kept for a file's earlier revision, or null when none were kept
 * whole. One larger than `maxBytes` is refused (`too-large`) from its size,
 * before any of it is read, and the read stops there should it grow.
 */
async function readPreviousVersion(rootPath, fileId, revision, io = fs.promises, maxBytes = Infinity) {
  let handle;
  try { handle = await io.open(path.join(recoveryRoot(rootPath), 'versions', fileId, hex(revision)), fs.constants.O_RDONLY | NOFOLLOW); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') return null;
    throw e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) throw tooLarge();
    const bytes = await readBounded(handle, maxBytes);
    return hashOf(bytes) === revision ? bytes : null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Replace a small file of this module whole. */
async function writeNote(file, value, io) {
  const temp = `${file}.tdag-note-${randomUUID().slice(0, 8)}`;
  const handle = await io.open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await io.rename(temp, file); } catch (e) { await io.rm(temp, { force: true }).catch(() => {}); throw e; }
}

const trashRoot = (rootPath) => path.join(recoveryRoot(rootPath), 'trash');
const noteOf = (rootPath, receiptId) => path.join(trashRoot(rootPath), `${receiptId}.json`);

/**
 * A note, read. Null when there is none, or when what is there is not a
 * note (not JSON): there is nothing in it to go by. A note that is there and
 * cannot be read now (the disk failed) is not taken for no note: that is
 * thrown, and whoever asked tries again later rather than act without it.
 */
async function readNoteFile(file, io) {
  let text;
  try { text = await io.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Move a file or a folder into the recovery area instead of the system
 * trash. It stays in the workspace's records until someone restores or
 * clears it. `note` says what it is and where it was (see the RecoveryItem
 * contract; a folder's note also lists the registered files in it), and is
 * written before the move: something in the recovery area always has its
 * note. Resolves with where it went, relative to the recovery area.
 */
async function moveToRecoveryTrash(rootPath, receiptId, absolute, io = fs.promises, note = null) {
  const dir = path.join(trashRoot(rootPath), receiptId);
  await io.mkdir(dir, { recursive: true });
  if (note) await writeNote(noteOf(rootPath, receiptId), note, io);
  const target = path.join(dir, path.basename(absolute));
  try { await io.rename(absolute, target); } catch (e) {
    await io.rm(noteOf(rootPath, receiptId), { force: true }).catch(() => {});
    await io.rmdir(dir).catch(() => {});
    throw e;
  }
  return path.join('trash', receiptId, path.basename(absolute));
}

/**
 * What is in the recovery area's trash: for each receipt, its note (null
 * for one trashed before notes were written) and where its content is.
 * A receipt whose content is no longer there is not listed.
 */
async function listRecoveryTrash(rootPath, io = fs.promises) {
  let entries;
  try { entries = await io.readdir(trashRoot(rootPath), { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const inside = await io.readdir(path.join(trashRoot(rootPath), entry.name)).catch(() => []);
    if (inside.length !== 1) continue; // empty: already put back, or never arrived
    const note = await readNoteFile(noteOf(rootPath, entry.name), io);
    found.push({ receiptId: entry.name, note, content: path.join(trashRoot(rootPath), entry.name, inside[0]), name: inside[0] });
  }
  return found;
}

/** The note kept for a receipt (what it is, where it was, whose files it holds), or null. It is there from before the move into the recovery area until the receipt is cleared. A note that cannot be read now is an error, not null. */
async function readRecoveryNote(rootPath, receiptId, io = fs.promises) {
  return readNoteFile(noteOf(rootPath, receiptId), io);
}

/**
 * Give the files named in the recovery area's notes other identities:
 * `renamed` maps the id a note holds to the id it should hold. What a copy
 * of a workspace needs, whose notes were copied naming the original's
 * files. A note that names none of them is left as it is.
 */
async function renameInRecoveryNotes(rootPath, renamed, io = fs.promises) {
  let names;
  try { names = await io.readdir(trashRoot(rootPath)); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(trashRoot(rootPath), name);
    // a note that cannot be read now stops the renaming: a copy whose notes still name the original's files is not done
    const note = await readNoteFile(file, io);
    if (!note) continue;
    let changed = false;
    if (typeof note?.fileId === 'string' && renamed.has(note.fileId)) { note.fileId = renamed.get(note.fileId); changed = true; }
    for (const f of Array.isArray(note?.files) ? note.files : []) {
      if (typeof f?.fileId === 'string' && renamed.has(f.fileId)) { f.fileId = renamed.get(f.fileId); changed = true; }
    }
    if (changed) await writeNote(file, note, io);
  }
}

/** Forget a receipt whose content was put back: its note and its now empty folder. */
async function clearRecoveryReceipt(rootPath, receiptId, io = fs.promises) {
  await io.rm(noteOf(rootPath, receiptId), { force: true }).catch(() => {});
  await io.rmdir(path.join(trashRoot(rootPath), receiptId)).catch(() => {});
}

/** The earlier versions kept for a file: `{ revision, keptAt, size }`, newest first. */
async function listPreviousVersions(rootPath, fileId, io = fs.promises) {
  const dir = path.join(recoveryRoot(rootPath), 'versions', fileId);
  let names;
  try { names = await io.readdir(dir); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const versions = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue; // a copy still being written
    const stat = await io.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) versions.push({ revision: `sha256:${name}`, keptAt: new Date(stat.mtimeMs).toISOString(), size: stat.size, at: stat.mtimeMs });
  }
  return versions.sort((a, b) => b.at - a.at).map(({ at: _at, ...version }) => version);
}

module.exports = { readBounded, keepPreviousVersion, readPreviousVersion, listPreviousVersions, moveToRecoveryTrash, listRecoveryTrash, readRecoveryNote, renameInRecoveryNotes, clearRecoveryReceipt, recoveryRoot, RECOVERY_DIR };

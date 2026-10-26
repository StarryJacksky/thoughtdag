// The canvas's local backup, written by the HOST (#66).
//
// The File System Access API needs a directory handle, and Chromium's own
// picker never returns inside the harness frame on Windows — the canvas cannot
// write the file itself there. So the canvas keeps the absolute path the
// harness's own picker handed it and asks the host to write instead.
//
// This lives beside the agent runtimes rather than inline in the plugin, so the
// path rules can be tested without a harness: scripts/test-backup-write.mjs.
// Pure Node, no harness context.
'use strict';
const { randomBytes } = require('node:crypto');
const { mkdir, open, rename, unlink } = require('node:fs/promises');
const { basename, dirname, isAbsolute, join, resolve, sep } = require('node:path');

/** An error the endpoint should report as 400 rather than 500. */
class BackupRequestError extends Error {}

/** target path → the end of the last write queued for it */
const queued = new Map();

/** Run `work` after every write to `target` asked for before it, so the last one asked for is the one left on disk. */
function inTurn(target, work) {
  const run = (queued.get(target) ?? Promise.resolve()).then(work);
  const tail = run.catch(() => {});
  queued.set(target, tail);
  tail.then(() => { if (queued.get(target) === tail) queued.delete(target); });
  return run;
}

/**
 * Put `json` at `target` whole or not at all: it is written to a file of
 * its own beside the target, flushed to the disk, and only then renamed
 * over the target. A write that fails on the way (a full disk, an I/O
 * error, the process ending) leaves the previous backup as it was, and
 * the file of its own is removed.
 */
async function publish(target, json) {
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(json, 'utf8');
    await handle.sync();
    const written = handle;
    handle = null;
    await written.close();
    await rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Write one canvas backup under `dir`.
 *
 * @param {{ dir: unknown, name: unknown, json: unknown }} body the request body
 * @returns {Promise<string>} the absolute file written
 * @throws {BackupRequestError} when the request itself is not writable
 */
async function writeBackup(body) {
  const dir = typeof body?.dir === 'string' ? body.dir : '';
  const name = typeof body?.name === 'string' ? body.name : '';
  const json = typeof body?.json === 'string' ? body.json : null;
  // an absolute path is the whole safety property: a relative one would resolve
  // against the plugin's cwd, which the canvas cannot know.
  // isAbsolute, NOT resolve(dir).startsWith(sep) — on Windows a drive path
  // starts with "C:" and would never match the separator, so that test refuses
  // every real request there while passing on POSIX.
  if (!dir || !isAbsolute(dir) || !name || json === null) {
    throw new BackupRequestError('dir must be an absolute path; name and json are required');
  }
  // `name` is a RELATIVE path the canvas chose (native canvases at the folder
  // root, session mirrors under cli/), so it is sanitized segment by segment
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new BackupRequestError('name must have at least one path segment');
  const last = parts[parts.length - 1].replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120);
  if (!last) throw new BackupRequestError('name resolves to an empty file name');
  const target = resolve(dir, ...parts.slice(0, -1), last);
  // Belt and braces, and it has to agree with the gate above: compare against
  // resolve(dir) — NOT resolve(dir) + sep, which would reject a Windows path
  // for the same reason the startsWith(sep) test did.
  const inside = resolve(dir);
  if (target !== inside && !target.startsWith(inside.endsWith(sep) ? inside : inside + sep)) {
    throw new BackupRequestError('name escapes the backup directory');
  }
  await mkdir(dirname(target), { recursive: true });
  await inTurn(target, () => publish(target, json));
  return target;
}

module.exports = { writeBackup, BackupRequestError };

// Where a workspace operation may land. Every file operation the renderer
// asks for names a granted root and a path relative to it; this is the one
// place that decides whether that path is inside the root, for that
// operation, and returns the real location to act on.
//
// The check is on the resolved path, not the string: every existing part of
// the target is resolved through its symbolic links and must still be inside
// the root. A name that would not survive a move to another platform is
// refused when it is being created, so a workspace stays portable.
//
// What this does not do: it cannot stop another program from swapping a
// directory for a link between this check and the operation. Callers that
// write hold the opened handle to the check (see file-ops) rather than trust
// the path twice.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

class WorkspaceAccessError extends Error {
  /** `code` is stable and safe to show; the message never carries an absolute path. */
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.code = code;
  }
}

/** The workspace's own records live here; no renderer operation reaches in. */
const METADATA_DIR = '.thoughtdag';
const READS = new Set(['list', 'read', 'stat']);
// operations whose target need not exist yet
const DESTINATIONS = new Set(['create', 'move-to']);
const OPERATIONS = new Set([...READS, ...DESTINATIONS, 'write', 'move-from', 'trash']);

// device names Windows reserves, with or without an extension
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// characters Windows forbids in a name, and control characters
const FORBIDDEN_CHAR = /[<>:"|?*\u0000-\u001f]/;
const MAX_NAME = 255;

/** A name that is legal on every platform this app runs on. */
function assertPortableName(name) {
  if (typeof name !== 'string' || name === '') throw new WorkspaceAccessError('invalid-name', 'the name is empty');
  if (name === '.' || name === '..') throw new WorkspaceAccessError('traversal', 'the name is a directory step, not a name');
  if (/[\\/]/.test(name)) throw new WorkspaceAccessError('invalid-name', 'the name contains a path separator');
  if (FORBIDDEN_CHAR.test(name)) throw new WorkspaceAccessError('invalid-name', 'the name contains a character some platforms forbid');
  if (RESERVED_NAME.test(name)) throw new WorkspaceAccessError('reserved-name', 'the name is reserved on Windows');
  if (/[. ]$/.test(name)) throw new WorkspaceAccessError('invalid-name', 'the name ends with a dot or a space');
  if (Buffer.byteLength(name) > MAX_NAME) throw new WorkspaceAccessError('invalid-name', 'the name is too long');
  return name;
}

/** The steps of a relative path. Absolute paths in any dialect, drive
 *  letters, UNC shares, NUL and `..` are refused here, before any disk access. */
function splitRelative(relativePath) {
  if (typeof relativePath !== 'string') throw new WorkspaceAccessError('invalid-path', 'the path must be a string');
  if (relativePath.includes('\0')) throw new WorkspaceAccessError('invalid-path', 'the path contains a NUL');
  if (/^[\\/]/.test(relativePath) || /^[A-Za-z]:/.test(relativePath)) throw new WorkspaceAccessError('absolute-path', 'the path must be relative to the workspace');
  // both separators count on every platform, so one stored path means one place everywhere
  const steps = relativePath.split(/[\\/]+/).filter((s) => s !== '');
  for (const step of steps) {
    if (step === '.' || step === '..') throw new WorkspaceAccessError('traversal', 'the path steps out of its directory');
    if (Buffer.byteLength(step) > MAX_NAME) throw new WorkspaceAccessError('invalid-path', 'a name in the path is too long');
  }
  return steps;
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * Check `relativePath` under `grant` for `operation` and resolve it.
 *
 * `grant` is `{ rootPath, readOnly }`, a root the person chose in the system
 * picker. Operations: list, read, stat (the target must exist), write,
 * move-from, trash (it must exist and the root must be writable), create,
 * move-to (a destination: its parent must exist, it need not).
 *
 * Resolves with `{ absolute, relativePath, exists, kind }`: the real location,
 * the path in its stored form (forward slashes), whether the target exists,
 * and what it is ('file', 'directory', 'other', or null when absent).
 * Rejects with a WorkspaceAccessError.
 */
async function assertAllowedPath(grant, operation, relativePath) {
  if (!grant || typeof grant.rootPath !== 'string' || !path.isAbsolute(grant.rootPath)) throw new WorkspaceAccessError('no-grant', 'no workspace root was granted');
  if (!OPERATIONS.has(operation)) throw new WorkspaceAccessError('unknown-operation', `"${operation}" is not a workspace operation`);
  const steps = splitRelative(relativePath);
  if (steps.length > 0 && steps[0].toLowerCase() === METADATA_DIR) throw new WorkspaceAccessError('metadata-directory', 'the workspace\'s own records are not reachable as files');
  if (grant.readOnly && !READS.has(operation)) throw new WorkspaceAccessError('read-only', 'this workspace is read-only');
  if (steps.length === 0 && !READS.has(operation)) throw new WorkspaceAccessError('invalid-path', 'the workspace root itself cannot be changed');
  if (DESTINATIONS.has(operation)) assertPortableName(steps[steps.length - 1]);

  let root;
  try { root = await fsp.realpath(grant.rootPath); } catch { throw new WorkspaceAccessError('root-missing', 'the workspace folder is not there'); }

  // resolve the deepest part that exists through every link on the way
  const missing = [];
  let probe = path.join(root, ...steps);
  let real;
  for (;;) {
    try { real = await fsp.realpath(probe); break; } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new WorkspaceAccessError('unreadable', 'the path could not be resolved');
      if (probe === root) throw new WorkspaceAccessError('root-missing', 'the workspace folder is not there');
      missing.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
  if (!inside(root, real)) throw new WorkspaceAccessError('escapes-root', 'the path leads outside the workspace');

  const exists = missing.length === 0;
  if (!exists && !DESTINATIONS.has(operation)) throw new WorkspaceAccessError('not-found', 'nothing is at that path');
  if (missing.length > 1) throw new WorkspaceAccessError('not-found', 'the folder it would go in does not exist');

  let kind = null;
  if (exists) {
    const stat = await fsp.stat(real);
    kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    if (operation === 'list' && kind !== 'directory') throw new WorkspaceAccessError('not-a-directory', 'only a folder can be listed');
    if (operation === 'read' && kind !== 'file') throw new WorkspaceAccessError('not-a-file', 'only a regular file can be read');
    if (!READS.has(operation)) {
      // a change is made to the thing named, never through a link standing in for it
      const lexical = path.join(root, ...steps);
      const link = await fsp.lstat(lexical).then((s) => s.isSymbolicLink(), () => false);
      if (link) throw new WorkspaceAccessError('symbolic-link', 'a symbolic link is not changed through the workspace');
      if (kind === 'other') throw new WorkspaceAccessError('not-a-file', 'only regular files and folders can be changed');
    }
  } else {
    const parent = await fsp.stat(real);
    if (!parent.isDirectory()) throw new WorkspaceAccessError('not-a-directory', 'the place it would go in is not a folder');
  }

  return { absolute: exists ? real : path.join(real, ...missing), relativePath: steps.join('/'), exists, kind };
}

module.exports = { assertAllowedPath, assertPortableName, splitRelative, WorkspaceAccessError, METADATA_DIR };

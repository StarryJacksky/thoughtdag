// Catching up with what other programs did to a workspace's files: an edit,
// a rename, a move, a deletion. `reconcile` looks at one registered file and
// brings its record in line with the disk; `rescan` does that for all of
// them; `relink` is the person saying where a lost file went.
//
// The rules of evidence:
//   - A file at the path it was last seen at is the same document, however
//     it got there, unless that path was once seen empty. An editor that
//     saves by replacing the file is not a new document.
//   - A path once seen empty is not trusted again by name. What appears
//     there later is that document only if it is provably the same file
//     (same file-system identity) or holds the same content.
//   - A file that is gone is followed by file-system identity first, then by
//     content. A name alone is never evidence.
//   - Two candidates that fit equally well are an ambiguity, not a guess.
// File-system identity (device and inode) is used as evidence at the moment
// of looking; it is never the identity of the document, which is its fileId.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertAllowedPath, WorkspaceAccessError, METADATA_DIR } = require('./path-policy.cjs');
const { mediaTypeOf } = require('./media-types.cjs');
const { hashOf } = require('./file-ops.cjs');

/** A search for a moved file gives up past this many entries and says the file is missing. */
const MAX_SCAN = 20000;
const observedOf = (stat) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const sameIdentity = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const untouched = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * The reconciler of one workspace.
 *   grant     { rootPath, readOnly, ... }
 *   registry  see registry.cjs
 * Every method resolves with `{ record, change }`; `change` is null when the
 * record already matched the disk, else one of 'content', 'moved',
 * 'missing', 'ambiguous', 'restored'.
 */
function createReconciler({ grant, registry, io = fs.promises }) {
  const absoluteOf = (relativePath) => path.join(grant.rootPath, ...relativePath.split('/'));

  /** The regular file at a relative path, with its path as the disk spells it, or null. */
  async function fileAt(relativePath) {
    let target;
    try { target = await assertAllowedPath(grant, 'stat', relativePath); } catch (e) {
      if (e instanceof WorkspaceAccessError) return null; // gone, or no longer inside the workspace
      throw e;
    }
    if (target.kind !== 'file') return null;
    const root = await io.realpath(grant.rootPath);
    const stat = await io.stat(target.absolute);
    // a rename that only changes case finds the file under the old spelling: take the disk's
    return { absolute: target.absolute, relativePath: path.relative(root, target.absolute).split(path.sep).join('/'), stat };
  }

  async function contentOf(absolute) {
    const handle = await io.open(absolute, 'r');
    try { return hashOf(await handle.readFile()); } finally { await handle.close(); }
  }

  /** Every regular file in the workspace that no other live record claims. */
  async function unclaimedFiles(exceptFileId) {
    const claimed = new Set((await registry.all()).filter((r) => r.fileId !== exceptFileId && r.status !== 'missing' && r.status !== 'ambiguous').map((r) => r.relativePath));
    const found = [];
    let seen = 0;
    const walk = async (relativeDir) => {
      let entries;
      try { entries = await io.readdir(absoluteOf(relativeDir), { withFileTypes: true }); } catch { return true; }
      for (const entry of entries) {
        if (++seen > MAX_SCAN) return false;
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (!relativeDir && entry.name.toLowerCase() === METADATA_DIR) continue;
        if (entry.isDirectory()) { if (!(await walk(relativePath))) return false; }
        else if (entry.isFile() && !claimed.has(relativePath)) {
          const stat = await io.stat(absoluteOf(relativePath)).catch(() => null);
          if (stat) found.push({ relativePath, stat });
        }
      }
      return true;
    };
    const complete = await walk('');
    return { found, complete };
  }

  const settle = async (fileId, patch, observed, change) => ({ record: await registry.update(fileId, patch, observed), change });

  async function reconcile(fileId) {
    const entry = await registry.entry(fileId);
    if (!entry) throw new WorkspaceAccessError('unknown-file', 'that file is not known to this workspace');
    const { record, observed } = entry;
    const lost = record.status === 'missing' || record.status === 'ambiguous';
    const live = grant.readOnly ? 'readonly' : 'ready';
    const here = await fileAt(record.relativePath);

    if (here && !lost) {
      const renamed = here.relativePath !== record.relativePath ? { relativePath: here.relativePath, mediaType: mediaTypeOf(here.relativePath) } : {};
      if (untouched(here.stat, observed) && record.revision && !renamed.relativePath) return { record, change: null };
      const revision = await contentOf(here.absolute);
      if (revision === record.revision && !renamed.relativePath) return settle(fileId, {}, observedOf(here.stat), null);
      return settle(fileId, { ...renamed, revision }, observedOf(here.stat), revision === record.revision ? 'moved' : 'content');
    }

    if (here && lost) {
      // the path was seen empty: what is there now must prove it is the same file
      const revision = await contentOf(here.absolute);
      const proven = sameIdentity(here.stat, observed) || (here.stat.size > 0 && !!record.revision && revision === record.revision);
      if (!proven) return { record, change: null };
      return settle(fileId, { relativePath: here.relativePath, revision, status: live }, observedOf(here.stat), 'restored');
    }

    // nothing at the path: look for where the file went
    const { found, complete } = await unclaimedFiles(fileId);
    const byIdentity = found.filter((c) => sameIdentity(c.stat, observed));
    const candidates = [...byIdentity];
    if (candidates.length === 0 && record.revision && observed && observed.size > 0) {
      for (const c of found.filter((f) => f.stat.size === observed.size)) {
        if (await contentOf(absoluteOf(c.relativePath)).catch(() => null) === record.revision) candidates.push(c);
      }
    }
    if (candidates.length === 1 && complete) {
      const [moved] = candidates;
      const revision = await contentOf(absoluteOf(moved.relativePath));
      return settle(fileId, { relativePath: moved.relativePath, mediaType: mediaTypeOf(moved.relativePath), revision, status: live }, observedOf(moved.stat), 'moved');
    }
    const status = candidates.length > 1 ? 'ambiguous' : 'missing';
    if (record.status === status) return { record, change: null };
    return settle(fileId, { status }, undefined, status);
  }

  return {
    reconcile,

    /** Reconcile every registered file. Resolves with the ones that changed. */
    async rescan() {
      const changes = [];
      for (const record of await registry.all()) {
        const result = await reconcile(record.fileId).catch(() => null);
        if (result && result.change) changes.push(result);
      }
      return changes;
    },

    /**
     * The person says the lost file is the one at `relativePath`. That file
     * must exist, be inside the workspace, and not be another registered file.
     */
    async relink(fileId, relativePath) {
      const entry = await registry.entry(fileId);
      if (!entry) throw new WorkspaceAccessError('unknown-file', 'that file is not known to this workspace');
      const target = await assertAllowedPath(grant, 'read', relativePath);
      const here = await fileAt(target.relativePath);
      if (!here) throw new WorkspaceAccessError('not-found', 'nothing is at that path');
      const other = await registry.findByPath(here.relativePath);
      if (other && other.fileId !== fileId && other.status !== 'missing' && other.status !== 'ambiguous') throw new WorkspaceAccessError('claimed', 'that file is already another registered file');
      const revision = await contentOf(here.absolute);
      const change = entry.record.status === 'missing' || entry.record.status === 'ambiguous' ? 'restored' : 'moved';
      return settle(fileId, { relativePath: here.relativePath, mediaType: mediaTypeOf(here.relativePath), revision, status: grant.readOnly ? 'readonly' : 'ready' }, observedOf(here.stat), change);
    },
  };
}

module.exports = { createReconciler, MAX_SCAN };

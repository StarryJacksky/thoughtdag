// File operations on one local workspace: create, read, save, move, copy,
// trash. Each one is a small transaction: it writes what it is about to do
// to the journal, does it, records the result, and marks it done. The same
// opId asked again returns the same answer without doing the work again, and
// an operation a crash cut short is settled the next time the workspace is
// used (see `reconcile`).
//
// What a save promises: `saved` is returned only after the new content is in
// place. A file that changed since the caller read it is a `conflict` and is
// left alone, including when the change lands while the save is under way.
// The content a save replaces is kept in the recovery area first.
//
// What it cannot promise: another program that writes the file between the
// last check and the replacement is not seen. The window is one rename wide;
// no file system offers this application a compare-and-swap across programs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assertAllowedPath, assertPortableName, WorkspaceAccessError } = require('./path-policy.cjs');
const { mediaTypeOf } = require('./media-types.cjs');
const { keepPreviousVersion, moveToRecoveryTrash } = require('./recovery.cjs');

/** Text above this size is not opened for editing. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/** Where files created from the graph land, at the workspace root. */
const GRAPH_FILES_DIR = 'Graph Files';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// following a link on the last step is refused where the platform can say so
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const hashOf = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const observedOf = (stat) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const pad3 = (n) => String(n).padStart(3, '0');
const join = (parent, name) => (parent ? `${parent}/${name}` : name);

/** The smallest content each new file type is legal with. */
function templateFor(extension, { newId = randomUUID } = {}) {
  switch (extension.toLowerCase()) {
    case 'json': return '{}\n';
    case 'html': case 'htm': return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title></title>\n</head>\n<body>\n</body>\n</html>\n';
    case 'tdmap': return JSON.stringify({
      format: 'thoughtdag-mindmap', schemaVersion: '1.0', documentId: `map_${newId()}`, title: '',
      roots: ['n1'], nodes: [{ id: 'n1', text: '', children: [] }], relations: [], sources: [], payloads: [],
      layout: { positions: {}, collapsed: [] },
    }, null, 2) + '\n';
    default: return '';
  }
}

/** Bytes as editable text, or a refusal: only valid UTF-8 is opened for editing. */
function decodeText(bytes) {
  const bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes); } catch {
    throw new WorkspaceAccessError('not-utf8', 'the file is not UTF-8 text; it is not opened for editing');
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { text, encoding: bom ? 'utf-8-bom' : 'utf-8', newline: crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf' };
}

/**
 * The file operations of one workspace.
 *   grant     { rootGrantId, rootPath, workspaceId, readOnly }
 *   registry  see registry.cjs
 *   journal   see journal.cjs
 *   trash     optional `(absolutePath) => Promise<void>`: the system trash
 *   io        the file-system calls used, replaceable in tests to inject faults
 */
function createFileOps({ grant, registry, journal, trash = null, io = fs.promises, now = () => new Date().toISOString(), newId = randomUUID }) {
  // one operation at a time per file: a save never interleaves with a move of the same file
  const chains = new Map();
  const locked = (key, fn) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    chains.set(key, run.catch(() => {}));
    return run;
  };

  async function recordOf(fileId) {
    const record = await registry.get(fileId);
    if (!record) throw new WorkspaceAccessError('unknown-file', 'that file is not known to this workspace');
    return record;
  }

  const isLost = (record) => record.status === 'missing' || record.status === 'ambiguous';
  /** A lost file's path may now hold some other file: nothing acts on it until it is found again. */
  async function liveRecordOf(fileId) {
    const record = await recordOf(fileId);
    if (isLost(record)) throw new WorkspaceAccessError('lost', 'the file is lost; it has to be found again first');
    return record;
  }

  /** Read the bytes at a checked location, through a handle that is verified to be a regular file. */
  async function readChecked(absolute, limit = Infinity) {
    const handle = await io.open(absolute, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new WorkspaceAccessError('not-a-file', 'only a regular file can be read');
      if (stat.size > limit) throw new WorkspaceAccessError('too-large', 'the file is too large to open for editing');
      return { bytes: await handle.readFile(), stat };
    } finally {
      await handle.close();
    }
  }

  async function syncDirectory(dir) {
    // makes the rename itself durable; not every platform lets a directory be opened
    try { const handle = await io.open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch { /* best effort */ }
  }

  /** A previous answer for this opId, if the operation already finished. */
  async function finished(opId, kind) {
    if (typeof opId !== 'string' || !opId) throw new WorkspaceAccessError('invalid-operation', 'the operation has no id');
    const done = await journal.completed(opId);
    if (!done) return null;
    if (done.kind !== kind) throw new WorkspaceAccessError('invalid-operation', 'that operation id was used for something else');
    return done;
  }

  /** The first free `<stem>.<ext>`, `<stem>-2.<ext>`, … or numbered `Untitled-001.<ext>`, created exclusively. */
  async function createExclusive(parent, candidates, bytes, mode) {
    for (const name of candidates) {
      const target = await assertAllowedPath(grant, 'create', join(parent, name));
      if (target.exists) continue;
      let handle;
      try { handle = await io.open(target.absolute, 'wx', mode); } catch (e) {
        if (e.code === 'EEXIST') continue; // another creator took the name first
        throw e;
      }
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        return { target, stat: await handle.stat() };
      } catch (e) {
        await handle.close().catch(() => {});
        handle = null;
        await io.rm(target.absolute, { force: true }).catch(() => {});
        throw e;
      } finally {
        if (handle) await handle.close();
      }
    }
    throw new WorkspaceAccessError('no-free-name', 'no free name was found for the new file');
  }

  function* numbered(prefix, extension) {
    for (let n = 1; n <= 9999; n++) yield `${prefix}-${pad3(n)}.${extension}`;
  }
  function* named(stem, extension) {
    yield `${stem}.${extension}`;
    for (let n = 2; n <= 999; n++) yield `${stem}-${n}.${extension}`;
  }

  const refuseReadOnly = () => { if (grant.readOnly) throw new WorkspaceAccessError('read-only', 'this workspace is read-only'); };

  const api = {
    /**
     * Create a file. `request` is a CreateFileRequest with `parentId` already
     * resolved to `parentRelativePath`. A graph-origin file goes to the
     * workspace's Graph Files folder whatever the caller named. With
     * `content` the file starts with it (an import); with `name` it is
     * called that, and numbered only if the name is taken.
     */
    async createFile({ extension, origin, idempotencyKey, parentRelativePath = '' }, { content = null, name = null, importedFrom = null } = {}) {
      refuseReadOnly();
      const done = await finished(idempotencyKey, 'create');
      if (done) return recordOf(done.fileId);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(String(extension))) throw new WorkspaceAccessError('invalid-name', 'that is not a file extension');
      if (name !== null) assertPortableName(`${name}.${extension}`);

      let parent = parentRelativePath;
      if (origin === 'graph') {
        parent = GRAPH_FILES_DIR;
        const dir = await assertAllowedPath(grant, 'create', GRAPH_FILES_DIR);
        if (!dir.exists) await io.mkdir(dir.absolute);
      }
      await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'intent', parent, extension, origin });

      const text = content ?? templateFor(extension, { newId });
      const bytes = Buffer.from(text, 'utf8');
      const candidates = name !== null ? named(name, extension) : numbered(extension.toLowerCase() === 'tdmap' ? 'Mindmap' : 'Untitled', extension);
      let created;
      try { created = await createExclusive(parent, candidates, bytes, 0o644); } catch (e) {
        await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'failed' });
        throw e;
      }
      // from here the file exists: whatever fails next, it is kept and found again
      await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'created', relativePath: created.target.relativePath, origin: importedFrom ? 'import' : origin, revision: hashOf(bytes), ...(importedFrom ? { importedFrom } : {}) });
      const record = await registry.register({
        relativePath: created.target.relativePath,
        mediaType: mediaTypeOf(created.target.relativePath),
        origin: importedFrom ? 'import' : origin,
        observed: observedOf(created.stat),
        revision: hashOf(bytes),
        ...(importedFrom ? { importedFrom } : {}),
      });
      await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'done', fileId: record.fileId });
      return record;
    },

    /** The file's text and the revision a later save must name. */
    async readText(fileId) {
      const record = await liveRecordOf(fileId);
      const target = await assertAllowedPath(grant, 'read', record.relativePath);
      const { bytes, stat } = await readChecked(target.absolute, MAX_EDITABLE_BYTES);
      const decoded = decodeText(bytes);
      const revision = hashOf(bytes);
      if (record.revision !== revision && !grant.readOnly) await registry.update(fileId, { revision }, observedOf(stat)).catch(() => {});
      return { text: decoded.text, revision, encoding: decoded.encoding, newline: decoded.newline };
    },

    /**
     * Replace the file's text, if it still holds what the caller read
     * (`baseRevision`). Resolves with a SaveResult; it does not reject for a
     * conflict, a read-only file or a full disk.
     */
    saveText: (fileId, baseRevision, text, opId) => locked(fileId, async () => {
      const done = await finished(opId, 'save');
      if (done) return { status: 'saved', revision: done.revision, sourceRevision: null };
      if (grant.readOnly) return { status: 'readonly', reason: 'this workspace is read-only' };
      if (typeof text !== 'string') return { status: 'error', reason: 'the content is not text' };
      const record = await recordOf(fileId);
      if (isLost(record)) return { status: 'conflict', currentRevision: null };

      let target;
      try { target = await assertAllowedPath(grant, 'write', record.relativePath); } catch (e) {
        if (e instanceof WorkspaceAccessError && e.code === 'not-found') return { status: 'conflict', currentRevision: null };
        throw e;
      }
      let temp = null;
      try {
        const current = await readChecked(target.absolute);
        const currentRevision = hashOf(current.bytes);
        if (currentRevision !== baseRevision) return { status: 'conflict', currentRevision };
        // text in another encoding is never overwritten with a guess at what it said
        try { decodeText(current.bytes); } catch { return { status: 'error', reason: 'the file is not UTF-8 text; it is not overwritten' }; }

        // the file keeps its encoding mark; only UTF-8 is ever written
        const hadBom = current.bytes.length >= 3 && current.bytes.subarray(0, 3).equals(UTF8_BOM);
        const next = hadBom ? Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8');
        const revision = hashOf(next);
        if (revision === currentRevision) return { status: 'saved', revision, sourceRevision: null };

        temp = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.tdag-save-${newId().slice(0, 8)}`);
        await journal.append({ opId, kind: 'save', phase: 'intent', fileId, base: baseRevision, next: revision, temp: path.basename(temp) });
        const handle = await io.open(temp, 'wx', current.stat.mode & 0o777);
        try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
        await keepPreviousVersion(grant.rootPath, fileId, currentRevision, current.bytes);

        // the last look before the replacement: anything that changed since the first read stops it
        const again = await readChecked(target.absolute);
        if (hashOf(again.bytes) !== currentRevision) {
          await io.rm(temp, { force: true });
          await journal.append({ opId, kind: 'save', phase: 'failed' });
          return { status: 'conflict', currentRevision: hashOf(again.bytes) };
        }
        await io.rename(temp, target.absolute);
        temp = null;
        await syncDirectory(path.dirname(target.absolute));

        // the content is in place; the registry catching up cannot undo that
        const stat = await io.stat(target.absolute).catch(() => null);
        await registry.update(fileId, { revision }, stat ? observedOf(stat) : undefined).catch(() => {});
        await journal.append({ opId, kind: 'save', phase: 'done', fileId, revision });
        return { status: 'saved', revision, sourceRevision: null };
      } catch (e) {
        if (temp) await io.rm(temp, { force: true }).catch(() => {});
        await journal.append({ opId, kind: 'save', phase: 'failed' }).catch(() => {});
        if (e instanceof WorkspaceAccessError) return { status: 'error', reason: e.message };
        if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) return { status: 'readonly', reason: 'the file cannot be written' };
        if (e.code === 'ENOSPC') return { status: 'error', reason: 'the disk is full' };
        return { status: 'error', reason: 'the save did not complete' };
      }
    }),

    /** Move or rename a file inside the workspace. It keeps its fileId. */
    moveFile: (fileId, targetParentRelativePath, newName, opId) => locked(fileId, async () => {
      refuseReadOnly();
      const done = await finished(opId, 'move');
      if (done) return recordOf(fileId);
      const record = await liveRecordOf(fileId);
      const source = await assertAllowedPath(grant, 'move-from', record.relativePath);
      const destination = await assertAllowedPath(grant, 'move-to', join(targetParentRelativePath, newName));
      if (destination.exists) {
        // the same file under a name that differs only in case is a rename, not a collision
        const [a, b] = await Promise.all([io.stat(source.absolute), io.stat(destination.absolute)]);
        if (a.dev !== b.dev || a.ino !== b.ino) throw new WorkspaceAccessError('exists', 'something is already at that name');
      }
      await journal.append({ opId, kind: 'move', phase: 'intent', fileId, from: source.relativePath, to: destination.relativePath });
      try { await io.rename(source.absolute, destination.absolute); } catch (e) {
        await journal.append({ opId, kind: 'move', phase: 'failed' });
        throw e.code === 'EXDEV' ? new WorkspaceAccessError('cross-device', 'the file cannot be moved to another disk this way') : e;
      }
      const stat = await io.stat(destination.absolute);
      const moved = await registry.update(fileId, { relativePath: destination.relativePath, mediaType: mediaTypeOf(destination.relativePath) }, observedOf(stat));
      await journal.append({ opId, kind: 'move', phase: 'done', fileId });
      return moved;
    }),

    /** Copy a file inside the workspace. The copy is a new file with a new fileId. */
    copyFile: (fileId, targetParentRelativePath, newName, opId) => locked(fileId, async () => {
      refuseReadOnly();
      const done = await finished(opId, 'copy');
      if (done) return recordOf(done.fileId);
      const record = await liveRecordOf(fileId);
      const source = await assertAllowedPath(grant, 'read', record.relativePath);
      const destination = await assertAllowedPath(grant, 'create', join(targetParentRelativePath, newName));
      if (destination.exists) throw new WorkspaceAccessError('exists', 'something is already at that name');
      await journal.append({ opId, kind: 'copy', phase: 'intent', fileId, to: destination.relativePath });
      try { await io.copyFile(source.absolute, destination.absolute, fs.constants.COPYFILE_EXCL); } catch (e) {
        await journal.append({ opId, kind: 'copy', phase: 'failed' });
        throw e.code === 'EEXIST' ? new WorkspaceAccessError('exists', 'something is already at that name') : e;
      }
      const { bytes, stat } = await readChecked(destination.absolute);
      const copy = await registry.register({ relativePath: destination.relativePath, mediaType: mediaTypeOf(destination.relativePath), origin: 'workspace', observed: observedOf(stat), revision: hashOf(bytes) });
      await journal.append({ opId, kind: 'copy', phase: 'done', fileId: copy.fileId });
      return copy;
    }),

    /**
     * Take a file out of the workspace without destroying it: to the system
     * trash when there is one, else to the workspace's recovery area. The
     * record stays, marked missing, so what refers to the file still knows it.
     */
    trashFile: (fileId, opId) => locked(fileId, async () => {
      refuseReadOnly();
      const done = await finished(opId, 'trash');
      if (done) return done.receipt;
      const record = await liveRecordOf(fileId);
      const source = await assertAllowedPath(grant, 'trash', record.relativePath);
      const receiptId = `trash_${newId()}`;
      await journal.append({ opId, kind: 'trash', phase: 'intent', fileId, relativePath: source.relativePath, receiptId });
      let location = 'project-recovery';
      try {
        if (trash) {
          try { await trash(source.absolute); location = 'system-trash'; } catch { /* no system trash here: keep it in the workspace instead */ }
        }
        if (location === 'project-recovery') await moveToRecoveryTrash(grant.rootPath, receiptId, source.absolute);
      } catch (e) {
        await journal.append({ opId, kind: 'trash', phase: 'failed' });
        throw e;
      }
      await registry.update(fileId, { status: 'missing' }).catch(() => {});
      const receipt = { receiptId, fileId, opId, location, restorable: true };
      await journal.append({ opId, kind: 'trash', phase: 'done', fileId, receipt });
      return receipt;
    }),

    /** Create a folder. Asking again for a folder that is there is not an error. */
    async createFolder(parentRelativePath, name) {
      refuseReadOnly();
      const target = await assertAllowedPath(grant, 'create', join(parentRelativePath, name));
      if (target.exists && target.kind !== 'directory') throw new WorkspaceAccessError('exists', 'a file is already at that name');
      if (!target.exists) await io.mkdir(target.absolute);
      return target.relativePath;
    },

    /**
     * Settle the operations a crash cut short. Nothing is deleted except this
     * module's own temp files: a file that was written is kept and given its
     * record; a save that did not land leaves the old content in place.
     */
    async reconcile() {
      if (grant.readOnly) return [];
      const settled = [];
      for (const op of await journal.pending()) {
        const last = (phase) => [...op.entries].reverse().find((e) => e.phase === phase);
        const intent = last('intent');
        let outcome = 'failed';
        try {
          if (op.kind === 'create') {
            const created = last('created');
            const there = created && await assertAllowedPath(grant, 'stat', created.relativePath).then((t) => t.kind === 'file', () => false);
            if (there) {
              const stat = await io.stat(path.join(grant.rootPath, created.relativePath));
              const record = await registry.register({ relativePath: created.relativePath, mediaType: mediaTypeOf(created.relativePath), origin: created.origin, observed: observedOf(stat), revision: created.revision, ...(created.importedFrom ? { importedFrom: created.importedFrom } : {}) });
              await journal.append({ opId: op.opId, kind: 'create', phase: 'done', fileId: record.fileId });
              outcome = 'completed';
            }
          } else if (op.kind === 'save' && intent) {
            const record = await registry.get(intent.fileId);
            if (record) {
              const dir = path.dirname(path.join(grant.rootPath, record.relativePath));
              await io.rm(path.join(dir, intent.temp), { force: true });
              const current = await readChecked(path.join(grant.rootPath, record.relativePath)).catch(() => null);
              if (current && hashOf(current.bytes) === intent.next) {
                await registry.update(intent.fileId, { revision: intent.next }, observedOf(current.stat));
                await journal.append({ opId: op.opId, kind: 'save', phase: 'done', fileId: intent.fileId, revision: intent.next });
                outcome = 'completed';
              }
            }
          } else if (op.kind === 'move' && intent) {
            const [from, to] = await Promise.all([intent.from, intent.to].map((p) => io.stat(path.join(grant.rootPath, p)).then((s) => s, () => null)));
            if (!from && to) {
              await registry.update(intent.fileId, { relativePath: intent.to, mediaType: mediaTypeOf(intent.to) }, observedOf(to));
              await journal.append({ opId: op.opId, kind: 'move', phase: 'done', fileId: intent.fileId });
              outcome = 'completed';
            }
          } else if (op.kind === 'trash' && intent) {
            const there = await io.stat(path.join(grant.rootPath, intent.relativePath)).then(() => true, () => false);
            if (!there) {
              await registry.update(intent.fileId, { status: 'missing' });
              // where it went was not recorded before the crash; it is not claimed to be restorable
              await journal.append({ opId: op.opId, kind: 'trash', phase: 'done', fileId: intent.fileId, receipt: { receiptId: intent.receiptId, fileId: intent.fileId, opId: op.opId, location: 'project-recovery', restorable: false } });
              outcome = 'completed';
            }
          }
          // a copy that did not finish is left as it is: a partial file is not registered, and not deleted
        } catch { outcome = 'failed'; }
        if (outcome === 'failed') await journal.append({ opId: op.opId, kind: op.kind, phase: 'failed' }).catch(() => {});
        settled.push({ opId: op.opId, kind: op.kind, outcome });
      }
      return settled;
    },
  };
  return api;
}

module.exports = { createFileOps, templateFor, decodeText, hashOf, MAX_EDITABLE_BYTES, GRAPH_FILES_DIR };

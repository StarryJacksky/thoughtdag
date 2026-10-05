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
//
// What a move promises: it never replaces a file. The file is given its new
// name with a hard link, which fails if anything is there, and only then
// loses its old one. Where a volume has no hard links the name is checked
// and then taken with a rename, inside a lock that keeps this application's
// own moves to that name apart; another program taking the name in that
// instant is the one case left.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assertAllowedPath, assertPortableName, WorkspaceAccessError } = require('./path-policy.cjs');
const { mediaTypeOf } = require('./media-types.cjs');
const { keepPreviousVersion, readPreviousVersion, listPreviousVersions, moveToRecoveryTrash, listRecoveryTrash, clearRecoveryReceipt } = require('./recovery.cjs');

/** Text above this size is not opened for editing. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/** Where files created from the graph land, at the workspace root. */
const GRAPH_FILES_DIR = 'Graph Files';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// following a link on the last step is refused where the platform can say so
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// what a volume answers when it cannot make a hard link at all
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

const hashOf = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
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
 *   notify    optional `(record, change)`: told when a read finds that a file
 *             was changed by another program, so everyone who refers to it hears
 */
function createFileOps({ grant, registry, journal, trash = null, io = fs.promises, now = () => new Date().toISOString(), newId = randomUUID, notify = () => {} }) {
  // One operation at a time per key. A file's id keeps a save from
  // interleaving with a move of the same file; a path keeps two moves of two
  // files from reaching for the same name together.
  const chains = new Map();
  const locked = (key, fn) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    chains.set(key, settled);
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
    return run;
  };
  const atPath = (relativePath, fn) => locked(`path:${relativePath.toLowerCase()}`, fn);

  // A folder that is moved or trashed takes every file in it along. While
  // that happens nothing else changes the workspace: whatever was under way
  // finishes first, and whatever is asked meanwhile waits for the folder.
  // `changing` wraps every operation that changes a file; `rearranging`
  // wraps the ones that move a folder. (The per-key locks above are taken
  // inside a `changing` operation and never wait on a folder themselves.)
  const underWayNow = new Set();
  let folderWork = Promise.resolve();
  const changing = (fn) => {
    const gate = folderWork;
    const run = (async () => { await gate.catch(() => {}); return fn(); })();
    underWayNow.add(run);
    const over = () => underWayNow.delete(run);
    run.then(over, over);
    return run;
  };
  const rearranging = (fn) => {
    const others = [...underWayNow];
    const before = folderWork;
    const run = (async () => { await before.catch(() => {}); await Promise.allSettled(others); return fn(); })();
    folderWork = run;
    return run;
  };
  const under = (relativePath, folder) => relativePath === folder || relativePath.startsWith(`${folder}/`);
  const parentOf = (relativePath) => (relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '');
  const nameOf = (relativePath) => relativePath.slice(relativePath.lastIndexOf('/') + 1);

  // The same request sent again before the first answer is the same request:
  // both callers wait for the one piece of work.
  const underWay = new Map();
  const once = (opId, fn) => {
    let run = underWay.get(opId);
    if (!run) {
      run = (async () => fn())().finally(() => { if (underWay.get(opId) === run) underWay.delete(opId); });
      underWay.set(opId, run);
    }
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
      if (stat.size > limit) throw new WorkspaceAccessError('too-large', 'the file is too large to be read here');
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

  /**
   * The first free `<stem>.<ext>`, `<stem>-2.<ext>`, … or numbered
   * `Untitled-001.<ext>`, created exclusively. `aboutToTry(relativePath)`
   * is called, and awaited, before anything is written under a name.
   */
  async function createExclusive(parent, candidates, bytes, mode, aboutToTry = async () => {}) {
    for (const name of candidates) {
      const target = await assertAllowedPath(grant, 'create', join(parent, name));
      if (target.exists) continue;
      await aboutToTry(target.relativePath);
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

  // Read-only is the folder's permissions, or a registry written by a newer
  // version of this application: neither is written to, whatever is asked.
  const readOnly = async () => grant.readOnly || (await registry.access()) !== 'read-write';
  const refuseReadOnly = async () => { if (await readOnly()) throw new WorkspaceAccessError('read-only', 'this workspace is read-only'); };

  /** A read that finds content the record does not have: note it, and say so when it is a change rather than a first look. */
  async function noteRead(record, revision, stat) {
    if (record.revision === revision || await readOnly()) return;
    const updated = await registry.update(record.fileId, { revision }, observedOf(stat)).catch(() => null);
    // everyone who refers to the file hears of a change, whoever happened to read it first
    if (updated && record.revision !== null) { try { notify(updated, 'content'); } catch { /* the listener's own problem */ } }
  }

  /**
   * Give a file its new name without replacing anything that is there. The
   * hard link is the step that cannot overwrite: it fails when the name is
   * taken, by whoever and whenever. The old name goes only after it.
   */
  async function putAtNewName(from, to, caseOnly) {
    if (caseOnly) return io.rename(from, to);
    try { await io.link(from, to); } catch (e) {
      if (e.code === 'EEXIST') throw new WorkspaceAccessError('exists', 'something is already at that name');
      if (!NO_HARD_LINKS.has(e.code)) throw e;
      // no hard links on this volume: the name was free a moment ago and this application's own moves to it are held apart
      if (await io.stat(to).then(() => true, () => false)) throw new WorkspaceAccessError('exists', 'something is already at that name');
      return io.rename(from, to);
    }
    try { await io.unlink(from); } catch (e) {
      // the file must not stay under both names: take the new one back
      await io.unlink(to).catch(() => {});
      throw e;
    }
  }

  /** The registered files that were in a folder are now in the folder it became: same files, new places. */
  const followFolder = (from, to) => registry.updateMany((record) => {
    if (isLost(record) || !under(record.relativePath, from) || record.relativePath === from) return null;
    const relativePath = to + record.relativePath.slice(from.length);
    return { relativePath, mediaType: mediaTypeOf(relativePath) };
  });

  /**
   * The records of what came back from the recovery area: a file's own
   * record, or those of the files a folder held when it was trashed. A
   * record is taken up again only if it is still lost and its file is there.
   */
  async function backFromRecovery(item, note) {
    const wanted = new Map();
    if (item.kind === 'file' && item.fileId) wanted.set(item.fileId, item.relativePath);
    for (const f of Array.isArray(note?.files) ? note.files : []) if (typeof f?.fileId === 'string' && typeof f.relativePath === 'string') wanted.set(f.fileId, f.relativePath);
    const there = new Map();
    for (const [fileId, relativePath] of wanted) {
      const stat = await io.stat(path.join(grant.rootPath, ...relativePath.split('/'))).catch(() => null);
      if (stat?.isFile()) there.set(fileId, { relativePath, stat });
    }
    const live = (await readOnly()) ? 'readonly' : 'ready';
    return registry.updateMany((record) => {
      const back = there.get(record.fileId);
      if (!back || !isLost(record)) return null;
      return { patch: { status: live, relativePath: back.relativePath, mediaType: mediaTypeOf(back.relativePath) }, observed: observedOf(back.stat) };
    });
  }

  /**
   * Replace a file's content, if it still holds what the caller saw
   * (`baseRevision`). `nextOf(current)` says what to put there:
   * `{ bytes }`, or `{ result }` to answer without writing. Resolves with a
   * SaveResult; it does not reject for a conflict, a read-only file or a
   * full disk. What the file held is kept in the recovery area first.
   */
  const replaceContent = (fileId, baseRevision, opId, nextOf) => changing(() => locked(fileId, async () => {
      const done = await finished(opId, 'save');
      if (done) return { status: 'saved', revision: done.revision, sourceRevision: null };
      if (await readOnly()) return { status: 'readonly', reason: 'this workspace is read-only' };
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
        if (currentRevision !== baseRevision) {
          // this very save may have put its content in place and lost the note that it did:
          // what the file holds is then what this save was writing, and that is a save, not a conflict
          const mine = (await journal.attempt(opId))?.find((e) => e.phase === 'intent');
          if (mine && mine.base === baseRevision && mine.next === currentRevision) {
            await registry.update(fileId, { revision: currentRevision }, observedOf(current.stat)).catch(() => {});
            await journal.append({ opId, kind: 'save', phase: 'done', fileId, revision: currentRevision }).catch(() => {});
            return { status: 'saved', revision: currentRevision, sourceRevision: null };
          }
          return { status: 'conflict', currentRevision };
        }
        const wanted = await nextOf(current);
        if (wanted.result) return wanted.result;
        const next = wanted.bytes;
        const revision = hashOf(next);
        if (revision === currentRevision) return { status: 'saved', revision, sourceRevision: null };

        temp = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.tdag-save-${newId().slice(0, 8)}`);
        await journal.append({ opId, kind: 'save', phase: 'intent', fileId, base: baseRevision, next: revision, temp: path.basename(temp) });
        const handle = await io.open(temp, 'wx', current.stat.mode & 0o777);
        try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
        // the old content is kept whole before anything replaces it; if it cannot be, nothing is replaced
        await keepPreviousVersion(grant.rootPath, fileId, currentRevision, current.bytes, io);

        // the last look before the replacement: anything that changed since the first read stops it
        const again = await readChecked(target.absolute);
        if (hashOf(again.bytes) !== currentRevision) {
          await io.rm(temp, { force: true });
          await journal.append({ opId, kind: 'save', phase: 'failed' });
          return { status: 'conflict', currentRevision: hashOf(again.bytes) };
        }
        await io.rename(temp, target.absolute);
        // from here the new content is in place: nothing below undoes it or reports it as failed
        temp = null;
        await syncDirectory(path.dirname(target.absolute));

        // the content is in place; the registry catching up cannot undo that
        const stat = await io.stat(target.absolute).catch(() => null);
        await registry.update(fileId, { revision }, stat ? observedOf(stat) : undefined).catch(() => {});
        // if this note cannot be written the save still happened: asked again, or after a restart, it is recognized from its intent
        await journal.append({ opId, kind: 'save', phase: 'done', fileId, revision }).catch(() => {});
        return { status: 'saved', revision, sourceRevision: null };
      } catch (e) {
        // `temp` is set once the intent is written: only an attempt that started is marked as failed
        if (temp) {
          await io.rm(temp, { force: true }).catch(() => {});
          await journal.append({ opId, kind: 'save', phase: 'failed' }).catch(() => {});
        }
        if (e instanceof WorkspaceAccessError) return { status: 'error', reason: e.message };
        if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) return { status: 'readonly', reason: 'the file cannot be written' };
        if (e.code === 'ENOSPC') return { status: 'error', reason: 'the disk is full' };
        return { status: 'error', reason: 'the save did not complete' };
      }
  }));

  const api = {
    /**
     * Create a file. `request` is a CreateFileRequest with `parentId` already
     * resolved to `parentRelativePath`. A graph-origin file goes to the
     * workspace's Graph Files folder whatever the caller named. With
     * `content` the file starts with it (an import); with `name` it is
     * called that, and numbered only if the name is taken.
     */
    async createFile({ extension, origin, idempotencyKey, parentRelativePath = '' }, { content = null, name = null, importedFrom = null } = {}) {
      await refuseReadOnly();
      if (await finished(idempotencyKey, 'create')) return recordOf((await journal.completed(idempotencyKey)).fileId);
      return once(`create:${idempotencyKey}`, () => changing(async () => {
        const done = await finished(idempotencyKey, 'create');
        if (done) return recordOf(done.fileId);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(String(extension))) throw new WorkspaceAccessError('invalid-name', 'that is not a file extension');
        if (name !== null) assertPortableName(`${name}.${extension}`);

        let parent = parentRelativePath;
        if (origin === 'graph') {
          parent = GRAPH_FILES_DIR;
          const dir = await assertAllowedPath(grant, 'create', GRAPH_FILES_DIR);
          if (!dir.exists) await io.mkdir(dir.absolute).catch((e) => { if (e.code !== 'EEXIST') throw e; });
        }
        const text = content ?? templateFor(extension, { newId });
        const bytes = Buffer.from(text, 'utf8');
        const revision = hashOf(bytes);
        const recordOrigin = importedFrom ? 'import' : origin;
        // the intent says what the file will hold, and each name is noted before it is tried:
        // a crash at any point leaves enough to tell whether a file at that name is this one
        await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'intent', parent, extension, origin, recordOrigin, revision, ...(importedFrom ? { importedFrom } : {}) });

        const candidates = name !== null ? named(name, extension) : numbered(extension.toLowerCase() === 'tdmap' ? 'Mindmap' : 'Untitled', extension);
        let created;
        try {
          created = await createExclusive(parent, candidates, bytes, 0o644, (relativePath) => journal.append({ opId: idempotencyKey, kind: 'create', phase: 'attempt', relativePath }));
        } catch (e) {
          await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'failed' });
          throw e;
        }
        // from here the file exists: whatever fails next, it is kept and found again
        await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'created', relativePath: created.target.relativePath, origin: recordOrigin, revision, ...(importedFrom ? { importedFrom } : {}) });
        const record = await registry.create({
          relativePath: created.target.relativePath,
          mediaType: mediaTypeOf(created.target.relativePath),
          origin: recordOrigin,
          observed: observedOf(created.stat),
          revision,
          ...(importedFrom ? { importedFrom } : {}),
        });
        await journal.append({ opId: idempotencyKey, kind: 'create', phase: 'done', fileId: record.fileId });
        return record;
      }));
    },

    /** The file's text and the revision a later save must name. */
    async readText(fileId) {
      const record = await liveRecordOf(fileId);
      const target = await assertAllowedPath(grant, 'read', record.relativePath);
      const { bytes, stat } = await readChecked(target.absolute, MAX_EDITABLE_BYTES);
      const decoded = decodeText(bytes);
      const revision = hashOf(bytes);
      await noteRead(record, revision, stat);
      return { text: decoded.text, revision, encoding: decoded.encoding, newline: decoded.newline };
    },

    /**
     * The file's bytes and their hash, whatever they are. With `maxBytes`, a
     * larger file is refused (`too-large`) from its size alone: none of it
     * is read.
     */
    async readBytes(fileId, { maxBytes = Infinity } = {}) {
      const record = await liveRecordOf(fileId);
      const target = await assertAllowedPath(grant, 'read', record.relativePath);
      const { bytes, stat } = await readChecked(target.absolute, maxBytes);
      const revision = hashOf(bytes);
      await noteRead(record, revision, stat);
      return { bytes, revision };
    },

    /**
     * Replace the file's text, if it still holds what the caller read
     * (`baseRevision`). Resolves with a SaveResult; it does not reject for a
     * conflict, a read-only file or a full disk.
     */
    saveText: (fileId, baseRevision, text, opId) => {
      if (typeof text !== 'string') return Promise.resolve({ status: 'error', reason: 'the content is not text' });
      return replaceContent(fileId, baseRevision, opId, (current) => {
        // text in another encoding is never overwritten with a guess at what it said
        try { decodeText(current.bytes); } catch { return { result: { status: 'error', reason: 'the file is not UTF-8 text; it is not overwritten' } }; }
        // the file keeps its encoding mark; only UTF-8 is ever written
        const hadBom = current.bytes.length >= 3 && current.bytes.subarray(0, 3).equals(UTF8_BOM);
        return { bytes: hadBom ? Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8') };
      });
    },

    /** What the file held before each save that replaced it, newest first. */
    async listVersions(fileId) {
      await recordOf(fileId);
      return (await listPreviousVersions(grant.rootPath, fileId, io)).map((version) => ({ fileId, ...version }));
    },

    /**
     * Put an earlier version of the file back in place of what it holds
     * now, if it still holds what the caller saw. It is a save like any
     * other: what it replaces is kept as a version in turn.
     */
    restoreVersion: (fileId, revision, baseRevision, opId) => replaceContent(fileId, baseRevision, opId, async () => {
      const bytes = await readPreviousVersion(grant.rootPath, fileId, revision, io);
      return bytes ? { bytes } : { result: { status: 'error', reason: 'that version is not kept in the recovery area' } };
    }),

    /** Move or rename a file inside the workspace. It keeps its fileId, and it never replaces another file. */
    moveFile: (fileId, targetParentRelativePath, newName, opId) => changing(() => locked(fileId, async () => {
      await refuseReadOnly();
      const done = await finished(opId, 'move');
      if (done) return recordOf(fileId);
      const record = await liveRecordOf(fileId);
      const source = await assertAllowedPath(grant, 'move-from', record.relativePath);
      const wanted = await assertAllowedPath(grant, 'move-to', join(targetParentRelativePath, newName));
      // from the look at the name to the file being there, nothing else of this application reaches for that name
      return atPath(wanted.relativePath, async () => {
        const destination = await assertAllowedPath(grant, 'move-to', join(targetParentRelativePath, newName));
        let caseOnly = false;
        if (destination.exists) {
          // the same file under a name that differs only in case is a rename, not a collision
          const [a, b] = await Promise.all([io.stat(source.absolute), io.stat(destination.absolute)]);
          if (!sameFile(a, b)) throw new WorkspaceAccessError('exists', 'something is already at that name');
          caseOnly = true;
        }
        await journal.append({ opId, kind: 'move', phase: 'intent', fileId, from: source.relativePath, to: destination.relativePath });
        try { await putAtNewName(source.absolute, destination.absolute, caseOnly); } catch (e) {
          await journal.append({ opId, kind: 'move', phase: 'failed' });
          throw e.code === 'EXDEV' ? new WorkspaceAccessError('cross-device', 'the file cannot be moved to another disk this way') : e;
        }
        const stat = await io.stat(destination.absolute);
        const moved = await registry.update(fileId, { relativePath: destination.relativePath, mediaType: mediaTypeOf(destination.relativePath) }, observedOf(stat));
        await journal.append({ opId, kind: 'move', phase: 'done', fileId });
        return moved;
      });
    })),

    /** Copy a file inside the workspace. The copy is a new file with a new fileId. */
    copyFile: (fileId, targetParentRelativePath, newName, opId) => changing(() => locked(fileId, async () => {
      await refuseReadOnly();
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
      const copy = await registry.create({ relativePath: destination.relativePath, mediaType: mediaTypeOf(destination.relativePath), origin: 'workspace', observed: observedOf(stat), revision: hashOf(bytes) });
      await journal.append({ opId, kind: 'copy', phase: 'done', fileId: copy.fileId });
      return copy;
    })),

    /**
     * Take a file out of the workspace without destroying it: to the system
     * trash when there is one, else to the workspace's recovery area. The
     * record stays, marked missing, so what refers to the file still knows it.
     */
    trashFile: (fileId, opId) => changing(() => locked(fileId, async () => {
      await refuseReadOnly();
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
        if (location === 'project-recovery') {
          await moveToRecoveryTrash(grant.rootPath, receiptId, source.absolute, io, { receiptId, kind: 'file', name: nameOf(source.relativePath), relativePath: source.relativePath, trashedAt: now(), fileId });
        }
      } catch (e) {
        await journal.append({ opId, kind: 'trash', phase: 'failed' });
        throw e;
      }
      await registry.update(fileId, { status: 'missing' }).catch(() => {});
      const receipt = { receiptId, fileId, opId, location, restorable: true };
      await journal.append({ opId, kind: 'trash', phase: 'done', fileId, receipt });
      return receipt;
    })),

    /** Create a folder. Asking again for a folder that is there is not an error. */
    createFolder: (parentRelativePath, name) => changing(async () => {
      await refuseReadOnly();
      const target = await assertAllowedPath(grant, 'create', join(parentRelativePath, name));
      if (target.exists && target.kind !== 'directory') throw new WorkspaceAccessError('exists', 'a file is already at that name');
      if (!target.exists) await io.mkdir(target.absolute).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      return target.relativePath;
    }),

    /**
     * Move or rename a folder. Every registered file in it keeps its
     * identity and is known at its new place. Nothing is replaced: a name
     * that is taken is refused. Resolves with `{ relativePath, moved }`: where
     * the folder is now and the records of the files that went with it.
     */
    moveFolder: (folderRelativePath, targetParentRelativePath, newName, opId) => rearranging(async () => {
      await refuseReadOnly();
      const done = await finished(opId, 'move-folder');
      if (done) return { relativePath: done.to, moved: [] };
      const source = await assertAllowedPath(grant, 'move-from', folderRelativePath);
      if (source.kind !== 'directory') throw new WorkspaceAccessError('not-a-directory', 'that is not a folder');
      const destination = await assertAllowedPath(grant, 'move-to', join(targetParentRelativePath, newName));
      if (destination.relativePath === source.relativePath) return { relativePath: source.relativePath, moved: [] };
      if (under(destination.relativePath, source.relativePath)) throw new WorkspaceAccessError('invalid-move', 'a folder cannot be moved into itself');
      if (destination.exists) {
        // the same folder under a name that differs only in case is a rename, not a collision
        const [a, b] = await Promise.all([io.stat(source.absolute), io.stat(destination.absolute)]);
        if (!sameFile(a, b)) throw new WorkspaceAccessError('exists', 'something is already at that name');
      }
      await journal.append({ opId, kind: 'move-folder', phase: 'intent', from: source.relativePath, to: destination.relativePath });
      try { await io.rename(source.absolute, destination.absolute); } catch (e) {
        await journal.append({ opId, kind: 'move-folder', phase: 'failed' });
        if (e.code === 'EXDEV') throw new WorkspaceAccessError('cross-device', 'the folder cannot be moved to another disk this way');
        if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new WorkspaceAccessError('exists', 'something is already at that name');
        throw e;
      }
      const moved = await followFolder(source.relativePath, destination.relativePath);
      await journal.append({ opId, kind: 'move-folder', phase: 'done', to: destination.relativePath });
      return { relativePath: destination.relativePath, moved };
    }),

    /**
     * Copy a folder and everything in it. The copy is new files: they get
     * identities of their own when they are first used. It is built beside
     * its place and put there whole, so a copy that fails leaves nothing
     * half-made under the name. Resolves with where the copy is.
     */
    copyFolder: (folderRelativePath, targetParentRelativePath, newName, opId) => changing(async () => {
      await refuseReadOnly();
      const done = await finished(opId, 'copy-folder');
      if (done) return done.to;
      const source = await assertAllowedPath(grant, 'list', folderRelativePath);
      const wanted = await assertAllowedPath(grant, 'create', join(targetParentRelativePath, newName));
      if (under(wanted.relativePath, source.relativePath)) throw new WorkspaceAccessError('invalid-move', 'a folder cannot be copied into itself');
      return atPath(wanted.relativePath, async () => {
        const destination = await assertAllowedPath(grant, 'create', join(targetParentRelativePath, newName));
        if (destination.exists) throw new WorkspaceAccessError('exists', 'something is already at that name');
        const temp = path.join(path.dirname(destination.absolute), `.${path.basename(destination.absolute)}.tdag-copy-${newId().slice(0, 8)}`);
        await journal.append({ opId, kind: 'copy-folder', phase: 'intent', from: source.relativePath, to: destination.relativePath, temp: path.basename(temp) });
        try {
          // this application's own temp files are not part of what a person copies
          await io.cp(source.absolute, temp, { recursive: true, errorOnExist: true, force: false, filter: (from) => !path.basename(from).includes('.tdag-') });
          if (await io.stat(destination.absolute).then(() => true, () => false)) throw new WorkspaceAccessError('exists', 'something is already at that name');
          await io.rename(temp, destination.absolute);
        } catch (e) {
          await io.rm(temp, { recursive: true, force: true }).catch(() => {});
          await journal.append({ opId, kind: 'copy-folder', phase: 'failed' });
          throw e;
        }
        await journal.append({ opId, kind: 'copy-folder', phase: 'done', to: destination.relativePath });
        return destination.relativePath;
      });
    }),

    /**
     * Take a folder and everything in it out of the workspace without
     * destroying it: to the system trash when there is one, else to the
     * workspace's recovery area. The records of the files in it stay,
     * marked missing. Resolves with `{ item, lost }`: what is now in the
     * recovery area (null when the system trash took it: bringing it back
     * is then the system's to do) and the records of the files that went.
     */
    trashFolder: (folderRelativePath, opId) => rearranging(async () => {
      await refuseReadOnly();
      const done = await finished(opId, 'trash-folder');
      if (done) return { item: done.item ?? null, lost: [] };
      const source = await assertAllowedPath(grant, 'trash', folderRelativePath);
      if (source.kind !== 'directory') throw new WorkspaceAccessError('not-a-directory', 'that is not a folder');
      const inside = (await registry.all()).filter((r) => !isLost(r) && under(r.relativePath, source.relativePath));
      const receiptId = `trash_${newId()}`;
      const item = { receiptId, kind: 'folder', name: nameOf(source.relativePath), relativePath: source.relativePath, trashedAt: now() };
      await journal.append({ opId, kind: 'trash-folder', phase: 'intent', relativePath: source.relativePath, receiptId });
      let location = 'project-recovery';
      try {
        if (trash) {
          try { await trash(source.absolute); location = 'system-trash'; } catch { /* no system trash here: keep it in the workspace instead */ }
        }
        if (location === 'project-recovery') {
          await moveToRecoveryTrash(grant.rootPath, receiptId, source.absolute, io, { ...item, files: inside.map((r) => ({ fileId: r.fileId, relativePath: r.relativePath })) });
        }
      } catch (e) {
        await journal.append({ opId, kind: 'trash-folder', phase: 'failed' });
        throw e;
      }
      const ids = new Set(inside.map((r) => r.fileId));
      const lost = await registry.updateMany((record) => (ids.has(record.fileId) ? { status: 'missing' } : null)).catch(() => []);
      const kept = location === 'project-recovery' ? item : null;
      await journal.append({ opId, kind: 'trash-folder', phase: 'done', item: kept, location });
      return { item: kept, lost };
    }),

    /** What is in the workspace's recovery area: files and folders that were trashed there and can be put back. Newest first. */
    async listRecovery() {
      const found = await listRecoveryTrash(grant.rootPath, io);
      const items = [];
      let fromJournal = null;
      for (const entry of found) {
        let note = entry.note;
        if (!note) {
          // trashed before the recovery area kept its own notes: the journal still says what it was
          fromJournal ??= await journal.all();
          const intent = fromJournal.flatMap((op) => op.entries).find((e) => e.phase === 'intent' && e.receiptId === entry.receiptId);
          if (!intent || typeof intent.relativePath !== 'string') continue;
          note = { receiptId: entry.receiptId, kind: intent.kind === 'trash-folder' ? 'folder' : 'file', name: entry.name, relativePath: intent.relativePath, trashedAt: intent.at, ...(intent.fileId ? { fileId: intent.fileId } : {}) };
        }
        items.push({ receiptId: entry.receiptId, kind: note.kind === 'folder' ? 'folder' : 'file', name: String(note.name ?? entry.name), relativePath: String(note.relativePath), trashedAt: String(note.trashedAt), ...(typeof note.fileId === 'string' ? { fileId: note.fileId } : {}) });
      }
      return items.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : a.trashedAt > b.trashedAt ? -1 : 0));
    },

    /**
     * Put something back from the recovery area where it was. Nothing is
     * replaced: if its place is taken it stays in the recovery area. The
     * folder it was in is made again if it is gone. The files that come
     * back are the files they were. Resolves with `{ relativePath, kind,
     * restored }`.
     */
    restoreFromRecovery: (receiptId, opId) => rearranging(async () => {
      await refuseReadOnly();
      const done = await finished(opId, 'restore');
      if (done) return { relativePath: done.to, kind: done.itemKind, restored: [] };
      const entry = (await listRecoveryTrash(grant.rootPath, io)).find((e) => e.receiptId === receiptId);
      const item = entry && (await api.listRecovery()).find((i) => i.receiptId === receiptId);
      if (!entry || !item) throw new WorkspaceAccessError('not-found', 'that is not in the recovery area');

      // the folder it was in may be gone: it is made again, step by step, each step checked
      const steps = parentOf(item.relativePath).split('/').filter(Boolean);
      for (let depth = 1; depth <= steps.length; depth++) {
        const dir = await assertAllowedPath(grant, 'create', steps.slice(0, depth).join('/'));
        if (dir.exists && dir.kind !== 'directory') throw new WorkspaceAccessError('not-a-directory', 'the place it was in is not a folder any more');
        if (!dir.exists) await io.mkdir(dir.absolute).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      }
      return atPath(item.relativePath, async () => {
        const target = await assertAllowedPath(grant, 'move-to', item.relativePath);
        if (target.exists) throw new WorkspaceAccessError('exists', 'something has taken its place; it stays in the recovery area');
        await journal.append({ opId, kind: 'restore', phase: 'intent', receiptId, to: target.relativePath, itemKind: item.kind });
        try {
          if (item.kind === 'file') await putAtNewName(entry.content, target.absolute, false);
          else await io.rename(entry.content, target.absolute);
        } catch (e) {
          await journal.append({ opId, kind: 'restore', phase: 'failed' });
          if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new WorkspaceAccessError('exists', 'something has taken its place; it stays in the recovery area');
          throw e;
        }
        const restored = await backFromRecovery(item, entry.note);
        await clearRecoveryReceipt(grant.rootPath, receiptId, io);
        await journal.append({ opId, kind: 'restore', phase: 'done', to: target.relativePath, itemKind: item.kind });
        return { relativePath: target.relativePath, kind: item.kind, restored };
      });
    }),

    /**
     * Settle the operations a crash cut short. Nothing is deleted except this
     * module's own temp files: a file that was written is kept and given its
     * record; a save that did not land leaves the old content in place.
     */
    async reconcile() {
      if (await readOnly()) return [];
      const settled = [];
      for (const op of await journal.pending()) {
        // the entries are those of the operation's latest attempt
        const last = (phase) => [...op.entries].reverse().find((e) => e.phase === phase);
        const intent = last('intent');
        let outcome = 'failed';
        try {
          if (op.kind === 'create') {
            const created = last('created');
            const attempt = last('attempt');
            let made = null;
            if (created) {
              const there = await assertAllowedPath(grant, 'stat', created.relativePath).then((t) => t.kind === 'file', () => false);
              if (there) made = { relativePath: created.relativePath, origin: created.origin, revision: created.revision, importedFrom: created.importedFrom };
            } else if (attempt && intent?.revision) {
              // cut short between writing the file and noting it: the file at the name that was being
              // tried is this operation's only if it holds exactly what the operation was writing
              const target = await assertAllowedPath(grant, 'stat', attempt.relativePath).catch(() => null);
              const there = target?.kind === 'file' ? await readChecked(target.absolute).catch(() => null) : null;
              if (there && hashOf(there.bytes) === intent.revision) made = { relativePath: target.relativePath, origin: intent.recordOrigin ?? intent.origin, revision: intent.revision, importedFrom: intent.importedFrom };
            }
            if (made) {
              const stat = await io.stat(path.join(grant.rootPath, made.relativePath));
              const record = await registry.register({ relativePath: made.relativePath, mediaType: mediaTypeOf(made.relativePath), origin: made.origin, observed: observedOf(stat), revision: made.revision, ...(made.importedFrom ? { importedFrom: made.importedFrom } : {}) });
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
            // the file had its new name and still had its old one: finish by taking the old one away
            // (a change of case only is one name spelled two ways, not two names: nothing is taken away there)
            if (from && to && sameFile(from, to) && from.nlink > 1 && intent.from.toLowerCase() !== intent.to.toLowerCase()) await io.unlink(path.join(grant.rootPath, intent.from));
            if (to && (!from || sameFile(from, to))) {
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
          } else if (op.kind === 'move-folder' && intent) {
            const [from, to] = await Promise.all([intent.from, intent.to].map((p) => io.stat(path.join(grant.rootPath, ...p.split('/'))).then((s) => s, () => null)));
            // the folder is under its new name and no longer under its old one: the files in it are known there
            if (!from && to?.isDirectory()) {
              await followFolder(intent.from, intent.to);
              await journal.append({ opId: op.opId, kind: 'move-folder', phase: 'done', to: intent.to });
              outcome = 'completed';
            }
          } else if (op.kind === 'copy-folder' && intent) {
            // the copy is put under its name in one step: either it is there whole, or only this module's temp folder is
            const dir = path.dirname(path.join(grant.rootPath, ...intent.to.split('/')));
            const tempThere = await io.stat(path.join(dir, intent.temp)).then(() => true, () => false);
            if (tempThere) await io.rm(path.join(dir, intent.temp), { recursive: true, force: true });
            else if (await io.stat(path.join(grant.rootPath, ...intent.to.split('/'))).then((s) => s.isDirectory(), () => false)) {
              await journal.append({ opId: op.opId, kind: 'copy-folder', phase: 'done', to: intent.to });
              outcome = 'completed';
            }
          } else if (op.kind === 'trash-folder' && intent) {
            const there = await io.stat(path.join(grant.rootPath, ...intent.relativePath.split('/'))).then(() => true, () => false);
            if (!there) {
              // the folder is gone from its place: the files that were in it are lost until it is put back
              await registry.updateMany((record) => (!isLost(record) && under(record.relativePath, intent.relativePath) ? { status: 'missing' } : null));
              const kept = (await api.listRecovery()).find((i) => i.receiptId === intent.receiptId) ?? null;
              await journal.append({ opId: op.opId, kind: 'trash-folder', phase: 'done', item: kept, location: kept ? 'project-recovery' : 'system-trash' });
              outcome = 'completed';
            }
          } else if (op.kind === 'restore' && intent) {
            const back = await io.stat(path.join(grant.rootPath, ...intent.to.split('/'))).then(() => true, () => false);
            const stillKept = (await listRecoveryTrash(grant.rootPath, io)).some((e) => e.receiptId === intent.receiptId);
            if (back && !stillKept) {
              // it is back in its place and no longer in the recovery area: its files are found by looking (see reconcile.cjs)
              await clearRecoveryReceipt(grant.rootPath, intent.receiptId, io);
              await journal.append({ opId: op.opId, kind: 'restore', phase: 'done', to: intent.to, itemKind: intent.itemKind });
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

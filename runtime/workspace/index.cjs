// The workspace service: real project folders, opened through one narrow
// door. A folder joins only through the system's own picker; from then on
// the renderer names it by an opaque id and names places inside it by entry
// ids this service handed out. It never sends a path, and nothing here acts
// on one it was sent.
//
// Opening a folder reads its listing, not its files: no content is read and
// nothing is indexed. A file gets an identity when it is first used.
//
// A workspace id leads to exactly one folder. The id travels with the
// folder (it is in the folder's own records), so a folder that was moved is
// the same workspace at its new place, and a copy of a folder that is still
// open is given an id, and file ids, of its own the moment it is opened:
// two folders never answer to one id.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertAllowedPath, WorkspaceAccessError, METADATA_DIR } = require('./path-policy.cjs');
const { createRegistry, writeFileAtomic, REGISTRY_FILE } = require('./registry.cjs');
const { mediaTypeOf } = require('./media-types.cjs');
const { createJournal, JOURNAL_FILE } = require('./journal.cjs');
const { recoveryRoot } = require('./recovery.cjs');
const { createFileOps } = require('./file-ops.cjs');
const { createReconciler } = require('./reconcile.cjs');
const { watchWorkspace } = require('./watch.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const fsp = fs.promises;
const GRANTS_FILE = 'workspace-grants.json';
const IDENTITY_FILE = 'workspace.json';

// An entry id is the entry's relative path in a form the renderer has no
// reason to read. It is not a secret and nothing relies on it being one:
// every id that comes back is put through the path policy again.
const entryIdOf = (relativePath) => 'e_' + Buffer.from(relativePath, 'utf8').toString('base64url');
function relativePathOf(entryId) {
  if (typeof entryId !== 'string' || !entryId.startsWith('e_')) throw new WorkspaceAccessError('invalid-entry', 'that is not an entry of this workspace');
  const relativePath = Buffer.from(entryId.slice(2), 'base64url').toString('utf8');
  // an id this service did not make does not round-trip
  if (entryIdOf(relativePath) !== entryId) throw new WorkspaceAccessError('invalid-entry', 'that is not an entry of this workspace');
  return relativePath;
}

/**
 * `stateDir` is where the shell keeps its own records (the app's user-data
 * directory). `pickDirectory()` shows the system folder picker and resolves
 * with an absolute path or null; it is the only way a root is granted.
 * `trash(absolutePath)` moves a file to the system trash; without it a
 * trashed file goes to the workspace's own recovery area. `io` replaces
 * the file-system calls of file operations (tests inject faults through it).
 * `watch` is `{ watchFn, quietMs }` for the folder watcher (see watch.cjs).
 */
function createWorkspaceService({ stateDir, pickDirectory, trash = null, io, watch = {}, now = () => new Date().toISOString(), newId = () => randomUUID() }) {
  const grantsFile = path.join(stateDir, GRANTS_FILE);
  let grants = null;              // Map<rootGrantId, { rootPath, workspaceId, displayName, readOnly, grantedAt }>
  let grantsLoading = null;       // the one load everyone waits for
  const registries = new Map();   // rootGrantId → Promise<registry>
  const operations = new Map();   // rootGrantId → Promise<file operations>
  const listeners = new Map();    // workspaceId → Set<listener>
  const watchers = new Map();     // workspaceId → folder watcher

  const isFolder = (dir) => fsp.stat(dir).then((s) => s.isDirectory(), () => false);

  /** The grants, once they are all read. Everyone who asks while they are being read gets the same, complete list. */
  function loadGrants() {
    if (!grantsLoading) {
      const loading = (async () => {
        let text = null;
        try { text = await fsp.readFile(grantsFile, 'utf8'); } catch (e) {
          // no file is no grants yet; a file that is there and could not be read is not an empty list
          if (e.code !== 'ENOENT') throw e;
        }
        const read = [];
        if (text !== null) {
          let doc = null;
          try { doc = JSON.parse(text); } catch { /* not readable: the folders are asked for again */ }
          for (const [id, g] of Object.entries(doc?.grants ?? {})) {
            if (g && typeof g.rootPath === 'string' && path.isAbsolute(g.rootPath) && typeof g.workspaceId === 'string') read.push([id, g]);
          }
        }
        // one folder per workspace id: of several, the one whose folder is still there
        const loaded = new Map();
        const holder = new Map(); // workspaceId → rootGrantId
        for (const [id, g] of read) {
          const earlier = holder.get(g.workspaceId);
          if (earlier === undefined) { holder.set(g.workspaceId, id); loaded.set(id, g); continue; }
          if (!(await isFolder(loaded.get(earlier).rootPath)) && await isFolder(g.rootPath)) {
            loaded.delete(earlier);
            holder.set(g.workspaceId, id);
            loaded.set(id, g);
          }
        }
        grants = loaded;
        return loaded;
      })();
      grantsLoading = loading;
      // a load that failed is tried again by the next caller
      loading.catch(() => { if (grantsLoading === loading) grantsLoading = null; });
    }
    return grantsLoading;
  }
  async function saveGrants() {
    await fsp.mkdir(stateDir, { recursive: true });
    await writeFileAtomic(grantsFile, JSON.stringify({ grants: Object.fromEntries(grants) }, null, 2) + '\n');
  }
  // one change to the grants at a time: two openings of one folder are one grant
  let grantChanges = Promise.resolve();
  const changingGrants = (fn) => { const run = grantChanges.then(fn, fn); grantChanges = run.catch(() => {}); return run; };

  const recordOf = (rootGrantId, g) => ({ workspaceId: g.workspaceId, displayName: g.displayName, readOnly: g.readOnly, kind: 'local', rootGrantId });

  async function grantOf(workspaceId) {
    for (const [rootGrantId, g] of await loadGrants()) if (g.workspaceId === workspaceId) return { rootGrantId, ...g };
    throw new WorkspaceAccessError('no-grant', 'that workspace is not open');
  }

  /** The registry of a granted folder. Everyone who asks while it is being made gets the same one. */
  function registryOf(grant) {
    let ready = registries.get(grant.rootGrantId);
    if (!ready) {
      ready = (async () => createRegistry({ rootPath: grant.rootPath, workspaceId: grant.workspaceId, rootGrantId: grant.rootGrantId, readOnly: grant.readOnly, contracts: await loadContracts() }))();
      registries.set(grant.rootGrantId, ready);
      const mine = ready;
      ready.catch(() => { if (registries.get(grant.rootGrantId) === mine) registries.delete(grant.rootGrantId); });
    }
    return ready;
  }

  /** Drop what is held in memory for a grant: its folder is closed, or is somewhere else now. */
  function forget(grant) {
    registries.delete(grant.rootGrantId);
    operations.delete(grant.rootGrantId);
    watchers.get(grant.workspaceId)?.close();
    watchers.delete(grant.workspaceId);
  }

  function startWatching(grant) {
    if (watchers.has(grant.workspaceId)) return;
    watchers.set(grant.workspaceId, watchWorkspace({
      rootPath: grant.rootPath,
      // the grant is looked up when the signal comes: the folder may have been moved since
      onSignal: () => { void grantOf(grant.workspaceId).then(rescan).catch(() => {}); },
      ...watch,
    }));
  }

  /** The file operations of a workspace. The first use settles whatever a
   *  crash left unfinished there, before anything new is done. */
  function operationsOf(grant) {
    let ready = operations.get(grant.rootGrantId);
    if (!ready) {
      ready = (async () => {
        const registry = await registryOf(grant);
        const ops = createFileOps({
          grant,
          registry,
          // a registry this version may not write means a folder this version does not write to at all
          journal: createJournal({ rootPath: grant.rootPath, readOnly: grant.readOnly || (await registry.access()) !== 'read-write', now }),
          trash,
          ...(io ? { io } : {}),
          now,
          notify: (record, change) => emit(grant.workspaceId, record, change),
        });
        await ops.reconcile();
        return ops;
      })();
      operations.set(grant.rootGrantId, ready);
      const mine = ready;
      ready.catch(() => { if (operations.get(grant.rootGrantId) === mine) operations.delete(grant.rootGrantId); });
    }
    return ready;
  }

  async function reconcilerOf(grant) {
    return createReconciler({ grant, registry: await registryOf(grant), ...(io ? { io } : {}) });
  }

  /** Tell the workspace's subscribers that a file changed. A listener that throws stops nobody else. */
  function emit(workspaceId, record, change, opId = null) {
    const event = { workspaceId, fileId: record.fileId, change, observedRevision: record.revision, opId, record };
    for (const listener of listeners.get(workspaceId) ?? []) { try { listener(event); } catch { /* the listener's own problem */ } }
  }

  async function rescan(grant) {
    const changes = await (await reconcilerOf(grant)).rescan();
    for (const { record, change } of changes) emit(grant.workspaceId, record, change);
    return changes.map(({ record }) => record);
  }

  /** The open workspace that knows this file. */
  async function grantOfFile(fileId) {
    for (const [rootGrantId, g] of await loadGrants()) {
      const grant = { rootGrantId, ...g };
      if (await (await registryOf(grant)).get(fileId)) return grant;
    }
    throw new WorkspaceAccessError('unknown-file', 'that file is not known to an open workspace');
  }

  const parentPathOf = (parentId) => (parentId === undefined || parentId === null ? '' : relativePathOf(parentId));

  async function checkedRequest(kind, value) {
    const result = (await loadContracts()).validateDTO(kind, value);
    if (!result.ok) throw new WorkspaceAccessError('invalid-request', `that is not a ${kind}: ` + result.errors.map((e) => `${e.path || '(the request)'} ${e.message}`).join('; '));
    return value;
  }

  /** The id a folder carries in its own records, so the same folder is the
   *  same workspace wherever it is opened from. Created on first open when
   *  the folder can be written; a folder that cannot gets an id of its own. */
  async function identityOf(rootPath, writable) {
    const { versionAccess, SCHEMA_VERSION } = await loadContracts();
    const file = path.join(rootPath, METADATA_DIR, IDENTITY_FILE);
    try {
      const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
      const access = versionAccess(doc?.schemaVersion, SCHEMA_VERSION);
      if (typeof doc?.workspaceId === 'string' && doc.workspaceId && (access === 'read-write' || access === 'read-only')) {
        return { workspaceId: doc.workspaceId, readOnly: !writable || access === 'read-only' };
      }
    } catch { /* not a workspace yet */ }
    const workspaceId = `ws_${newId()}`;
    if (!writable) return { workspaceId, readOnly: true };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, workspaceId, createdAt: now() }, null, 2) + '\n');
    return { workspaceId, readOnly: false };
  }

  /** Whether the folder at `rootPath` is there and carries this workspace id in its own records. */
  async function holdsIdentity(rootPath, workspaceId) {
    try { return JSON.parse(await fsp.readFile(path.join(rootPath, METADATA_DIR, IDENTITY_FILE), 'utf8'))?.workspaceId === workspaceId; } catch { return false; }
  }

  /**
   * Give a folder that is a copy of an open workspace an identity of its
   * own: a new workspace id, and a new id for every file in its registry,
   * since the ones it was copied with are the original's. The copied
   * journal speaks of the original's operations and is set aside. The
   * folder's id is written last: a copy half-way through this is still seen
   * as a copy the next time it is opened. Resolves with the new id.
   */
  async function ownIdentityFor(rootPath) {
    const { versionAccess, SCHEMA_VERSION } = await loadContracts();
    const meta = path.join(rootPath, METADATA_DIR);
    const cannot = () => new WorkspaceAccessError('duplicate-workspace', 'this folder is a copy of a workspace that is already open, and its records cannot be rewritten to give it an identity of its own');
    const workspaceId = `ws_${newId()}`;

    const registryFile = path.join(meta, REGISTRY_FILE);
    const text = await fsp.readFile(registryFile, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw cannot(); });
    const renamed = new Map(); // the original's file id → this folder's
    if (text !== null) {
      let doc;
      try { doc = JSON.parse(text); } catch { throw cannot(); }
      if (versionAccess(doc?.schemaVersion, SCHEMA_VERSION) !== 'read-write') throw cannot();
      for (const entry of Array.isArray(doc.resources) ? doc.resources : []) {
        if (!entry?.record || typeof entry.record.fileId !== 'string') continue;
        const fileId = `file_${newId()}`;
        renamed.set(entry.record.fileId, fileId);
        entry.record = { ...entry.record, fileId, workspaceId };
      }
      doc.workspaceId = workspaceId;
      await writeFileAtomic(registryFile, JSON.stringify(doc, null, 2) + '\n');
    }
    // earlier versions of a file are kept under its id: they follow it to the new one
    const versions = path.join(recoveryRoot(rootPath), 'versions');
    for (const [from, to] of renamed) await fsp.rename(path.join(versions, from), path.join(versions, to)).catch(() => {});
    await fsp.rename(path.join(meta, JOURNAL_FILE), path.join(meta, `journal.copied-${Date.now()}.jsonl`)).catch(() => {});
    await writeFileAtomic(path.join(meta, IDENTITY_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, workspaceId, createdAt: now() }, null, 2) + '\n');
    return workspaceId;
  }

  return {
    /** Ask the person for a folder and open it. Null when they cancel. */
    async chooseRoot() {
      const picked = await pickDirectory();
      if (!picked) return null;
      return this.openRoot(picked);
    },

    /**
     * Open a folder the shell itself chose (a canvas's own managed folder),
     * creating it if needed. Host-only: the page never names a path, so this
     * is not reachable with one it supplied.
     */
    async openManaged(absolutePath) {
      if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) throw new WorkspaceAccessError('no-grant', 'a managed workspace needs an absolute folder');
      await fsp.mkdir(absolutePath, { recursive: true });
      return this.openRoot(absolutePath);
    },

    /** Grant a folder as a workspace root. Not exposed to the page. */
    async openRoot(picked) {
      let rootPath;
      try { rootPath = await fsp.realpath(picked); } catch { throw new WorkspaceAccessError('root-missing', 'the chosen folder is not there'); }
      if (!(await fsp.stat(rootPath)).isDirectory()) throw new WorkspaceAccessError('not-a-directory', 'a workspace is a folder');
      if (path.dirname(rootPath) === rootPath) throw new WorkspaceAccessError('root-too-wide', 'a whole disk cannot be a workspace; choose a folder');
      return changingGrants(async () => {
        await loadGrants();
        for (const [rootGrantId, g] of grants) if (g.rootPath === rootPath) return recordOf(rootGrantId, g);
        const writable = await fsp.access(rootPath, fs.constants.W_OK).then(() => true, () => false);
        let { workspaceId, readOnly } = await identityOf(rootPath, writable);

        // the id this folder carries may already lead to a folder
        const holder = [...grants].find(([, g]) => g.workspaceId === workspaceId);
        if (holder) {
          const [rootGrantId, g] = holder;
          if (!(await holdsIdentity(g.rootPath, workspaceId))) {
            // the folder that had this id is no longer where it was: it is this one, moved
            forget({ rootGrantId, ...g });
            const moved = { ...g, rootPath, displayName: path.basename(rootPath), readOnly };
            grants.set(rootGrantId, moved);
            await saveGrants();
            if (listeners.has(workspaceId)) startWatching({ rootGrantId, ...moved });
            return recordOf(rootGrantId, moved);
          }
          // both folders are there with one id: the one being opened now is the copy
          if (readOnly) throw new WorkspaceAccessError('duplicate-workspace', 'this folder is a copy of a workspace that is already open, and it cannot be written to, so it cannot be given an identity of its own');
          workspaceId = await ownIdentityFor(rootPath);
        }

        const rootGrantId = `grant_${newId()}`;
        const grant = { rootPath, workspaceId, displayName: path.basename(rootPath), readOnly, grantedAt: now() };
        grants.set(rootGrantId, grant);
        await saveGrants();
        return recordOf(rootGrantId, grant);
      });
    },

    /** The workspaces that are open and whose folders are still there. */
    async listWorkspaces() {
      const open = [];
      for (const [rootGrantId, g] of await loadGrants()) {
        if (await fsp.stat(g.rootPath).then((s) => s.isDirectory(), () => false)) open.push(recordOf(rootGrantId, g));
      }
      return open;
    },

    /** Close a workspace. Nothing in the folder is touched. */
    closeWorkspace(workspaceId) {
      return changingGrants(async () => {
        const grant = await grantOf(workspaceId);
        grants.delete(grant.rootGrantId);
        forget(grant);
        listeners.delete(workspaceId);
        await saveGrants();
        return true;
      });
    },

    /** The entries of one folder: names and kinds, no content. Folders first. */
    async listChildren(workspaceId, parentId) {
      const grant = await grantOf(workspaceId);
      const parent = await assertAllowedPath(grant, 'list', parentId === undefined || parentId === null ? '' : relativePathOf(parentId));
      const registry = await registryOf(grant);
      const entries = [];
      for (const dirent of await fsp.readdir(parent.absolute, { withFileTypes: true })) {
        const relativePath = parent.relativePath ? `${parent.relativePath}/${dirent.name}` : dirent.name;
        if (!parent.relativePath && dirent.name.toLowerCase() === METADATA_DIR) continue;
        let kind = dirent.isDirectory() ? 'folder' : dirent.isFile() ? 'file' : 'unknown';
        if (dirent.isSymbolicLink()) {
          // a link is shown as what it leads to only when that is inside the workspace
          kind = await assertAllowedPath(grant, 'stat', relativePath).then((t) => (t.kind === 'directory' ? 'folder' : t.kind === 'file' ? 'file' : 'unknown'), () => 'unknown');
        }
        const record = kind === 'file' ? await registry.findByPath(relativePath) : null;
        entries.push({
          entryId: entryIdOf(relativePath),
          parentId: parent.relativePath ? entryIdOf(parent.relativePath) : null,
          name: dirent.name,
          kind,
          ...(record ? { fileId: record.fileId } : {}),
        });
      }
      const rank = (e) => (e.kind === 'folder' ? 0 : 1);
      return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    },

    /** Give the file at `relativePath` under a granted root its identity, or
     *  return the one it has. Reads the file's metadata, not its content. */
    async registerResource(rootGrantId, relativePath, origin = 'workspace') {
      const g = (await loadGrants()).get(rootGrantId);
      if (!g) throw new WorkspaceAccessError('no-grant', 'that workspace is not open');
      const grant = { rootGrantId, ...g };
      const target = await assertAllowedPath(grant, 'read', relativePath);
      const stat = await fsp.stat(target.absolute);
      const registry = await registryOf(grant);
      return registry.register({
        relativePath: target.relativePath,
        mediaType: mediaTypeOf(target.relativePath),
        origin,
        observed: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
      });
    },

    /** registerResource for the renderer: by workspace and entry id. */
    async registerEntry(workspaceId, entryId) {
      const grant = await grantOf(workspaceId);
      return this.registerResource(grant.rootGrantId, relativePathOf(entryId));
    },

    /** Create a file from a CreateFileRequest. The name is chosen here. */
    async createFile(request) {
      await checkedRequest('CreateFileRequest', request);
      const grant = await grantOf(request.workspaceId);
      return (await operationsOf(grant)).createFile({ extension: request.extension, origin: request.origin, idempotencyKey: request.idempotencyKey, parentRelativePath: parentPathOf(request.parentId) });
    },

    /**
     * Bring text in as a new local file marked as a copy: what was copied out
     * of a space page, or anything else the person has in hand. `provenance`
     * is `{ source, note? }` in the person's words; the time is set here.
     * The file is an ordinary local file from then on.
     */
    async importText(request, { text, name = null, provenance }) {
      await checkedRequest('CreateFileRequest', request);
      if (typeof text !== 'string') throw new WorkspaceAccessError('invalid-request', 'the content to import is not text');
      const importedFrom = await checkedRequest('ImportProvenance', { source: provenance?.source, importedAt: now(), ...(typeof provenance?.note === 'string' && provenance.note ? { note: provenance.note } : {}) });
      const grant = await grantOf(request.workspaceId);
      return (await operationsOf(grant)).createFile(
        { extension: request.extension, origin: 'workspace', idempotencyKey: request.idempotencyKey, parentRelativePath: parentPathOf(request.parentId) },
        { content: text, name, importedFrom },
      );
    },

    async createFolder(workspaceId, parentId, name) {
      const grant = await grantOf(workspaceId);
      return entryIdOf(await (await operationsOf(grant)).createFolder(parentPathOf(parentId), name));
    },

    async readText(fileId) {
      return (await operationsOf(await grantOfFile(fileId))).readText(fileId);
    },

    async readBytes(fileId) {
      return (await operationsOf(await grantOfFile(fileId))).readBytes(fileId);
    },

    /** Where a registered file is on disk. Host-only: for showing it in the
     *  system file manager. The path never goes to the page. */
    async locate(fileId) {
      const grant = await grantOfFile(fileId);
      const record = await (await registryOf(grant)).get(fileId);
      if (record.status === 'missing' || record.status === 'ambiguous') throw new WorkspaceAccessError('lost', 'the file is lost; it has to be found again first');
      return (await assertAllowedPath(grant, 'stat', record.relativePath)).absolute;
    },

    /** The open workspace with this id, as a record. */
    async workspaceRecord(workspaceId) {
      const grant = await grantOf(workspaceId);
      return recordOf(grant.rootGrantId, grant);
    },

    /** The record of a registered file, or null. */
    async resourceRecord(fileId) {
      const grant = await grantOfFile(fileId).catch(() => null);
      return grant ? (await registryOf(grant)).get(fileId) : null;
    },

    async saveText(fileId, baseRevision, text, opId) {
      const grant = await grantOfFile(fileId);
      const before = (await (await registryOf(grant)).get(fileId))?.revision ?? null;
      const result = await (await operationsOf(grant)).saveText(fileId, baseRevision, text, opId);
      if (result.status === 'saved' && result.revision !== before) emit(grant.workspaceId, await (await registryOf(grant)).get(fileId), 'content', opId);
      return result;
    },

    async moveFile(fileId, targetParentId, newName, opId) {
      const grant = await grantOfFile(fileId);
      const before = (await (await registryOf(grant)).get(fileId))?.relativePath;
      const moved = await (await operationsOf(grant)).moveFile(fileId, parentPathOf(targetParentId), newName, opId);
      if (moved.relativePath !== before) emit(grant.workspaceId, moved, 'moved', opId);
      return moved;
    },

    async copyFile(fileId, targetParentId, newName, opId) {
      return (await operationsOf(await grantOfFile(fileId))).copyFile(fileId, parentPathOf(targetParentId), newName, opId);
    },

    async trashFile(fileId, opId) {
      const grant = await grantOfFile(fileId);
      const wasThere = (await (await registryOf(grant)).get(fileId))?.status !== 'missing';
      const receipt = await (await operationsOf(grant)).trashFile(fileId, opId);
      if (wasThere) emit(grant.workspaceId, await (await registryOf(grant)).get(fileId), 'missing', opId);
      return receipt;
    },

    /**
     * Hear about changes to a workspace's registered files: this
     * application's own, and other programs'. The first subscriber starts
     * the folder watcher; the last one leaving stops it. Returns unsubscribe.
     */
    async subscribeWorkspace(workspaceId, listener) {
      const grant = await grantOf(workspaceId);
      if (!listeners.has(workspaceId)) listeners.set(workspaceId, new Set());
      listeners.get(workspaceId).add(listener);
      startWatching(grant);
      return () => {
        const set = listeners.get(workspaceId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(workspaceId);
          watchers.get(workspaceId)?.close();
          watchers.delete(workspaceId);
        }
      };
    },

    /** Bring one file's record in line with the disk. Resolves with the record. */
    async reconcile(fileId) {
      const grant = await grantOfFile(fileId);
      const { record, change } = await (await reconcilerOf(grant)).reconcile(fileId);
      if (change) emit(grant.workspaceId, record, change);
      return record;
    },

    /** Reconcile every registered file of a workspace: what a watcher signal
     *  does, and what covers the signals that never came (asked for when the
     *  window comes back to the front). Resolves with the records that changed. */
    async rescanWorkspace(workspaceId) {
      return rescan(await grantOf(workspaceId));
    },

    /** The person says a lost file is the entry they picked. */
    async relink(fileId, candidateEntryId) {
      const grant = await grantOfFile(fileId);
      const { record, change } = await (await reconcilerOf(grant)).relink(fileId, relativePathOf(candidateEntryId));
      emit(grant.workspaceId, record, change);
      return record;
    },
  };
}

module.exports = { createWorkspaceService, entryIdOf, relativePathOf, GRANTS_FILE, IDENTITY_FILE };

// The resource registry of one local workspace: which file is which.
//
// A file's identity is its fileId, given once and kept through renames and
// moves. Its path is only where it was last seen. The registry lives in the
// workspace's own records (<root>/.thoughtdag/resources.json), so identities
// travel with the folder. It can be rebuilt; the files are the research.
//
// One writer: every change goes through this object, one at a time, and the
// file is replaced whole (temp file, flush, rename), never edited in place.
// A registry written by a newer version is read and never rewritten.
//
// A path can have more than one record over time: a file that was lost
// keeps its record, and a new file may later be made under the same name.
// Looking a path up finds the record of the file that is there now, never
// the lost one; a new file never takes over a lost file's identity.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { METADATA_DIR } = require('./path-policy.cjs');

const fsp = fs.promises;
const REGISTRY_FILE = 'resources.json';

class RegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'RegistryError'; this.code = code; }
}

/** Replace a file whole: a reader sees the old content or the new, never a part. */
async function writeFileAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await fsp.open(temp, 'wx');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await fsp.rename(temp, file); } catch (e) {
    await fsp.rm(temp, { force: true });
    throw e;
  }
}

/**
 * A 1.0 record as a 1.1 record. 1.0 knew only local files and named them by
 * path: the locator and the (absent) source revision are filled in. Nothing
 * else is touched, and the file is rewritten as 1.1 on its next change.
 */
function migrateRecord(record, rootGrantId) {
  const migrated = { ...record };
  if (migrated.locator === undefined && typeof migrated.relativePath === 'string') migrated.locator = { kind: 'local', rootGrantId, relativePath: migrated.relativePath };
  if (migrated.sourceRevision === undefined) migrated.sourceRevision = null;
  return migrated;
}

/**
 * The registry of the workspace rooted at `rootPath`.
 * `contracts` is what shared/schemas/host.cjs loads; `newId` makes a fileId.
 */
function createRegistry({ rootPath, workspaceId, rootGrantId, readOnly = false, contracts, newId = () => `file_${randomUUID()}` }) {
  const file = path.join(rootPath, METADATA_DIR, REGISTRY_FILE);
  let state = null;    // { access, resources: Map<fileId, entry> }
  let queue = Promise.resolve();
  // one operation at a time, in the order asked; a failure does not stop the next
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  async function load() {
    if (state) return state;
    let text = null;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') throw new RegistryError('unreadable', 'the resource registry could not be read');
    }
    if (text === null) { state = { access: readOnly ? 'read-only' : 'read-write', resources: new Map() }; return state; }
    let doc;
    try { doc = JSON.parse(text); } catch { throw new RegistryError('corrupt', 'the resource registry is not valid JSON; it was left untouched'); }
    const access = contracts.versionAccess(doc?.schemaVersion, contracts.SCHEMA_VERSION);
    if (access === 'unsupported' || access === 'migrate') throw new RegistryError('version', `the resource registry is version ${JSON.stringify(doc?.schemaVersion)}; it was left untouched`);
    const resources = new Map();
    if (access === 'read-write') {
      for (const entry of Array.isArray(doc.resources) ? doc.resources : []) {
        if (doc.schemaVersion === '1.0' && entry?.record) entry.record = migrateRecord(entry.record, rootGrantId);
        // the grant is this shell's name for the folder: a registry that came from another shell, or whose folder was granted anew, names this one
        if (entry?.record?.locator?.kind === 'local' && entry.record.locator.rootGrantId !== rootGrantId) entry.record = { ...entry.record, locator: { ...entry.record.locator, rootGrantId } };
        const checked = contracts.validateDTO('ResourceRecord', entry?.record);
        if (!checked.ok) throw new RegistryError('corrupt', 'the resource registry holds a record that does not fit the contract; it was left untouched');
        resources.set(entry.record.fileId, { record: entry.record, observed: entry.observed ?? null });
      }
    } else {
      // a newer version: keep what this build can read, and never write it back
      for (const entry of Array.isArray(doc.resources) ? doc.resources : []) {
        if (contracts.validateDTO('ResourceRecord', entry?.record).ok) resources.set(entry.record.fileId, { record: entry.record, observed: entry.observed ?? null });
      }
    }
    state = { access: readOnly ? 'read-only' : access, resources };
    return state;
  }

  async function save() {
    if (state.access !== 'read-write') throw new RegistryError('read-only', 'the resource registry is read-only here');
    const doc = {
      schemaVersion: contracts.SCHEMA_VERSION,
      workspaceId,
      resources: [...state.resources.values()].sort((a, b) => (a.record.fileId < b.record.fileId ? -1 : 1)),
    };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  }

  const isLost = (record) => record.status === 'missing' || record.status === 'ambiguous';
  const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
  /** The record of the file that is at this path now: lost files do not hold their old paths. */
  const liveAt = (relativePath) => [...state.resources.values()].find((e) => e.record.relativePath === relativePath && !isLost(e.record)) ?? null;
  const liveStatus = () => (state.access === 'read-write' ? 'ready' : 'readonly');

  /** Put a new record in, or change one, and store the registry; on failure memory is put back as it was. */
  async function commit(fileId, entry) {
    const previous = state.resources.get(fileId);
    state.resources.set(fileId, entry);
    // a read-only workspace still gets identities for this session; they are not stored
    if (state.access !== 'read-write') return;
    try { await save(); } catch (e) {
      if (previous) state.resources.set(fileId, previous); else state.resources.delete(fileId);
      throw e;
    }
  }

  function newRecord({ relativePath, mediaType, origin, revision = null, importedFrom }) {
    const record = {
      fileId: newId(),
      workspaceId,
      relativePath,
      locator: { kind: 'local', rootGrantId, relativePath },
      sourceRevision: null,
      mediaType,
      origin,
      status: liveStatus(),
      revision,
      ...(importedFrom ? { importedFrom } : {}),
    };
    const checked = contracts.validateDTO('ResourceRecord', record);
    if (!checked.ok) throw new RegistryError('invalid-record', 'the new record does not fit the contract: ' + checked.errors.map((e) => `${e.path} ${e.message}`).join('; '));
    return record;
  }

  return {
    /** 'read-write', or 'read-only' for a read-only root or a newer registry */
    access: () => serial(async () => (await load()).access),

    get: (fileId) => serial(async () => (await load()).resources.get(fileId)?.record ?? null),

    /** The record and what the file system last showed for it (`observed`), or null. */
    entry: (fileId) => serial(async () => { const e = (await load()).resources.get(fileId); return e ? { record: e.record, observed: e.observed } : null; }),

    /** The record of the file that is at `relativePath` now, or null. A lost file's record is not found by its old path. */
    findByPath: (relativePath) => serial(async () => { await load(); return liveAt(relativePath)?.record ?? null; }),

    all: () => serial(async () => [...(await load()).resources.values()].map((e) => e.record)),

    /**
     * The record of a file that is already there at `relativePath`: the one
     * registered for it, else a new one with a fresh fileId. `observed` is
     * what the file system showed (device, inode, size, mtime), kept beside
     * the record for telling a moved file from a new one later; it is never
     * the identity. A lost record at that path is taken up again only when
     * the file there is provably the same file; a name alone is not proof.
     */
    register: ({ relativePath, mediaType, origin, observed, revision = null, importedFrom }) => serial(async () => {
      await load();
      const existing = liveAt(relativePath);
      if (existing) return existing.record;
      const returned = [...state.resources.values()].find((e) => e.record.relativePath === relativePath && isLost(e.record) && sameFile(e.observed, observed));
      if (returned) {
        const record = { ...returned.record, status: liveStatus() };
        await commit(record.fileId, { record, observed: observed ?? returned.observed });
        return record;
      }
      const record = newRecord({ relativePath, mediaType, origin, revision, importedFrom });
      await commit(record.fileId, { record, observed: observed ?? null });
      return record;
    }),

    /**
     * The record of a file that was just made at `relativePath`: always a
     * new identity. Whatever record held that path before is of a file that
     * is no longer there (the name was free to create), so it is marked
     * missing and keeps its own identity.
     */
    create: ({ relativePath, mediaType, origin, observed, revision = null, importedFrom }) => serial(async () => {
      await load();
      const stale = liveAt(relativePath);
      const record = newRecord({ relativePath, mediaType, origin, revision, importedFrom });
      if (stale) state.resources.set(stale.record.fileId, { record: { ...stale.record, status: 'missing' }, observed: stale.observed });
      try { await commit(record.fileId, { record, observed: observed ?? null }); } catch (e) {
        if (stale) state.resources.set(stale.record.fileId, stale);
        throw e;
      }
      return record;
    }),

    /**
     * Change several records in one step, stored once: what a folder that
     * is moved or trashed does to every file in it. `change(record,
     * observed)` returns the patch for a record (or `{ patch, observed }`),
     * or null to leave it. Resolves with the records that changed; if they
     * cannot be stored, none of them is changed.
     */
    updateMany: (change) => serial(async () => {
      await load();
      const before = new Map();
      const changed = [];
      try {
        for (const [fileId, entry] of [...state.resources]) {
          const answer = change(entry.record, entry.observed);
          if (!answer) continue;
          const patch = answer.patch ?? answer;
          const record = { ...entry.record, ...patch, fileId };
          if (typeof patch.relativePath === 'string') record.locator = { ...entry.record.locator, relativePath: patch.relativePath };
          const checked = contracts.validateDTO('ResourceRecord', record);
          if (!checked.ok) throw new RegistryError('invalid-record', 'a changed record does not fit the contract: ' + checked.errors.map((e) => `${e.path} ${e.message}`).join('; '));
          before.set(fileId, entry);
          state.resources.set(fileId, { record, observed: answer.patch && answer.observed !== undefined ? answer.observed : entry.observed });
          changed.push(record);
        }
        if (changed.length > 0 && state.access === 'read-write') await save();
      } catch (e) {
        for (const [fileId, entry] of before) state.resources.set(fileId, entry);
        throw e;
      }
      return changed;
    }),

    /**
     * Change a registered file's record: where it is, what its content
     * hashes to, whether it is still there. The fileId never changes. A new
     * `relativePath` moves the locator with it. Resolves with the new record.
     */
    update: (fileId, patch, observed) => serial(async () => {
      await load();
      const entry = state.resources.get(fileId);
      if (!entry) throw new RegistryError('unknown-file', 'that file is not registered');
      const record = { ...entry.record, ...patch, fileId };
      if (typeof patch.relativePath === 'string') record.locator = { ...entry.record.locator, relativePath: patch.relativePath };
      const checked = contracts.validateDTO('ResourceRecord', record);
      if (!checked.ok) throw new RegistryError('invalid-record', 'the changed record does not fit the contract: ' + checked.errors.map((e) => `${e.path} ${e.message}`).join('; '));
      await commit(fileId, { record, observed: observed === undefined ? entry.observed : observed });
      return record;
    }),
  };
}

module.exports = { createRegistry, migrateRecord, writeFileAtomic, RegistryError, REGISTRY_FILE };

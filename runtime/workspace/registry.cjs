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

  const byPath = (relativePath) => [...state.resources.values()].find((e) => e.record.relativePath === relativePath) ?? null;

  return {
    /** 'read-write', or 'read-only' for a read-only root or a newer registry */
    access: () => serial(async () => (await load()).access),

    get: (fileId) => serial(async () => (await load()).resources.get(fileId)?.record ?? null),

    findByPath: (relativePath) => serial(async () => { await load(); return byPath(relativePath)?.record ?? null; }),

    all: () => serial(async () => [...(await load()).resources.values()].map((e) => e.record)),

    /**
     * The record of the file at `relativePath`: the one already registered
     * there, else a new one with a fresh fileId. `observed` is what the file
     * system showed (device, inode, size, mtime), kept beside the record for
     * telling a moved file from a new one later; it is never the identity.
     */
    register: ({ relativePath, mediaType, origin, observed }) => serial(async () => {
      await load();
      const existing = byPath(relativePath);
      if (existing) return existing.record;
      const record = {
        fileId: newId(),
        workspaceId,
        relativePath,
        locator: { kind: 'local', rootGrantId, relativePath },
        sourceRevision: null,
        mediaType,
        origin,
        status: state.access === 'read-write' ? 'ready' : 'readonly',
        revision: null,
      };
      const checked = contracts.validateDTO('ResourceRecord', record);
      if (!checked.ok) throw new RegistryError('invalid-record', 'the new record does not fit the contract: ' + checked.errors.map((e) => `${e.path} ${e.message}`).join('; '));
      state.resources.set(record.fileId, { record, observed: observed ?? null });
      // a read-only workspace still gets identities for this session; they are not stored
      if (state.access === 'read-write') {
        try { await save(); } catch (e) { state.resources.delete(record.fileId); throw e; }
      }
      return record;
    }),
  };
}

module.exports = { createRegistry, writeFileAtomic, RegistryError, REGISTRY_FILE };

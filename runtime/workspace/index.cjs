// The workspace service: real project folders, opened through one narrow
// door. A folder joins only through the system's own picker; from then on
// the renderer names it by an opaque id and names places inside it by entry
// ids this service handed out. It never sends a path, and nothing here acts
// on one it was sent.
//
// Opening a folder reads its listing, not its files: no content is read and
// nothing is indexed. A file gets an identity when it is first used.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertAllowedPath, WorkspaceAccessError, METADATA_DIR } = require('./path-policy.cjs');
const { createRegistry, writeFileAtomic } = require('./registry.cjs');
const { mediaTypeOf } = require('./media-types.cjs');
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
 */
function createWorkspaceService({ stateDir, pickDirectory, now = () => new Date().toISOString(), newId = () => randomUUID() }) {
  const grantsFile = path.join(stateDir, GRANTS_FILE);
  let grants = null;              // Map<rootGrantId, { rootPath, workspaceId, displayName, readOnly, grantedAt }>
  const registries = new Map();   // workspaceId → registry

  async function loadGrants() {
    if (grants) return grants;
    grants = new Map();
    try {
      const doc = JSON.parse(await fsp.readFile(grantsFile, 'utf8'));
      for (const [id, g] of Object.entries(doc?.grants ?? {})) {
        if (g && typeof g.rootPath === 'string' && path.isAbsolute(g.rootPath) && typeof g.workspaceId === 'string') grants.set(id, g);
      }
    } catch { /* no grants yet */ }
    return grants;
  }
  async function saveGrants() {
    await fsp.mkdir(stateDir, { recursive: true });
    await writeFileAtomic(grantsFile, JSON.stringify({ grants: Object.fromEntries(grants) }, null, 2) + '\n');
  }

  const recordOf = (rootGrantId, g) => ({ workspaceId: g.workspaceId, displayName: g.displayName, readOnly: g.readOnly, kind: 'local', rootGrantId });

  async function grantOf(workspaceId) {
    for (const [rootGrantId, g] of await loadGrants()) if (g.workspaceId === workspaceId) return { rootGrantId, ...g };
    throw new WorkspaceAccessError('no-grant', 'that workspace is not open');
  }

  async function registryOf(grant) {
    let registry = registries.get(grant.workspaceId);
    if (!registry) {
      registry = createRegistry({ rootPath: grant.rootPath, workspaceId: grant.workspaceId, rootGrantId: grant.rootGrantId, readOnly: grant.readOnly, contracts: await loadContracts() });
      registries.set(grant.workspaceId, registry);
    }
    return registry;
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

  return {
    /** Ask the person for a folder and open it. Null when they cancel. */
    async chooseRoot() {
      const picked = await pickDirectory();
      if (!picked) return null;
      let rootPath;
      try { rootPath = await fsp.realpath(picked); } catch { throw new WorkspaceAccessError('root-missing', 'the chosen folder is not there'); }
      if (!(await fsp.stat(rootPath)).isDirectory()) throw new WorkspaceAccessError('not-a-directory', 'a workspace is a folder');
      if (path.dirname(rootPath) === rootPath) throw new WorkspaceAccessError('root-too-wide', 'a whole disk cannot be a workspace; choose a folder');
      await loadGrants();
      for (const [rootGrantId, g] of grants) if (g.rootPath === rootPath) return recordOf(rootGrantId, g);
      const writable = await fsp.access(rootPath, fs.constants.W_OK).then(() => true, () => false);
      const { workspaceId, readOnly } = await identityOf(rootPath, writable);
      const rootGrantId = `grant_${newId()}`;
      const grant = { rootPath, workspaceId, displayName: path.basename(rootPath), readOnly, grantedAt: now() };
      grants.set(rootGrantId, grant);
      await saveGrants();
      return recordOf(rootGrantId, grant);
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
    async closeWorkspace(workspaceId) {
      const grant = await grantOf(workspaceId);
      grants.delete(grant.rootGrantId);
      registries.delete(workspaceId);
      await saveGrants();
      return true;
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
  };
}

module.exports = { createWorkspaceService, entryIdOf, relativePathOf, GRANTS_FILE, IDENTITY_FILE };

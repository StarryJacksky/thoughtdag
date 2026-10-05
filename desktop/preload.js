// The one bridge between the web layer and the desktop shell. The page
// stays a normal web app (no node integration); anything the shell can do
// for it is declared here, explicitly, one method at a time.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // Update flow: the shell checks/downloads/installs, the PAGE renders every
  // prompt as in-app toasts (same look and language as the rest of the UI).
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (cb) => { ipcRenderer.on('update:event', (_e, data) => cb(data)); },
});

// Session atlas: fenced read-only primitives over the runner session
// stores (see main.js SESSION_ROOTS). Runner knowledge stays in the page.
contextBridge.exposeInMainWorld('desktopSessions', {
  roots: () => ipcRenderer.invoke('sessions:roots'),
  addRoot: () => ipcRenderer.invoke('sessions:add-root'),
  removeRoot: (key) => ipcRenderer.invoke('sessions:remove-root', key),
  list: (rootKey) => ipcRenderer.invoke('sessions:list', rootKey),
  head: (rootKey, rel, bytes) => ipcRenderer.invoke('sessions:head', rootKey, rel, bytes),
  read: (rootKey, rel) => ipcRenderer.invoke('sessions:read', rootKey, rel),
  readRange: (rootKey, rel, start, length) => ipcRenderer.invoke('sessions:read-range', rootKey, rel, start, length),
  openInCli: (runner, cwd, sessionId, mode) => ipcRenderer.invoke('sessions:open-in-cli', runner, cwd, sessionId, mode),
  openTargets: () => ipcRenderer.invoke('sessions:open-targets'),
  setOpenPrefs: (prefs) => ipcRenderer.invoke('sessions:set-open-prefs', prefs),
  addTerminal: () => ipcRenderer.invoke('sessions:add-terminal'),
  watchStart: () => ipcRenderer.invoke('sessions:watch-start'),
  onSessionsChanged: (cb) => { ipcRenderer.on('sessions:changed', (_e, data) => cb(data)); },
  onDeepLink: (cb) => { ipcRenderer.on('sessions:deeplink', (_e, url) => cb(url)); },
  commandsStatus: () => ipcRenderer.invoke('commands:status'),
  commandsInstall: (runner) => ipcRenderer.invoke('commands:install', runner),
  commandsRemove: (runner) => ipcRenderer.invoke('commands:remove', runner),
  codexThreads: () => ipcRenderer.invoke('codex:threads'),
  codexThreadRead: (threadId) => ipcRenderer.invoke('codex:thread-read', threadId),
  pendingDeepLink: () => ipcRenderer.invoke('sessions:pending-deeplink'),
});

// Local paths mentioned in responses: open here, on this machine (folder
// or file in Finder, image/PDF in its viewer), and images inline as data
// URLs. Nothing executable is ever launched.
// Agent runtimes the shell can hand a turn to (Pi today). `run` resolves
// with a run id at once; the run's events arrive through onEvent tagged
// with that id, ending with `run_end`.
contextBridge.exposeInMainWorld('desktopAgents', {
  capabilities: { nativePicker: true },
  available: () => ipcRenderer.invoke('agents:available'),
  models: (runtime) => ipcRenderer.invoke('agents:models', runtime),
  run: (request) => ipcRenderer.invoke('agents:run', request),
  abort: (runId) => ipcRenderer.invoke('agents:abort', runId),
  workspace: (canvasId) => ipcRenderer.invoke('agents:workspace', canvasId),
  answer: (runId, requestId, response) => ipcRenderer.invoke('agents:answer', runId, requestId, response),
  guardWrite: (cwd, config) => ipcRenderer.invoke('agents:guard-write', cwd, config),
  pickCwd: () => ipcRenderer.invoke('agents:pick-cwd'),
  writeMaterials: (cwd, files) => ipcRenderer.invoke('agents:write-materials', cwd, files),
  onEvent: (cb) => { ipcRenderer.on('agents:event', (_e, payload) => cb(payload)); },
});

// The person's real project folders (main.js setupWorkspace). The page names
// a workspace and an entry by the ids it was given; it never sends a path.
contextBridge.exposeInMainWorld('desktopWorkspace', {
  chooseRoot: () => ipcRenderer.invoke('workspace:choose-root'),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list-workspaces'),
  close: (workspaceId) => ipcRenderer.invoke('workspace:close', workspaceId),
  listChildren: (workspaceId, parentId) => ipcRenderer.invoke('workspace:list-children', workspaceId, parentId),
  registerEntry: (workspaceId, entryId) => ipcRenderer.invoke('workspace:register-entry', workspaceId, entryId),
  createFile: (request) => ipcRenderer.invoke('workspace:create-file', request),
  importText: (request, options) => ipcRenderer.invoke('workspace:import-text', request, options),
  createFolder: (workspaceId, parentId, name) => ipcRenderer.invoke('workspace:create-folder', workspaceId, parentId, name),
  readText: (fileId) => ipcRenderer.invoke('workspace:read-text', fileId),
  saveText: (fileId, baseRevision, text, opId) => ipcRenderer.invoke('workspace:save-text', fileId, baseRevision, text, opId),
  moveFile: (fileId, targetParentId, newName, opId) => ipcRenderer.invoke('workspace:move-file', fileId, targetParentId, newName, opId),
  copyFile: (fileId, targetParentId, newName, opId) => ipcRenderer.invoke('workspace:copy-file', fileId, targetParentId, newName, opId),
  trashFile: (fileId, opId) => ipcRenderer.invoke('workspace:trash-file', fileId, opId),
  moveFolder: (workspaceId, entryId, targetParentId, newName, opId) => ipcRenderer.invoke('workspace:move-folder', workspaceId, entryId, targetParentId, newName, opId),
  copyFolder: (workspaceId, entryId, targetParentId, newName, opId) => ipcRenderer.invoke('workspace:copy-folder', workspaceId, entryId, targetParentId, newName, opId),
  trashFolder: (workspaceId, entryId, opId) => ipcRenderer.invoke('workspace:trash-folder', workspaceId, entryId, opId),
  listRecovery: (workspaceId) => ipcRenderer.invoke('workspace:list-recovery', workspaceId),
  restore: (workspaceId, receiptId, opId) => ipcRenderer.invoke('workspace:restore', workspaceId, receiptId, opId),
  listVersions: (fileId) => ipcRenderer.invoke('workspace:list-versions', fileId),
  restoreVersion: (fileId, revision, baseRevision, opId) => ipcRenderer.invoke('workspace:restore-version', fileId, revision, baseRevision, opId),
  putDraft: (fileId, draft) => ipcRenderer.invoke('workspace:put-draft', fileId, draft),
  getDraft: (fileId) => ipcRenderer.invoke('workspace:get-draft', fileId),
  clearDraft: (fileId) => ipcRenderer.invoke('workspace:clear-draft', fileId),
  reconcile: (fileId) => ipcRenderer.invoke('workspace:reconcile', fileId),
  rescan: (workspaceId) => ipcRenderer.invoke('workspace:rescan', workspaceId),
  relink: (fileId, entryId) => ipcRenderer.invoke('workspace:relink', fileId, entryId),
  readSource: (fileId) => ipcRenderer.invoke('workspace:read-source', fileId),
  capabilities: (workspaceId) => ipcRenderer.invoke('workspace:capabilities', workspaceId),
  openDefault: (canvasId) => ipcRenderer.invoke('workspace:open-default', canvasId),
  reveal: (fileId) => ipcRenderer.invoke('workspace:reveal', fileId),
  subscribe: (workspaceId) => ipcRenderer.invoke('workspace:subscribe', workspaceId),
  watching: (workspaceId) => ipcRenderer.invoke('workspace:watching', workspaceId),
  unsubscribe: (workspaceId) => ipcRenderer.invoke('workspace:unsubscribe', workspaceId),
  onEvent: (cb) => { ipcRenderer.on('workspace:event', (_e, event) => cb(event)); },
});

// The why layer: search across every local agent's sessions and the
// memories Claude Code and Codex keep, recall one turn or entry in full.
contextBridge.exposeInMainWorld('desktopWhy', {
  status: () => ipcRenderer.invoke('why:status'),
  find: (phrase, opts) => ipcRenderer.invoke('why:find', phrase, opts),
  turns: (opts) => ipcRenderer.invoke('why:turns', opts),
  recall: (session, turn) => ipcRenderer.invoke('why:recall', session, turn),
  memories: () => ipcRenderer.invoke('why:memories'),
  suggest: (term, k) => ipcRenderer.invoke('why:suggest', term, k),
  topics: () => ipcRenderer.invoke('why:topics'),
  setTopics: (topics) => ipcRenderer.invoke('why:set-topics', topics),
  labelStart: (call, opts) => ipcRenderer.invoke('why:label-start', call, opts),
  labelStop: () => ipcRenderer.invoke('why:label-stop'),
  byTopic: (ids, opts) => ipcRenderer.invoke('why:by-topic', ids, opts),
  sample: (n) => ipcRenderer.invoke('why:sample', n),
  dossiers: () => ipcRenderer.invoke('why:dossiers'),
  dossier: (id) => ipcRenderer.invoke('why:dossier', id),
  setDossier: (id, d) => ipcRenderer.invoke('why:set-dossier', id, d),
  deleteDossier: (id) => ipcRenderer.invoke('why:delete-dossier', id),
  dossierPending: (id, item) => ipcRenderer.invoke('why:dossier-pending', id, item),
  dossierNewTurns: (id, opts) => ipcRenderer.invoke('why:dossier-new', id, opts),
});

contextBridge.exposeInMainWorld('desktopLocal', {
  open: (p) => ipcRenderer.invoke('local:open', p),
  image: (p) => ipcRenderer.invoke('local:image', p),
});

// The canvas's own source record for the why layer (see main.js): the page
// hands over a project id and its slim JSON; the shell decides where it lives.
contextBridge.exposeInMainWorld('desktopCanvas', {
  write: (projectId, json) => ipcRenderer.invoke('canvas:record-write', projectId, json),
  remove: (projectId) => ipcRenderer.invoke('canvas:record-remove', projectId),
});

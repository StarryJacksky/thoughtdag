// A local folder as a workspace source. It adds nothing of its own: every
// call goes through the workspace service, with its path policy, its
// journal and its registry. What this file does is put a local folder
// behind the same five calls every source answers, so nothing above it has
// to know it is talking to a disk.
'use strict';

const { WorkspaceAccessError } = require('../path-policy.cjs');
const { decodeText, MAX_EDITABLE_BYTES } = require('../file-ops.cjs');

/** Entries per page of a listing; a large folder is read in several. */
const PAGE_SIZE = 500;

const cursorOf = (offset) => `c_${offset}`;
function offsetOf(cursor) {
  if (cursor === undefined || cursor === null) return 0;
  const m = /^c_(\d+)$/.exec(String(cursor));
  if (!m) throw new WorkspaceAccessError('invalid-cursor', 'that is not a listing cursor of this source');
  return Number(m[1]);
}

function assertLocal(scope) {
  if (!scope || scope.kind !== 'local') throw new WorkspaceAccessError('wrong-source', 'this is not a local workspace');
}

/** `service` is what runtime/workspace/index.cjs creates. */
function createLocalProvider(service, { pageSize = PAGE_SIZE } = {}) {
  return {
    async capabilities(scope) {
      assertLocal(scope);
      const write = scope.readOnly ? 'unsupported' : 'supported';
      return {
        list: 'supported', read: 'supported',
        create: write, update: write, move: write, trash: write,
        // a save names the revision it read and is refused if the file moved on
        conditionalWrite: write,
        // a folder holds files, not native pages
        pagePatch: 'unsupported',
        changes: 'supported',
        // any file type may be created, the mind-map format included
        uploadCustomType: write,
      };
    },

    async list(scope, parentId, cursor) {
      assertLocal(scope);
      const offset = offsetOf(cursor);
      const all = await service.listChildren(scope.workspaceId, parentId);
      const entries = all.slice(offset, offset + pageSize);
      const next = offset + pageSize < all.length ? cursorOf(offset + pageSize) : null;
      // a folder on disk is listed whole or not at all: never partial
      return { entries, nextCursor: next, completeness: 'complete' };
    },

    /** `options.maxBytes` refuses a larger file from its size, before any of it is read. */
    async read(scope, fileId, options = {}) {
      assertLocal(scope);
      const { bytes, revision } = await service.readBytes(fileId, { maxBytes: options.maxBytes });
      let text = null;
      if (bytes.length <= MAX_EDITABLE_BYTES) { try { text = decodeText(bytes).text; } catch { /* not text */ } }
      return {
        fileId,
        sourceRevision: null, // a local file has no version but its content
        contentHash: revision,
        representation: text === null ? 'bytes' : 'text',
        payload: text === null ? new Uint8Array(bytes) : text,
        fidelity: 'original',
      };
    },

    /** A local file has no version but its content: the base a write names is
     *  the content hash it read (see writeBaseOf in provider-helpers). */
    async write(scope, request) {
      assertLocal(scope);
      if (request.representation !== 'text' || typeof request.payload !== 'string') return { status: 'unsupported', reason: 'a local file is written as text' };
      const result = await service.saveText(request.fileId, request.baseSourceRevision, request.payload, request.opId);
      switch (result.status) {
        case 'saved': return { status: 'saved', sourceRevision: null, contentHash: result.revision };
        case 'conflict': return { status: 'conflict', currentRevision: result.currentRevision };
        case 'readonly': return { status: 'readonly', reason: result.reason };
        default: return { status: 'error', reason: result.reason };
      }
    },

    async create(scope, request) {
      assertLocal(scope);
      if (request.workspaceId !== scope.workspaceId) throw new WorkspaceAccessError('wrong-source', 'the request is for another workspace');
      return service.createFile(request);
    },

    // What a folder can do beyond the five calls every source answers. The
    // door asks for one of these only after the matching capability said
    // `supported`; a source that has no such method is refused there.
    async move(scope, fileId, targetParentId, newName, opId) { assertLocal(scope); return service.moveFile(fileId, targetParentId, newName, opId); },
    async copy(scope, fileId, targetParentId, newName, opId) { assertLocal(scope); return service.copyFile(fileId, targetParentId, newName, opId); },
    async trash(scope, fileId, opId) { assertLocal(scope); return service.trashFile(fileId, opId); },
    async createFolder(scope, parentId, name) { assertLocal(scope); return service.createFolder(scope.workspaceId, parentId, name); },
    async importText(scope, request, options) {
      assertLocal(scope);
      if (request.workspaceId !== scope.workspaceId) throw new WorkspaceAccessError('wrong-source', 'the request is for another workspace');
      return service.importText(request, options);
    },
    async moveFolder(scope, entryId, targetParentId, newName, opId) { assertLocal(scope); return service.moveFolder(scope.workspaceId, entryId, targetParentId, newName, opId); },
    async copyFolder(scope, entryId, targetParentId, newName, opId) { assertLocal(scope); return service.copyFolder(scope.workspaceId, entryId, targetParentId, newName, opId); },
    async trashFolder(scope, entryId, opId) { assertLocal(scope); return service.trashFolder(scope.workspaceId, entryId, opId); },
    /** What was trashed into this source's own recovery area and can be put back. */
    async listRecovery(scope) { assertLocal(scope); return service.listRecovery(scope.workspaceId); },
    async restore(scope, receiptId, opId) { assertLocal(scope); return service.restoreFromRecovery(scope.workspaceId, receiptId, opId); },
    /** What a file held before each save that replaced it. */
    async listVersions(scope, fileId) { assertLocal(scope); return service.listVersions(fileId); },
    async restoreVersion(scope, fileId, revision, baseRevision, opId) { assertLocal(scope); return service.restoreVersion(fileId, revision, baseRevision, opId); },
    /** Text typed into a file and not yet written to it, kept so it is not lost. */
    async putDraft(scope, fileId, draft) { assertLocal(scope); return service.putDraft(fileId, draft); },
    async getDraft(scope, fileId) { assertLocal(scope); return service.getDraft(fileId); },
    async clearDraft(scope, fileId) { assertLocal(scope); return service.clearDraft(fileId); },
    /** Give the entry its identity in this source, or return the one it has. */
    async register(scope, entryId) { assertLocal(scope); return service.registerEntry(scope.workspaceId, entryId); },
    async reconcile(scope, fileId) { assertLocal(scope); return service.reconcile(fileId); },
    async rescan(scope) { assertLocal(scope); return service.rescanWorkspace(scope.workspaceId); },
    async relink(scope, fileId, entryId) { assertLocal(scope); return service.relink(fileId, entryId); },
    /** Where the file is on this machine, for showing it in the file manager. Never handed to the page. */
    async locate(scope, fileId) { assertLocal(scope); return service.locate(fileId); },
    /** Whether changes to this folder are noticed on their own (some volumes cannot be watched; a rescan still works). */
    async watching(scope) { assertLocal(scope); return service.watching(scope.workspaceId); },
    /** Hear about changes; resolves with the function that stops it. */
    async subscribe(scope, listener) { assertLocal(scope); return service.subscribeWorkspace(scope.workspaceId, listener); },
  };
}

module.exports = { createLocalProvider, PAGE_SIZE };

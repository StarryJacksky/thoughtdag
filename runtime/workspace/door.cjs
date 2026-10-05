// What the page may ask of workspaces, in one table. Each entry is what one
// IPC channel does. The shell puts its own check of who is asking in front
// of every entry (see ipc-guard.cjs); this module is everything behind that
// check, so it can be driven by a test without a window.
//
// Nothing here knows what kind of source a workspace is. A workspace id or
// a file id is turned into a provider by the provider registry, the
// provider is asked what it supports, and only then is it asked to do it.
// A source that does not say `supported` is refused here, before anything
// is attempted, and is never tried "to see what happens".
//
// Opening a folder is the one thing that is about local folders by nature:
// a folder joins through the system's picker or as a canvas's own folder,
// and the service that grants it is called directly for that.
'use strict';

const { WorkspaceAccessError } = require('./path-policy.cjs');

const helpers = import('../../shared/workspace/provider-helpers.mjs');

/** Above this a file is referred to by the page and its content is not sent to it. */
const MAX_PAGE_READ_BYTES = 8 * 1024 * 1024;
/** Above this a file is not sent to the page even to be looked at (a PDF, an image). */
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

const newlineOf = (text) => {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf';
};

/**
 *   service            the local workspace service (granting and closing folders)
 *   providers          the provider registry (everything about a workspace's content)
 *   canvasFolder       `(canvasId) => Promise<absolutePath>`: where a canvas's own folder is
 *   showInFileManager  `(absolutePath) => void`: shows a file, never opens it
 *   hub                the page's subscriptions (see subscriptions.cjs)
 * Returns `{ [channel]: async (context, ...args) }`; `context.senderId` is
 * the id of the page that asked.
 */
function createWorkspaceDoor({ service, providers, canvasFolder, showInFileManager, hub }) {
  const optional = (id) => (id == null ? undefined : String(id));

  /** The source behind a workspace or a file, checked for the operation that is about to be asked of it. */
  async function allowed(found, operation, fileId) {
    const { canDo } = await helpers;
    const capabilities = await found.provider.capabilities(found.scope, fileId);
    if (!canDo(capabilities, operation)) throw new WorkspaceAccessError('unsupported', `this source does not support that (${operation}: ${capabilities?.[operation] ?? 'unknown'})`);
    return found;
  }
  const ofWorkspace = async (workspaceId, operation) => allowed(await providers.providerFor(String(workspaceId)), operation);
  const ofFile = async (fileId, operation) => allowed(await providers.providerForFile(String(fileId)), operation, String(fileId));
  /** One of the things a source may be able to do beyond the calls every source answers. */
  const extra = (provider, name) => {
    if (typeof provider[name] !== 'function') throw new WorkspaceAccessError('unsupported', 'this source does not support that');
    return provider[name].bind(provider);
  };

  return {
    'workspace:choose-root': () => service.chooseRoot(),
    'workspace:open-default': async (_context, canvasId) => service.openManaged(await canvasFolder(String(canvasId))),
    'workspace:list-workspaces': () => providers.workspaces(),
    'workspace:close': (_context, workspaceId) => service.closeWorkspace(String(workspaceId)),

    /** What the source of a workspace supports: the page decides what to offer from this, never from the kind of source. */
    'workspace:capabilities': async (_context, workspaceId) => {
      const { scope, provider } = await providers.providerFor(String(workspaceId));
      return provider.capabilities(scope);
    },

    'workspace:list-children': async (_context, workspaceId, parentId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'list');
      const { collectPages } = await helpers;
      const { entries, completeness } = await collectPages(provider, scope, optional(parentId));
      // part of a listing is not the listing: the page is told, and shows no folder as if it were whole or empty
      if (completeness !== 'complete') throw new WorkspaceAccessError('partial-listing', 'this folder could not be listed whole');
      return entries;
    },

    'workspace:register-entry': async (_context, workspaceId, entryId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'read');
      return extra(provider, 'register')(scope, String(entryId));
    },

    'workspace:create-file': async (_context, request) => {
      const { scope, provider } = await providers.providerFor(String(request?.workspaceId));
      const { createThrough } = await helpers;
      return createThrough(provider, scope, request);
    },

    'workspace:import-text': async (_context, request, options) => {
      const { scope, provider } = await ofWorkspace(request?.workspaceId, 'create');
      return extra(provider, 'importText')(scope, request, options && typeof options === 'object' ? options : {});
    },

    'workspace:create-folder': async (_context, workspaceId, parentId, name) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'create');
      return extra(provider, 'createFolder')(scope, optional(parentId), String(name));
    },

    /** A file's content as its source gives it: text, or bytes, with the hash of what was read. Too large a file is refused unread. */
    'workspace:read-source': async (_context, fileId) => {
      const { scope, provider } = await ofFile(fileId, 'read');
      return provider.read(scope, String(fileId), { maxBytes: MAX_PAGE_READ_BYTES });
    },

    /** A file's content to be looked at, not copied into anything: the same answer as read-source, with room for a document or an image. */
    'workspace:read-view': async (_context, fileId) => {
      const { scope, provider } = await ofFile(fileId, 'read');
      return provider.read(scope, String(fileId), { maxBytes: MAX_VIEW_BYTES });
    },

    /** A file's text and the revision a later save must name. */
    'workspace:read-text': async (_context, fileId) => {
      const { scope, provider } = await ofFile(fileId, 'read');
      const { writeBaseOf } = await helpers;
      const read = await provider.read(scope, String(fileId), { maxBytes: MAX_PAGE_READ_BYTES });
      if (read.representation !== 'text' || typeof read.payload !== 'string') throw new WorkspaceAccessError('not-text', 'the file is not text that can be opened for editing');
      if (read.fidelity !== 'original') throw new WorkspaceAccessError('not-text', 'what this source gave is a rendering of the file, not the file: it is not opened for editing');
      return { text: read.payload, revision: writeBaseOf(read), encoding: 'utf-8', newline: newlineOf(read.payload) };
    },

    'workspace:save-text': async (_context, fileId, baseRevision, text, opId) => {
      const { scope, provider } = await providers.providerForFile(String(fileId));
      const { writeThrough } = await helpers;
      const result = await writeThrough(provider, scope, { fileId: String(fileId), baseSourceRevision: String(baseRevision), representation: 'text', payload: text, opId: String(opId) });
      switch (result.status) {
        case 'saved': return { status: 'saved', revision: result.sourceRevision ?? result.contentHash, sourceRevision: result.sourceRevision };
        case 'conflict': return { status: 'conflict', currentRevision: result.currentRevision };
        case 'unknown-ack': return { status: 'unknown-ack', reason: result.reason, opId: String(opId) };
        // a source that cannot be written is, to the person typing, a file that is read-only
        case 'unsupported': case 'readonly': return { status: 'readonly', reason: result.reason };
        default: return { status: 'error', reason: result.reason };
      }
    },

    'workspace:move-file': async (_context, fileId, targetParentId, newName, opId) => {
      const { scope, provider } = await ofFile(fileId, 'move');
      return extra(provider, 'move')(scope, String(fileId), optional(targetParentId), String(newName), String(opId));
    },
    'workspace:copy-file': async (_context, fileId, targetParentId, newName, opId) => {
      const { scope, provider } = await ofFile(fileId, 'create');
      return extra(provider, 'copy')(scope, String(fileId), optional(targetParentId), String(newName), String(opId));
    },
    'workspace:trash-file': async (_context, fileId, opId) => {
      const { scope, provider } = await ofFile(fileId, 'trash');
      return extra(provider, 'trash')(scope, String(fileId), String(opId));
    },

    'workspace:move-folder': async (_context, workspaceId, entryId, targetParentId, newName, opId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'move');
      return extra(provider, 'moveFolder')(scope, String(entryId), optional(targetParentId), String(newName), String(opId));
    },
    'workspace:copy-folder': async (_context, workspaceId, entryId, targetParentId, newName, opId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'create');
      return extra(provider, 'copyFolder')(scope, String(entryId), optional(targetParentId), String(newName), String(opId));
    },
    'workspace:trash-folder': async (_context, workspaceId, entryId, opId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'trash');
      return extra(provider, 'trashFolder')(scope, String(entryId), String(opId));
    },

    /** What was trashed into the workspace's own recovery area and can be put back. */
    'workspace:list-recovery': async (_context, workspaceId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'list');
      return extra(provider, 'listRecovery')(scope);
    },
    'workspace:restore': async (_context, workspaceId, receiptId, opId) => {
      const { scope, provider } = await ofWorkspace(workspaceId, 'create');
      return extra(provider, 'restore')(scope, String(receiptId), String(opId));
    },
    /** What a file held before each save that replaced it. */
    'workspace:list-versions': async (_context, fileId) => {
      const { scope, provider } = await ofFile(fileId, 'read');
      return extra(provider, 'listVersions')(scope, String(fileId));
    },
    'workspace:restore-version': async (_context, fileId, revision, baseRevision, opId) => {
      const { scope, provider } = await ofFile(fileId, 'update');
      return extra(provider, 'restoreVersion')(scope, String(fileId), String(revision), String(baseRevision), String(opId));
    },

    /** Text typed into a file and not yet written to it: kept, read back, and let go. */
    'workspace:put-draft': async (_context, fileId, draft) => {
      const { scope, provider } = await ofFile(fileId, 'update');
      return extra(provider, 'putDraft')(scope, String(fileId), { text: draft?.text, baseRevision: draft?.baseRevision });
    },
    'workspace:get-draft': async (_context, fileId) => {
      const { scope, provider } = await ofFile(fileId, 'read');
      return extra(provider, 'getDraft')(scope, String(fileId));
    },
    'workspace:clear-draft': async (_context, fileId) => {
      const { scope, provider } = await providers.providerForFile(String(fileId));
      return extra(provider, 'clearDraft')(scope, String(fileId));
    },

    'workspace:reconcile': async (_context, fileId) => {
      const { scope, provider } = await providers.providerForFile(String(fileId));
      return extra(provider, 'reconcile')(scope, String(fileId));
    },
    'workspace:rescan': async (_context, workspaceId) => {
      const { scope, provider } = await providers.providerFor(String(workspaceId));
      return extra(provider, 'rescan')(scope);
    },
    'workspace:relink': async (_context, fileId, entryId) => {
      const { scope, provider } = await providers.providerForFile(String(fileId));
      return extra(provider, 'relink')(scope, String(fileId), String(entryId));
    },

    // shown in the system file manager, never opened: a file here may be a script
    'workspace:reveal': async (_context, fileId) => {
      const { scope, provider } = await providers.providerForFile(String(fileId));
      showInFileManager(await extra(provider, 'locate')(scope, String(fileId)));
      return true;
    },

    'workspace:subscribe': (context, workspaceId) => hub.subscribe(String(workspaceId), context?.senderId ?? null),
    /** Whether a subscribed workspace's changes are noticed on their own. False means: nothing will be heard unless a rescan is asked for. */
    'workspace:watching': async (_context, workspaceId) => {
      const { scope, provider } = await providers.providerFor(String(workspaceId));
      return typeof provider.watching === 'function' ? !!(await provider.watching(scope)) : false;
    },
    'workspace:unsubscribe': (_context, workspaceId) => hub.unsubscribe(String(workspaceId)),
  };
}

/**
 * What the subscription hub listens through: a workspace's changes, heard
 * from whatever source it is. A source that does not report changes is
 * refused, and the page is told so instead of waiting for news that will
 * never come.
 */
function watchingThrough(providers) {
  const source = async (workspaceId, name) => {
    const { scope, provider } = await providers.providerFor(String(workspaceId));
    if (typeof provider[name] !== 'function') throw new WorkspaceAccessError('unsupported', 'this source does not report changes');
    return { scope, provider };
  };
  return {
    async subscribeWorkspace(workspaceId, listener) {
      const { scope, provider } = await source(workspaceId, 'subscribe');
      const { canDo } = await helpers;
      if (!canDo(await provider.capabilities(scope), 'changes')) throw new WorkspaceAccessError('unsupported', 'this source does not report changes');
      return provider.subscribe(scope, listener);
    },
    async rescanWorkspace(workspaceId) {
      const { scope, provider } = await source(workspaceId, 'rescan');
      return provider.rescan(scope);
    },
  };
}

module.exports = { createWorkspaceDoor, watchingThrough, MAX_PAGE_READ_BYTES, MAX_VIEW_BYTES };

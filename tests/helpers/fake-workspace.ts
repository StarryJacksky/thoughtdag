// An in-memory stand-in for the desktop shell's workspace door
// (window.desktopWorkspace): files held in a map, answers shaped like the
// real ones, every call recorded. It lets renderer code that talks to the
// door be tested without a disk or a shell. It checks nothing about paths:
// the real policy is tested where it lives (tests/host).

import type { CreateFileRequest, DocumentDraft, FileEntry, FileVersion, RecoveryItem, ResourceRecord, SourceCapabilities, WorkspaceEvent, WorkspaceRecord } from '../../src/lib/workspace/contracts';

interface FakeFile { fileId: string; workspaceId: string; relativePath: string; content: string; status: ResourceRecord['status']; origin: ResourceRecord['origin']; importedFrom?: ResourceRecord['importedFrom']; /** set for a file that is not text: what a read gives instead of `content` */ bytes?: Uint8Array }

const encoder = new TextEncoder();
/** A stable stand-in for a content hash: distinct for distinct content, shaped like the real thing. */
export function fakeRevision(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(h, 31) + content.charCodeAt(i)) >>> 0;
  return 'sha256:' + (h.toString(16).padStart(8, '0') + content.length.toString(16).padStart(8, '0')).padEnd(64, '0');
}
const entryIdOf = (relativePath: string) => `e_${relativePath}`;
const pathOf = (entryId: string | undefined | null) => (entryId ? entryId.slice(2) : '');

export interface FakeWorkspace {
  workspace: WorkspaceRecord;
  /** what the workspace's source says it supports; change a field to stand in for a source that cannot do something */
  capabilities: SourceCapabilities;
  /** the recovery drafts the door holds, by file id */
  drafts: Map<string, DocumentDraft>;
  /** every call the door received, by method name, oldest first */
  calls: { method: string; args: unknown[] }[];
  files: Map<string, FakeFile>;
  /** put a file in the workspace as if it had always been there; returns its entry id */
  seed(relativePath: string, content: string, workspaceId?: string): string;
  entryId(relativePath: string): string;
  record(fileId: string): ResourceRecord;
  /** change a file's content as another program would, and tell the page */
  editExternally(fileId: string, content: string): void;
  /** push an event to the page, as the shell does */
  emit(event: WorkspaceEvent): void;
  /** make the next call of this method reject with `code: message` */
  failNext(method: string, code: string, message: string): void;
  /** forget the failures that were queued and never met a call */
  calm(): void;
  /** hold the next call of this method until `release()`: it answers with what is true at that later moment */
  holdNext(method: string): { release(): void };
  /** like holdNext, but the answer is worked out when the call arrives and only handed over on `release()`: an answer that is old by the time it lands */
  delayNext(method: string): { release(): void };
  uninstall(): void;
}

// The page listens to the door once for its whole life (src/lib/workspace/events.ts),
// so the listener outlives any one install, as it does with the real shell.
let listener: ((event: WorkspaceEvent) => void) | null = null;

export function installFakeWorkspace(workspaceId = 'ws_1'): FakeWorkspace {
  const workspace: WorkspaceRecord = { workspaceId, displayName: 'research-project', readOnly: false, kind: 'local', rootGrantId: 'grant_1' };
  const capabilities: SourceCapabilities = { list: 'supported', read: 'supported', create: 'supported', update: 'supported', move: 'supported', trash: 'supported', conditionalWrite: 'supported', pagePatch: 'unsupported', changes: 'supported', uploadCustomType: 'supported' };
  const files = new Map<string, FakeFile>();
  const calls: { method: string; args: unknown[] }[] = [];
  const failures = new Map<string, Error>();
  const holds = new Map<string, { when: 'before' | 'after'; gate: Promise<void> }[]>();
  const hold = (method: string, when: 'before' | 'after') => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    holds.set(method, [...(holds.get(method) ?? []), { when, gate }]);
    return { release };
  };
  const done = new Map<string, unknown>();
  // the canvases' own folders: one per canvas, made the first time it is asked for
  const own = new Map<string, WorkspaceRecord>();
  // the recovery area: what was trashed (with the files that went), and what each file held before a save
  const recovery = new Map<string, { item: RecoveryItem; fileIds: string[] }>();
  const versions = new Map<string, string[]>();
  const drafts = new Map<string, DocumentDraft>();
  const under = (relativePath: string, folder: string) => relativePath.startsWith(folder + '/');
  let serial = 0;

  const byPath = (workspace_: string, relativePath: string) => [...files.values()].find((f) => f.workspaceId === workspace_ && f.relativePath === relativePath);
  const record = (fileId: string): ResourceRecord => {
    const f = files.get(fileId);
    if (!f) throw new Error('unknown-file: that file is not known to an open workspace');
    return {
      fileId, workspaceId: f.workspaceId, relativePath: f.relativePath,
      locator: { kind: 'local', rootGrantId: 'grant_1', relativePath: f.relativePath },
      sourceRevision: null, mediaType: 'text/plain', origin: f.origin, status: f.status, revision: fakeRevision(f.content),
      ...(f.importedFrom ? { importedFrom: f.importedFrom } : {}),
    };
  };
  const add = (workspace_: string, relativePath: string, content: string, origin: ResourceRecord['origin'], importedFrom?: ResourceRecord['importedFrom']) => {
    const fileId = `file_${++serial}`;
    files.set(fileId, { fileId, workspaceId: workspace_, relativePath, content, status: 'ready', origin, ...(importedFrom ? { importedFrom } : {}) });
    return fileId;
  };
  const freeName = (workspace_: string, parent: string, candidates: () => Generator<string>) => {
    for (const name of candidates()) { const p = parent ? `${parent}/${name}` : name; if (!byPath(workspace_, p)) return p; }
    throw new Error('no-free-name: no free name was found');
  };
  const emit = (event: WorkspaceEvent) => listener?.(event);
  const event = (fileId: string, change: WorkspaceEvent['change'], opId: string | null): WorkspaceEvent => {
    const r = record(fileId);
    return { workspaceId: r.workspaceId, fileId, change, observedRevision: r.revision, opId, record: r };
  };

  /** Record the call, fail it if a failure was queued, and return an earlier answer for a repeated operation id. */
  const door = <A extends unknown[], R>(method: string, opIdAt: number | null, run: (...args: A) => R) => async (...args: A): Promise<R> => {
    calls.push({ method, args });
    const held = holds.get(method)?.shift();
    if (held?.when === 'before') await held.gate;
    const failure = failures.get(method);
    if (failure) { failures.delete(method); throw failure; }
    const opId = opIdAt === null ? null : `${method}:${String(args[opIdAt])}`;
    if (opId && done.has(opId)) return done.get(opId) as R;
    const result = run(...args);
    if (opId) done.set(opId, result);
    if (held?.when === 'after') await held.gate;
    return result;
  };

  const bridge: DesktopWorkspaceBridge = {
    chooseRoot: door('chooseRoot', null, () => workspace),
    listWorkspaces: door('listWorkspaces', null, () => [workspace, ...own.values()]),
    close: door('close', null, () => true),
    openDefault: door('openDefault', null, (canvasId: string) => {
      if (!own.has(canvasId)) own.set(canvasId, { workspaceId: `ws_own_${canvasId}`, displayName: canvasId, readOnly: false, kind: 'local', rootGrantId: `grant_own_${canvasId}` });
      return own.get(canvasId)!;
    }),
    listChildren: door('listChildren', null, (workspace_: string, parentId?: string): FileEntry[] => {
      const parent = pathOf(parentId);
      const seen = new Map<string, FileEntry>();
      for (const f of files.values()) {
        if (f.workspaceId !== workspace_ || f.status === 'missing') continue;
        if (parent && !f.relativePath.startsWith(parent + '/')) continue;
        const rest = parent ? f.relativePath.slice(parent.length + 1) : f.relativePath;
        const [head, ...more] = rest.split('/');
        const childPath = parent ? `${parent}/${head}` : head;
        if (!seen.has(head)) seen.set(head, { entryId: entryIdOf(childPath), parentId: parent ? entryIdOf(parent) : null, name: head, kind: more.length ? 'folder' : 'file', ...(more.length ? {} : { fileId: f.fileId }) });
      }
      return [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    }),
    registerEntry: door('registerEntry', null, (workspace_: string, entryId: string) => {
      const f = byPath(workspace_, pathOf(entryId));
      if (!f) throw new Error('not-found: nothing is at that path');
      return record(f.fileId);
    }),
    createFile: door('createFile', null, (request: CreateFileRequest) => {
      const key = `createFile:${request.idempotencyKey}`;
      if (done.has(key)) return done.get(key) as ResourceRecord;
      const parent = request.origin === 'graph' ? 'Graph Files' : pathOf(request.parentId);
      const prefix = request.extension === 'tdmap' ? 'Mindmap' : 'Untitled';
      const relativePath = freeName(request.workspaceId, parent, function* names() { for (let n = 1; n < 1000; n++) yield `${prefix}-${String(n).padStart(3, '0')}.${request.extension}`; });
      const created = record(add(request.workspaceId, relativePath, '', request.origin));
      done.set(key, created);
      return created;
    }),
    importText: door('importText', null, (request: CreateFileRequest, options: { text: string; name?: string | null; provenance: { source: 'chatgpt-space' | 'other'; note?: string } }) => {
      const stem = options.name ?? 'Untitled';
      const relativePath = freeName(request.workspaceId, pathOf(request.parentId), function* names() { yield `${stem}.${request.extension}`; for (let n = 2; n < 100; n++) yield `${stem}-${n}.${request.extension}`; });
      return record(add(request.workspaceId, relativePath, options.text, 'import', { source: options.provenance.source, importedAt: '2026-10-04T00:00:00Z', ...(options.provenance.note ? { note: options.provenance.note } : {}) }));
    }),
    createFolder: door('createFolder', null, (_workspace: string, parentId: string | undefined, name: string) => entryIdOf(pathOf(parentId) ? `${pathOf(parentId)}/${name}` : name)),
    readText: door('readText', null, (fileId: string) => {
      const f = files.get(fileId)!;
      const crlf = (f.content.match(/\r\n/g) ?? []).length;
      const lf = (f.content.match(/\n/g) ?? []).length - crlf;
      return { text: f.content, revision: fakeRevision(f.content), encoding: 'utf-8', newline: crlf && lf ? 'mixed' as const : crlf ? 'crlf' as const : 'lf' as const };
    }),
    readSource: door('readSource', null, (fileId: string) => {
      const f = files.get(fileId);
      if (!f || f.status === 'missing' || f.status === 'ambiguous') throw new Error('lost: the file is lost; it has to be found again first');
      const bytes = f.bytes ?? null;
      if ((bytes?.length ?? encoder.encode(f.content).length) > 8 * 1024 * 1024) throw new Error("Error invoking remote method 'workspace:read-source': Error: too-large: the file is too large to be read here");
      return bytes
        ? { fileId, sourceRevision: null, contentHash: fakeRevision(String.fromCharCode(...bytes.subarray(0, 64)) + bytes.length), representation: 'bytes' as const, payload: bytes, fidelity: 'original' as const }
        : { fileId, sourceRevision: null, contentHash: fakeRevision(f.content), representation: 'text' as const, payload: f.content, fidelity: 'original' as const };
    }),
    capabilities: door('capabilities', null, () => capabilities),
    saveText: door('saveText', 3, (fileId: string, baseRevision: string, text: string, opId: string) => {
      const f = files.get(fileId)!;
      if (fakeRevision(f.content) !== baseRevision) return { status: 'conflict' as const, currentRevision: fakeRevision(f.content) };
      versions.set(fileId, [f.content, ...(versions.get(fileId) ?? [])]);
      f.content = text;
      emit(event(fileId, 'content', opId));
      return { status: 'saved' as const, revision: fakeRevision(text), sourceRevision: null };
    }),
    moveFile: door('moveFile', 3, (fileId: string, targetParentId: string | undefined, newName: string, opId: string) => {
      const f = files.get(fileId)!;
      const target = pathOf(targetParentId) ? `${pathOf(targetParentId)}/${newName}` : newName;
      if (byPath(f.workspaceId, target)) throw new Error('exists: something is already at that name');
      f.relativePath = target;
      emit(event(fileId, 'moved', opId));
      return record(fileId);
    }),
    copyFile: door('copyFile', 3, (fileId: string, targetParentId: string | undefined, newName: string) => {
      const f = files.get(fileId)!;
      return record(add(f.workspaceId, pathOf(targetParentId) ? `${pathOf(targetParentId)}/${newName}` : newName, f.content, 'workspace'));
    }),
    trashFile: door('trashFile', 1, (fileId: string, opId: string) => {
      const trashed = files.get(fileId)!;
      recovery.set(`trash_${fileId}`, { item: { receiptId: `trash_${fileId}`, kind: 'file', name: trashed.relativePath.split('/').pop()!, relativePath: trashed.relativePath, trashedAt: '2026-10-05T00:00:00Z', fileId }, fileIds: [fileId] });
      files.get(fileId)!.status = 'missing';
      emit(event(fileId, 'missing', opId));
      return { receiptId: `trash_${fileId}`, fileId, opId, location: 'project-recovery' as const, restorable: true };
    }),
    moveFolder: door('moveFolder', 4, (workspace_: string, entryId: string, targetParentId: string | undefined, newName: string, opId: string) => {
      const from = pathOf(entryId);
      const to = pathOf(targetParentId) ? `${pathOf(targetParentId)}/${newName}` : newName;
      if ([...files.values()].some((f) => f.workspaceId === workspace_ && (f.relativePath === to || under(f.relativePath, to)))) throw new Error('exists: something is already at that name');
      for (const f of files.values()) {
        if (f.workspaceId !== workspace_ || !under(f.relativePath, from) || f.status === 'missing') continue;
        f.relativePath = to + f.relativePath.slice(from.length);
        emit(event(f.fileId, 'moved', opId));
      }
      return entryIdOf(to);
    }),
    copyFolder: door('copyFolder', 4, (workspace_: string, entryId: string, targetParentId: string | undefined, newName: string) => {
      const from = pathOf(entryId);
      const to = pathOf(targetParentId) ? `${pathOf(targetParentId)}/${newName}` : newName;
      for (const f of [...files.values()]) if (f.workspaceId === workspace_ && under(f.relativePath, from) && f.status !== 'missing') add(workspace_, to + f.relativePath.slice(from.length), f.content, 'workspace');
      return entryIdOf(to);
    }),
    trashFolder: door('trashFolder', 2, (workspace_: string, entryId: string, opId: string) => {
      const folder = pathOf(entryId);
      const inside = [...files.values()].filter((f) => f.workspaceId === workspace_ && under(f.relativePath, folder) && f.status !== 'missing');
      const item: RecoveryItem = { receiptId: `trash_${folder}`, kind: 'folder', name: folder.split('/').pop()!, relativePath: folder, trashedAt: '2026-10-05T00:00:00Z' };
      recovery.set(item.receiptId, { item, fileIds: inside.map((f) => f.fileId) });
      for (const f of inside) { f.status = 'missing'; emit(event(f.fileId, 'missing', opId)); }
      return item;
    }),
    listRecovery: door('listRecovery', null, (workspace_: string) => [...recovery.values()].filter((r) => r.fileIds.every((id) => files.get(id)?.workspaceId === workspace_)).map((r) => r.item)),
    restore: door('restore', 2, (_workspace: string, receiptId: string, opId: string) => {
      const kept = recovery.get(receiptId);
      if (!kept) throw new Error('not-found: that is not in the recovery area');
      recovery.delete(receiptId);
      for (const id of kept.fileIds) { files.get(id)!.status = 'ready'; emit(event(id, 'restored', opId)); }
      return entryIdOf(kept.item.relativePath);
    }),
    listVersions: door('listVersions', null, (fileId: string): FileVersion[] => (versions.get(fileId) ?? []).map((content) => ({ fileId, revision: fakeRevision(content), keptAt: '2026-10-05T00:00:00Z', size: content.length }))),
    restoreVersion: door('restoreVersion', 3, (fileId: string, revision: string, baseRevision: string, opId: string) => {
      const f = files.get(fileId)!;
      if (fakeRevision(f.content) !== baseRevision) return { status: 'conflict' as const, currentRevision: fakeRevision(f.content) };
      const content = (versions.get(fileId) ?? []).find((c) => fakeRevision(c) === revision);
      if (content === undefined) return { status: 'error' as const, reason: 'that version is not kept in the recovery area' };
      versions.set(fileId, [f.content, ...(versions.get(fileId) ?? [])]);
      f.content = content;
      emit(event(fileId, 'content', opId));
      return { status: 'saved' as const, revision: fakeRevision(content), sourceRevision: null };
    }),
    putDraft: door('putDraft', null, (fileId: string, draft: { text: string; baseRevision: string }) => {
      if (!files.has(fileId)) throw new Error('unknown-file: that file is not known to an open workspace');
      const kept: DocumentDraft = { fileId, text: draft.text, baseRevision: draft.baseRevision, savedAt: '2026-10-05T00:00:00Z' };
      drafts.set(fileId, kept);
      return kept;
    }),
    getDraft: door('getDraft', null, (fileId: string) => drafts.get(fileId) ?? null),
    clearDraft: door('clearDraft', null, (fileId: string) => { drafts.delete(fileId); return true; }),
    reconcile: door('reconcile', null, (fileId: string) => record(fileId)),
    rescan: door('rescan', null, () => []),
    relink: door('relink', null, (fileId: string, entryId: string) => {
      const f = files.get(fileId)!;
      const candidate = byPath(f.workspaceId, pathOf(entryId));
      if (!candidate) throw new Error('not-found: nothing is at that path');
      f.relativePath = candidate.relativePath;
      f.content = candidate.content;
      f.status = 'ready';
      files.delete(candidate.fileId);
      return record(fileId);
    }),
    reveal: door('reveal', null, () => true),
    subscribe: door('subscribe', null, () => true),
    watching: door('watching', null, () => true),
    unsubscribe: door('unsubscribe', null, () => true),
    onEvent: (cb) => { listener = cb; },
  };

  const previous = window.desktopWorkspace;
  window.desktopWorkspace = bridge;

  return {
    workspace, capabilities, drafts, calls, files,
    seed: (relativePath, content, workspace_ = workspaceId) => { add(workspace_, relativePath, content, 'workspace'); return entryIdOf(relativePath); },
    entryId: entryIdOf,
    record,
    editExternally: (fileId, content) => { files.get(fileId)!.content = content; emit(event(fileId, 'content', null)); },
    emit,
    failNext: (method, code, message) => { failures.set(method, new Error(`Error invoking remote method 'workspace:${method}': Error: ${code}: ${message}`)); },
    calm: () => failures.clear(),
    holdNext: (method) => hold(method, 'before'),
    delayNext: (method) => hold(method, 'after'),
    uninstall: () => { window.desktopWorkspace = previous; },
  };
}

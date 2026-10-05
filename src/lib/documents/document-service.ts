// The one editing buffer of each open file. Every view of a file (a
// surface, a node's inline editor) shows this buffer and types into it;
// none of them holds a copy of the text. The buffer is what has not yet
// been written to the file; the file stays what the research is.
//
// What it promises:
//   - One document per file, however many views, however they were opened.
//   - Every edit names the buffer revision it was made on. An edit made on
//     an older revision is refused, never merged by guesswork.
//   - `clean` means the buffer is what the file holds, confirmed. Typing
//     that arrives while a save is under way is not covered by that save.
//   - A save never lands on top of a change made elsewhere. That is a
//     conflict, and the person settles it.
//   - What was typed is not lost: it is in the file, or in a draft, before
//     the document is let go.
//
// The text shown uses plain line feeds; what is written back keeps the
// file's own line endings (its byte-order mark is the shell's to keep).

import { newOperationId, readText, reconcileFile, saveText, WorkspaceError } from '../workspace/client';
import type { ContentHash, DocumentEdit, DocumentModel, SaveResult, TextRevision, WorkspaceEvent } from '../workspace/contracts';
import { workspaceDrafts, type DraftStore } from './draft-store';
import { applyChanges, changeBetween, History, validChanges, type Change } from './history';

/** How long after the last keystroke a document saves by itself. */
export const AUTOSAVE_MS = 1000;
/** How long after the last keystroke unsaved typing is put in a draft. */
export const DRAFT_MS = 250;
/** A save that keeps failing is tried again this many times before it waits for the person. */
const MAX_RETRIES = 3;

export interface DocumentChange {
  /** edit: someone typed. reload: the buffer was replaced by what the file holds. state: only the state changed. */
  kind: 'edit' | 'reload' | 'state';
  /** the view the change came from; null when it came from the file or from the service itself */
  originSurfaceId: string | null;
  /** what changed in the text, placed against the text before the change; absent when the text did not change */
  changes?: Change[];
}
export type DocumentListener = (model: DocumentModel, change: DocumentChange) => void;

export type DocumentProblem =
  /** the file was changed elsewhere while the buffer had unsaved typing; `theirs` is what the file holds now */
  | { kind: 'conflict'; theirsRevision: ContentHash | null; theirsText: string | null }
  /** a save did not go through; `retrying` says whether it will be tried again by itself */
  | { kind: 'error'; reason: string; retrying: boolean }
  /** the file is not where it was: nothing can be saved to it until it is found again */
  | { kind: 'lost' };

export interface DocumentStatus {
  problem: DocumentProblem | null;
  canUndo: boolean;
  canRedo: boolean;
  /** the buffer was filled from a recovery draft when the document was opened */
  restoredFromDraft: boolean;
  /** the file's name, for display */
  name: string;
  workspaceId: string;
  /** the views that are showing this document */
  views: string[];
}

export type EditResult =
  | { ok: true; bufferRevision: number }
  | { ok: false; reason: 'stale' | 'invalid' | 'readonly' | 'unknown-document'; bufferRevision: number };

export interface DocumentService {
  /** Open a file for a view. Resolves with its document: the one every view of that file shares. */
  open(fileId: string, surfaceId: string): Promise<DocumentModel>;
  /** The document as it is now, or undefined when it is not open. */
  get(documentId: string): DocumentModel | undefined;
  /** The open document of a file, if any. */
  documentOf(fileId: string): DocumentModel | undefined;
  status(documentId: string): DocumentStatus | undefined;
  applyEdit(documentId: string, edit: DocumentEdit): EditResult;
  /** Replace the whole text from a view that only knows the text it shows (a plain text box): the difference is the edit. */
  setText(documentId: string, text: string, surfaceId: string): EditResult;
  undo(documentId: string, surfaceId: string): boolean;
  redo(documentId: string, surfaceId: string): boolean;
  /** Write the buffer to the file now. Resolves with what the workspace answered; it does not reject. */
  save(documentId: string): Promise<SaveResult>;
  /** Settle a conflict: take the file's content, write mine over it, or put both in the buffer to sort out by hand. */
  resolveConflict(documentId: string, choice: 'mine' | 'theirs' | 'both', labels?: { mine: string; theirs: string }): Promise<void>;
  subscribe(documentId: string, listener: DocumentListener): () => void;
  /** A view stops showing its document. When it was the last one, unsaved typing is saved or kept as a draft before the document is let go. */
  closeView(surfaceId: string): Promise<void>;
  /** What the workspace reported about a file: the documents of that file catch up. */
  noteWorkspaceEvent(event: WorkspaceEvent): void;
  /** The workspaces the open documents are in: the page has to be listening to them. */
  workspaceIds(): string[];
  /** Put every open document's unsaved typing in a draft now. */
  keepDrafts(): Promise<void>;
  /** Let go of everything: timers stopped, unsaved typing kept as drafts. */
  dispose(): Promise<void>;
}

interface Open {
  model: DocumentModel;
  workspaceId: string;
  name: string;
  /** the file's content as the buffer shows it, as of the last read or confirmed save */
  saved: string;
  newline: TextRevision['newline'];
  history: History;
  views: Set<string>;
  listeners: Set<DocumentListener>;
  problem: DocumentProblem | null;
  restoredFromDraft: boolean;
  autosave: ReturnType<typeof setTimeout> | null;
  drafting: ReturnType<typeof setTimeout> | null;
  /** the save under way, if any */
  saving: Promise<SaveResult> | null;
  /** another save was asked for while one was under way */
  saveAgain: boolean;
  /** the attempt whose outcome is not known: asked again under the same id while the text is the same */
  attempt: { opId: string; bufferRevision: number } | null;
  /** operation ids of saves this document sent: news of them is not news */
  sent: Set<string>;
  failures: number;
  /** the draft on disk says this much; null when there is none */
  drafted: string | null;
  /** the buffer holds both sides of a conflict for the person to sort out: it is written only when they say so */
  byHand: boolean;
  closed: boolean;
}

const shown = (text: string): string => text.replace(/\r\n/g, '\n');
const toDisk = (doc: Open, text: string): string => (doc.newline === 'crlf' ? text.replace(/\n/g, '\r\n') : text);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface DocumentServiceOptions {
  drafts?: DraftStore;
  now?: () => number;
}

export function createDocumentService({ drafts = workspaceDrafts, now = () => Date.now() }: DocumentServiceOptions = {}): DocumentService {
  const byId = new Map<string, Open>();
  const byFile = new Map<string, Open>();
  const opening = new Map<string, Promise<Open>>();
  const viewOf = new Map<string, Open>(); // surfaceId → its document
  let serial = 0;

  const tell = (doc: Open, change: DocumentChange) => {
    for (const listener of [...doc.listeners]) { try { listener(doc.model, change); } catch { /* one view's failure stops no other */ } }
  };
  /** Change the document and tell its views. The model object is replaced, never edited in place: a view may hold on to the one it was given. */
  const update = (doc: Open, patch: Partial<DocumentModel>, change: DocumentChange) => {
    doc.model = { ...doc.model, ...patch };
    tell(doc, change);
  };
  const dirty = (doc: Open) => doc.model.text !== doc.saved;
  /** The state the document is in when nothing is wrong with it. */
  const restingState = (doc: Open): DocumentModel['state'] => (dirty(doc) ? 'dirty' : 'clean');
  const setState = (doc: Open, state: DocumentModel['state'], problem: DocumentProblem | null = null) => {
    doc.problem = problem;
    if (doc.model.state !== state) update(doc, { state }, { kind: 'state', originSurfaceId: null });
    else tell(doc, { kind: 'state', originSurfaceId: null });
  };

  // ── drafts ───────────────────────────────────────────────────────────

  async function keepDraft(doc: Open): Promise<void> {
    if (doc.drafting) { clearTimeout(doc.drafting); doc.drafting = null; }
    const text = doc.model.text;
    if (!dirty(doc)) return dropDraft(doc);
    if (doc.drafted === text) return;
    try { await drafts.put(doc.model.fileId, text, doc.model.sourceContentHash); doc.drafted = text; } catch { /* a draft that could not be kept is tried again with the next keystroke */ }
  }
  async function dropDraft(doc: Open): Promise<void> {
    if (doc.drafting) { clearTimeout(doc.drafting); doc.drafting = null; }
    if (doc.drafted === null) return;
    doc.drafted = null;
    try { await drafts.clear(doc.model.fileId); } catch { /* it is found stale and let go the next time the file is opened */ }
  }
  const scheduleDraft = (doc: Open) => {
    if (doc.drafting) clearTimeout(doc.drafting);
    doc.drafting = setTimeout(() => { doc.drafting = null; void keepDraft(doc); }, DRAFT_MS);
  };

  // ── saving ───────────────────────────────────────────────────────────

  const scheduleSave = (doc: Open, after = AUTOSAVE_MS) => {
    if (doc.autosave) clearTimeout(doc.autosave);
    doc.autosave = setTimeout(() => { doc.autosave = null; void save(doc); }, after);
  };
  const cancelSave = (doc: Open) => { if (doc.autosave) { clearTimeout(doc.autosave); doc.autosave = null; } };

  /** What the file holds now, read for the person who has to choose between it and the buffer. */
  async function conflictWith(doc: Open, theirsRevision: ContentHash | null): Promise<void> {
    cancelSave(doc);
    let theirsText: string | null = null;
    if (theirsRevision !== null) {
      try { const read = await readText(doc.model.fileId); theirsText = shown(read.text); theirsRevision = read.revision; } catch { /* shown without the other side's text */ }
    }
    if (doc.closed) return;
    // the file may hold exactly what the buffer does: then there is nothing to choose between
    if (theirsText !== null && theirsText === doc.model.text) {
      doc.saved = theirsText;
      update(doc, { sourceContentHash: theirsRevision! }, { kind: 'state', originSurfaceId: null });
      setState(doc, 'clean');
      void dropDraft(doc);
      return;
    }
    setState(doc, 'conflict', { kind: 'conflict', theirsRevision, theirsText });
    void keepDraft(doc);
  }

  async function writeOnce(doc: Open, against: ContentHash): Promise<SaveResult> {
    const bufferRevision = doc.model.bufferRevision;
    const text = doc.model.text;
    // an attempt whose outcome is unknown is asked again under its own id, so it is done once
    if (!doc.attempt || doc.attempt.bufferRevision !== bufferRevision) doc.attempt = { opId: newOperationId(), bufferRevision };
    const { opId } = doc.attempt;
    doc.sent.add(opId);
    if (doc.sent.size > 64) doc.sent.delete(doc.sent.values().next().value as string);
    update(doc, { state: 'saving' }, { kind: 'state', originSurfaceId: null });
    let result: SaveResult;
    try { result = await saveText(doc.model.fileId, against, toDisk(doc, text), opId); } catch (e) {
      result = { status: 'error', reason: e instanceof WorkspaceError ? e.message : why(e) };
    }
    if (doc.closed && result.status !== 'saved') return result;

    if (result.status === 'saved') {
      doc.attempt = null;
      doc.failures = 0;
      doc.saved = text;
      doc.problem = null;
      // typing that arrived while this save was under way is not covered by it
      update(doc, { sourceContentHash: result.revision, sourceRevision: result.sourceRevision, state: restingState(doc) }, { kind: 'state', originSurfaceId: null });
      if (dirty(doc)) { if (!doc.closed) scheduleSave(doc); } else void dropDraft(doc);
    } else if (result.status === 'conflict') {
      doc.attempt = null;
      if (result.currentRevision === null) {
        // nothing is there to be in conflict with: the file is not where it was
        setState(doc, 'error', { kind: 'lost' });
        void keepDraft(doc);
      } else await conflictWith(doc, result.currentRevision);
    } else if (result.status === 'readonly') {
      doc.attempt = null;
      setState(doc, 'readonly');
      void keepDraft(doc);
    } else if (result.status === 'error') {
      doc.failures++;
      const retrying = doc.failures <= MAX_RETRIES;
      setState(doc, 'error', { kind: 'error', reason: result.reason, retrying });
      void keepDraft(doc);
      // a few more tries, each after a longer wait; then it is the person's to ask again
      if (retrying) scheduleSave(doc, AUTOSAVE_MS * 2 ** doc.failures);
    } else {
      // pending-sync, unknown-ack: the source's own word for where the write stands
      setState(doc, result.status);
      void keepDraft(doc);
    }
    return result;
  }

  function save(doc: Open, against?: ContentHash): Promise<SaveResult> {
    cancelSave(doc);
    if (doc.saving) {
      // one save of a file at a time: this one follows the one under way
      doc.saveAgain = true;
      return doc.saving.then(() => (doc.saving ?? Promise.resolve<SaveResult>({ status: 'saved', revision: doc.model.sourceContentHash, sourceRevision: doc.model.sourceRevision })));
    }
    if (doc.model.state === 'readonly') return Promise.resolve({ status: 'readonly', reason: 'the file cannot be written' });
    if (doc.problem?.kind === 'lost') return Promise.resolve({ status: 'conflict', currentRevision: null });
    if (doc.problem?.kind === 'conflict' && against === undefined) return Promise.resolve({ status: 'conflict', currentRevision: doc.problem.theirsRevision });
    if (!dirty(doc) && against === undefined) return Promise.resolve({ status: 'saved', revision: doc.model.sourceContentHash, sourceRevision: doc.model.sourceRevision });

    const run = writeOnce(doc, against ?? doc.model.sourceContentHash).finally(() => {
      if (doc.saving === run) doc.saving = null;
      if (doc.saveAgain) {
        doc.saveAgain = false;
        if (!doc.closed && dirty(doc) && doc.problem === null) doc.saving = startFollowing(doc);
      }
    });
    doc.saving = run;
    return run;
  }
  const startFollowing = (doc: Open): Promise<SaveResult> => {
    const run = writeOnce(doc, doc.model.sourceContentHash).finally(() => { if (doc.saving === run) doc.saving = null; });
    return run;
  };

  // ── edits ────────────────────────────────────────────────────────────

  /** Put new text in the buffer: a new buffer revision, told to every view. */
  function replaceText(doc: Open, changes: Change[], origin: string | null, kind: DocumentChange['kind']): void {
    const { text } = applyChanges(doc.model.text, changes);
    doc.model = { ...doc.model, text, bufferRevision: doc.model.bufferRevision + 1 };
    // a problem with saving stays until it is settled; otherwise the state follows the text
    const held = doc.model.state === 'readonly' || doc.problem?.kind === 'conflict' || doc.problem?.kind === 'lost';
    if (!held) { doc.problem = null; doc.failures = 0; doc.model = { ...doc.model, state: doc.saving ? 'saving' : restingState(doc) }; }
    tell(doc, { kind, originSurfaceId: origin, changes });
    if (dirty(doc)) {
      scheduleDraft(doc);
      if (!held && !doc.byHand) scheduleSave(doc); else cancelSave(doc);
    } else {
      cancelSave(doc);
      void dropDraft(doc);
    }
  }

  function applyEdit(documentId: string, edit: DocumentEdit): EditResult {
    const doc = byId.get(documentId);
    if (!doc) return { ok: false, reason: 'unknown-document', bufferRevision: -1 };
    const bufferRevision = doc.model.bufferRevision;
    if (doc.model.state === 'readonly') return { ok: false, reason: 'readonly', bufferRevision };
    if (edit.baseBufferRevision !== bufferRevision) return { ok: false, reason: 'stale', bufferRevision };
    if (!validChanges(doc.model.text, edit.changes)) return { ok: false, reason: 'invalid', bufferRevision };
    const { inverse } = applyChanges(doc.model.text, edit.changes);
    doc.history.push(edit.changes.map((c) => ({ ...c })), inverse, edit.originSurfaceId, now());
    replaceText(doc, edit.changes, edit.originSurfaceId, 'edit');
    return { ok: true, bufferRevision: doc.model.bufferRevision };
  }

  function step(documentId: string, surfaceId: string, direction: 'undo' | 'redo'): boolean {
    const doc = byId.get(documentId);
    if (!doc || doc.model.state === 'readonly') return false;
    const changes = direction === 'undo' ? doc.history.undo() : doc.history.redo();
    if (!changes) return false;
    replaceText(doc, changes, surfaceId, 'edit');
    return true;
  }

  // ── opening and closing ──────────────────────────────────────────────

  async function load(fileId: string): Promise<Open> {
    const [read, record, draft] = await Promise.all([readText(fileId), reconcileFile(fileId), drafts.get(fileId).catch(() => null)]);
    const text = shown(read.text);
    const doc: Open = {
      model: { documentId: `doc_${++serial}_${newOperationId().slice(3, 11)}`, fileId, text, sourceContentHash: read.revision, sourceRevision: null, bufferRevision: 0, state: record.status === 'readonly' ? 'readonly' : 'clean' },
      workspaceId: record.workspaceId,
      name: (record.relativePath ?? '').split('/').pop() || fileId,
      saved: text,
      newline: read.newline,
      history: new History(),
      views: new Set(),
      listeners: new Set(),
      problem: null,
      restoredFromDraft: false,
      autosave: null, drafting: null, saving: null, saveAgain: false, attempt: null, sent: new Set(), failures: 0,
      drafted: draft ? draft.text : null,
      byHand: false,
      closed: false,
    };
    if (draft && doc.model.state !== 'readonly') {
      if (draft.text === text) {
        // it says nothing the file does not
        void dropDraft(doc);
      } else {
        // what was typed and not saved comes back as unsaved typing: one step that can be taken back to what the file holds
        const changes = changeBetween(text, draft.text);
        const { inverse } = applyChanges(text, changes);
        doc.history.push(changes, inverse, null, now());
        doc.model = { ...doc.model, text: draft.text, bufferRevision: 1, state: 'dirty' };
        doc.restoredFromDraft = true;
        if (draft.baseRevision === read.revision) scheduleSave(doc);
        // typed over content the file no longer holds: the person chooses, nothing is written over the change
        else { doc.problem = { kind: 'conflict', theirsRevision: read.revision, theirsText: text }; doc.model = { ...doc.model, state: 'conflict' }; }
      }
    }
    return doc;
  }

  async function open(fileId: string, surfaceId: string): Promise<DocumentModel> {
    let doc = byFile.get(fileId);
    if (!doc) {
      // everyone who opens the file while it is being read waits for the one reading
      let pending = opening.get(fileId);
      if (!pending) {
        pending = load(fileId).then((loaded) => {
          byFile.set(fileId, loaded);
          byId.set(loaded.model.documentId, loaded);
          return loaded;
        }).finally(() => opening.delete(fileId));
        opening.set(fileId, pending);
      }
      doc = await pending;
    }
    const before = viewOf.get(surfaceId);
    if (before && before !== doc) await closeView(surfaceId);
    doc.views.add(surfaceId);
    viewOf.set(surfaceId, doc);
    return doc.model;
  }

  /** Let a document go: its unsaved typing is in the file or in a draft first. */
  async function release(doc: Open): Promise<void> {
    cancelSave(doc);
    if (doc.saving) await doc.saving.catch(() => undefined);
    const settled = doc.model.state !== 'readonly' && doc.problem === null && !doc.byHand;
    if (dirty(doc) && settled) await save(doc);
    if (doc.saving) await doc.saving.catch(() => undefined);
    if (doc.views.size > 0) return; // a view opened it again while it was being saved
    await keepDraft(doc);
    doc.closed = true;
    cancelSave(doc);
    if (doc.drafting) { clearTimeout(doc.drafting); doc.drafting = null; }
    doc.listeners.clear();
    if (byFile.get(doc.model.fileId) === doc) byFile.delete(doc.model.fileId);
    byId.delete(doc.model.documentId);
  }

  async function closeView(surfaceId: string): Promise<void> {
    const doc = viewOf.get(surfaceId);
    if (!doc) return;
    viewOf.delete(surfaceId);
    doc.views.delete(surfaceId);
    if (doc.views.size === 0) await release(doc);
  }

  // ── the file changing underneath ─────────────────────────────────────

  async function reload(doc: Open): Promise<void> {
    let read: TextRevision;
    try { read = await readText(doc.model.fileId); } catch { return; }
    if (doc.closed) return;
    const text = shown(read.text);
    doc.newline = read.newline;
    if (dirty(doc)) {
      // unsaved typing and a change from elsewhere: a conflict, unless the file now holds what was already saved
      if (read.revision !== doc.model.sourceContentHash) await conflictWith(doc, read.revision);
      return;
    }
    if (text === doc.model.text) {
      doc.saved = text;
      if (doc.model.sourceContentHash !== read.revision) update(doc, { sourceContentHash: read.revision }, { kind: 'state', originSurfaceId: null });
      return;
    }
    const changes = changeBetween(doc.model.text, text);
    doc.saved = text;
    // what the file holds now is not something to undo back out of: the history starts again from here
    doc.history = new History();
    doc.model = { ...doc.model, text, sourceContentHash: read.revision, bufferRevision: doc.model.bufferRevision + 1, state: 'clean' };
    doc.problem = null;
    tell(doc, { kind: 'reload', originSurfaceId: null, changes });
  }

  function noteWorkspaceEvent(event: WorkspaceEvent): void {
    const doc = byFile.get(event.fileId);
    if (!doc) return;
    doc.name = (event.record.relativePath ?? '').split('/').pop() || doc.name;
    if (event.change === 'missing' || event.change === 'ambiguous') {
      cancelSave(doc);
      setState(doc, 'error', { kind: 'lost' });
      void keepDraft(doc);
      return;
    }
    if (event.change === 'restored' || (doc.problem?.kind === 'lost' && event.record.status !== 'missing' && event.record.status !== 'ambiguous')) {
      doc.problem = null;
      setState(doc, restingState(doc));
      void reload(doc).then(() => { if (!doc.closed && dirty(doc) && doc.problem === null) scheduleSave(doc); });
      return;
    }
    if (event.change !== 'content') return;
    // news of this document's own save is not news
    if (event.opId !== null && doc.sent.has(event.opId)) return;
    if (event.observedRevision === doc.model.sourceContentHash) return;
    if (doc.saving) { void doc.saving.then(() => { if (!doc.closed && event.observedRevision !== doc.model.sourceContentHash) void reload(doc); }); return; }
    void reload(doc);
  }

  // ── conflicts ────────────────────────────────────────────────────────

  async function resolveConflict(documentId: string, choice: 'mine' | 'theirs' | 'both', labels = { mine: 'mine', theirs: 'theirs' }): Promise<void> {
    const doc = byId.get(documentId);
    if (!doc || doc.problem?.kind !== 'conflict') return;
    const { theirsRevision, theirsText } = doc.problem;
    if (choice === 'mine') {
      if (theirsRevision === null) return; // nothing is there to write over
      doc.problem = null;
      // written over the content the person was shown: if the file changed again since, that is a new conflict
      await save(doc, theirsRevision);
      return;
    }
    if (theirsText === null || theirsRevision === null) return;
    const mine = doc.model.text;
    const next = choice === 'theirs'
      ? theirsText
      : `<<<<<<< ${labels.mine}\n${mine}${mine.endsWith('\n') ? '' : '\n'}=======\n${theirsText}${theirsText.endsWith('\n') ? '' : '\n'}>>>>>>> ${labels.theirs}\n`;
    const changes = changeBetween(mine, next);
    const { inverse } = applyChanges(mine, changes);
    // either way the buffer now stands on what the file holds; mine is one undo away
    doc.saved = theirsText;
    doc.problem = null;
    doc.history.push(changes, inverse, null, now());
    doc.model = { ...doc.model, sourceContentHash: theirsRevision, state: 'dirty' };
    replaceText(doc, changes, null, 'edit');
    // both versions in the buffer are for the person to sort out: nothing is written until they say so
    if (choice === 'both') { doc.byHand = true; cancelSave(doc); }
  }

  return {
    open,
    get: (documentId) => byId.get(documentId)?.model,
    documentOf: (fileId) => byFile.get(fileId)?.model,
    status(documentId) {
      const doc = byId.get(documentId);
      return doc ? { problem: doc.problem, canUndo: doc.history.canUndo, canRedo: doc.history.canRedo, restoredFromDraft: doc.restoredFromDraft, name: doc.name, workspaceId: doc.workspaceId, views: [...doc.views] } : undefined;
    },
    applyEdit,
    setText(documentId, text, surfaceId) {
      const doc = byId.get(documentId);
      if (!doc) return { ok: false, reason: 'unknown-document', bufferRevision: -1 };
      const changes = changeBetween(doc.model.text, shown(text));
      if (changes.length === 0) return { ok: true, bufferRevision: doc.model.bufferRevision };
      return applyEdit(documentId, { baseBufferRevision: doc.model.bufferRevision, changes, originSurfaceId: surfaceId });
    },
    undo: (documentId, surfaceId) => step(documentId, surfaceId, 'undo'),
    redo: (documentId, surfaceId) => step(documentId, surfaceId, 'redo'),
    save(documentId) {
      const doc = byId.get(documentId);
      if (!doc) return Promise.resolve({ status: 'error', reason: 'that document is not open' });
      doc.byHand = false; // the person says so
      return save(doc);
    },
    resolveConflict,
    subscribe(documentId, listener) {
      const doc = byId.get(documentId);
      if (!doc) return () => {};
      doc.listeners.add(listener);
      return () => { doc.listeners.delete(listener); };
    },
    closeView,
    noteWorkspaceEvent,
    workspaceIds: () => [...new Set([...byId.values()].map((doc) => doc.workspaceId))].sort(),
    async keepDrafts() { await Promise.all([...byId.values()].map((doc) => keepDraft(doc))); },
    async dispose() {
      for (const doc of [...byId.values()]) {
        cancelSave(doc);
        await keepDraft(doc);
        doc.closed = true;
        doc.listeners.clear();
      }
      byId.clear(); byFile.clear(); viewOf.clear();
    },
  };
}

/** The documents of the running app. */
export const documents = createDocumentService();

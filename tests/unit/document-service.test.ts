import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_MS, DRAFT_MS, createDocumentService, type DocumentChange, type DocumentService } from '../../src/lib/documents/document-service';
import type { DocumentModel } from '../../src/lib/workspace/contracts';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// The one editing buffer of a file, against a stand-in for the shell's
// workspace door: what several views of it see, what a save promises, what
// happens when the file changes underneath, and what is never lost.

let shell: FakeWorkspace;
let documents: DocumentService;
let fileId: string;
const onDisk = () => shell.files.get(fileId)!.content;
const saves = () => shell.calls.filter((c) => c.method === 'saveText');
const insert = (at: number, text: string) => [{ from: at, to: at, insert: text }];
/** Type at the end of the document from a view, on the buffer revision that view last saw. */
const typeAtEnd = (doc: DocumentModel, text: string, surface = 'view-1') => {
  const now = documents.get(doc.documentId)!;
  return documents.applyEdit(doc.documentId, { baseBufferRevision: now.bufferRevision, changes: insert(now.text.length, text), originSurfaceId: surface });
};
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  shell = installFakeWorkspace();
  shell.seed('notes/a.md', 'FIRST_LINE_K4\n');
  fileId = [...shell.files.keys()][0];
  documents = createDocumentService();
});
afterEach(async () => {
  await documents.dispose();
  shell.uninstall();
  vi.useRealTimers();
});

describe('one file, several views', () => {
  it('is one document: opened twice, even at the same moment, it is read once and both views get the same buffer', async () => {
    const [one, two] = await Promise.all([documents.open(fileId, 'view-1'), documents.open(fileId, 'view-2')]);
    expect(one.documentId).toBe(two.documentId);
    expect(shell.calls.filter((c) => c.method === 'readText').length).toBe(1);
    expect(one).toMatchObject({ fileId, text: 'FIRST_LINE_K4\n', sourceContentHash: fakeRevision('FIRST_LINE_K4\n'), bufferRevision: 0, state: 'clean' });
    expect((await documents.open(fileId, 'view-3')).documentId).toBe(one.documentId);
  });

  it('shows every view the same text after each of them has typed, and tells each who typed', async () => {
    const doc = await documents.open(fileId, 'view-1');
    await documents.open(fileId, 'view-2');
    const heard: [string, string | null, number][] = [];
    documents.subscribe(doc.documentId, (model, change) => heard.push([change.kind, change.originSurfaceId, model.bufferRevision]));

    expect(typeAtEnd(doc, 'from one\n', 'view-1')).toMatchObject({ ok: true, bufferRevision: 1 });
    expect(typeAtEnd(doc, 'from two\n', 'view-2')).toMatchObject({ ok: true, bufferRevision: 2 });
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\nfrom one\nfrom two\n', bufferRevision: 2, state: 'dirty' });
    expect(heard).toEqual([['edit', 'view-1', 1], ['edit', 'view-2', 2]]);
  });

  it('tells a view exactly what changed, so it can apply the other view\'s typing to what it shows', async () => {
    const doc = await documents.open(fileId, 'view-1');
    const changes: DocumentChange[] = [];
    documents.subscribe(doc.documentId, (_model, change) => changes.push(change));
    documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: [{ from: 0, to: 5, insert: 'SECOND' }], originSurfaceId: 'view-1' });
    expect(changes[0]).toMatchObject({ kind: 'edit', changes: [{ from: 0, to: 5, insert: 'SECOND' }] });
    expect(documents.get(doc.documentId)!.text).toBe('SECOND_LINE_K4\n');
  });

  it('refuses an edit made on a buffer revision that is no longer the current one, and changes nothing', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'newer\n');
    const stale = documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: insert(0, 'OLD '), originSurfaceId: 'view-2' });
    expect(stale).toEqual({ ok: false, reason: 'stale', bufferRevision: 1 });
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nnewer\n');
  });

  it('refuses changes that do not fit the text: out of range, overlapping, out of order', async () => {
    const doc = await documents.open(fileId, 'view-1');
    for (const changes of [
      [{ from: 0, to: 99, insert: '' }],
      [{ from: -1, to: 0, insert: 'x' }],
      [{ from: 4, to: 2, insert: 'x' }],
      [{ from: 0, to: 4, insert: 'a' }, { from: 2, to: 6, insert: 'b' }],
      [{ from: 6, to: 8, insert: 'a' }, { from: 0, to: 2, insert: 'b' }],
    ]) expect(documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes, originSurfaceId: 'view-1' }), JSON.stringify(changes)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\n', bufferRevision: 0, state: 'clean' });
  });

  it('applies several changes of one edit against the text as it was before any of them', async () => {
    const doc = await documents.open(fileId, 'view-1');
    documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: [{ from: 0, to: 5, insert: 'A' }, { from: 6, to: 10, insert: 'BB' }, { from: 14, to: 14, insert: 'end' }], originSurfaceId: 'view-1' });
    expect(documents.get(doc.documentId)!.text).toBe('A_BB_K4\nend');
  });
});

describe('saving', () => {
  it('writes the buffer against the revision it was read at, and the document is clean only then', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'second\n');
    const result = await documents.save(doc.documentId);
    expect(result.status).toBe('saved');
    expect(onDisk()).toBe('FIRST_LINE_K4\nsecond\n');
    expect(saves().map((c) => c.args[1])).toEqual([fakeRevision('FIRST_LINE_K4\n')]);
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'clean', sourceContentHash: fakeRevision('FIRST_LINE_K4\nsecond\n') });
  });

  it('does not call the document clean for typing that arrived while a save was under way', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'one\n');
    typeAtEnd(doc, 'two\n');
    typeAtEnd(doc, 'three\n'); // buffer revision 3
    const slow = shell.holdNext('saveText');
    const saving = documents.save(doc.documentId);
    await settle();
    expect(documents.get(doc.documentId)!.state).toBe('saving');
    typeAtEnd(doc, 'four\n'); // buffer revision 4 arrives while 3 is being written
    slow.release();
    await saving;
    expect(onDisk()).toBe('FIRST_LINE_K4\none\ntwo\nthree\n');
    expect(documents.get(doc.documentId)).toMatchObject({ bufferRevision: 4, state: 'dirty', sourceContentHash: fakeRevision('FIRST_LINE_K4\none\ntwo\nthree\n') });
    // and the next save writes revision 4 over what the last one left
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(onDisk()).toBe('FIRST_LINE_K4\none\ntwo\nthree\nfour\n');
    expect(saves().map((c) => c.args[1])).toEqual([fakeRevision('FIRST_LINE_K4\n'), fakeRevision('FIRST_LINE_K4\none\ntwo\nthree\n')]);
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });

  it('saves by itself exactly 1000 ms after the last keystroke, and not before', async () => {
    expect(AUTOSAVE_MS).toBe(1000);
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'a');
    await vi.advanceTimersByTimeAsync(600);
    typeAtEnd(doc, 'b'); // typing again starts the wait again
    await vi.advanceTimersByTimeAsync(999);
    expect(saves().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves().length).toBe(1);
    expect(onDisk()).toBe('FIRST_LINE_K4\nab');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves().length, 'nothing more to save, nothing more is saved').toBe(1);
  });

  it('does not run two saves of one file at once: a save asked for during another follows it', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'one\n');
    const slow = shell.holdNext('saveText');
    const first = documents.save(doc.documentId);
    await settle();
    typeAtEnd(doc, 'two\n');
    const second = documents.save(doc.documentId);
    await settle();
    expect(saves().length).toBe(1);
    slow.release();
    await Promise.all([first, second]);
    expect(saves().length).toBe(2);
    expect(onDisk()).toBe('FIRST_LINE_K4\none\ntwo\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });

  it('keeps the text when a save fails, says so, tries again a few times, and then stops until something changes', async () => {
    const doc = await documents.open(fileId, 'view-1');
    const working = window.desktopWorkspace!.saveText;
    let tries = 0;
    window.desktopWorkspace!.saveText = async () => { tries++; throw new Error("Error invoking remote method 'workspace:save-text': Error: failed: the workspace call failed"); };
    typeAtEnd(doc, 'kept\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(tries).toBe(1);
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'error', text: 'FIRST_LINE_K4\nkept\n' });
    expect(documents.status(doc.documentId)!.problem).toMatchObject({ kind: 'error', retrying: true });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(tries, 'a few more tries, not an endless stream of them').toBe(4);
    expect(documents.status(doc.documentId)!.problem).toMatchObject({ kind: 'error', retrying: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tries, 'it has stopped trying by itself').toBe(4);
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nkept\n');
    expect(shell.drafts.get(fileId)?.text, 'what was typed is in a draft meanwhile').toBe('FIRST_LINE_K4\nkept\n');

    // the cause is gone and the person asks again: it saves
    window.desktopWorkspace!.saveText = working;
    expect((await documents.save(doc.documentId)).status).toBe('saved');
    expect(onDisk()).toBe('FIRST_LINE_K4\nkept\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });

  it('starts trying again by itself when more is typed after it had given up', async () => {
    const doc = await documents.open(fileId, 'view-1');
    const working = window.desktopWorkspace!.saveText;
    window.desktopWorkspace!.saveText = async () => { throw new Error('failed: the workspace call failed'); };
    typeAtEnd(doc, 'one\n');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(documents.status(doc.documentId)!.problem).toMatchObject({ kind: 'error', retrying: false });
    window.desktopWorkspace!.saveText = working;
    typeAtEnd(doc, 'two\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(onDisk()).toBe('FIRST_LINE_K4\none\ntwo\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });

  it('asks again under the same operation id when it does not know whether the last attempt landed', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'once\n');
    shell.failNext('saveText', 'failed', 'the workspace call failed');
    await documents.save(doc.documentId);
    await documents.save(doc.documentId);
    const ids = saves().map((c) => c.args[3]);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    typeAtEnd(doc, 'twice\n');
    await documents.save(doc.documentId);
    expect(saves()[2].args[3]).not.toBe(ids[0]);
  });

  it('writes a file with Windows line endings back with its own, and shows it with plain ones', async () => {
    shell.files.get(fileId)!.content = 'one\r\ntwo\r\n';
    const doc = await documents.open(fileId, 'view-1');
    expect(doc.text).toBe('one\ntwo\n');
    typeAtEnd(doc, 'three\n');
    await documents.save(doc.documentId);
    expect(onDisk()).toBe('one\r\ntwo\r\nthree\r\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });
});

describe('when the file changes underneath', () => {
  const externalEdit = (content: string) => {
    shell.files.get(fileId)!.content = content;
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision(content), opId: null, record: shell.record(fileId) });
  };

  it('a document with nothing unsaved takes the new content, and its views are told', async () => {
    const doc = await documents.open(fileId, 'view-1');
    const kinds: string[] = [];
    documents.subscribe(doc.documentId, (_model, change) => kinds.push(change.kind));
    externalEdit('CHANGED_ELSEWHERE_M2\n');
    await settle();
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'CHANGED_ELSEWHERE_M2\n', state: 'clean', sourceContentHash: fakeRevision('CHANGED_ELSEWHERE_M2\n') });
    expect(kinds).toContain('reload');
  });

  it('a document with unsaved typing is in conflict at once: nothing is saved over the change, and both versions are at hand', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'MINE_Z5\n');
    externalEdit('CHANGED_ELSEWHERE_M2\n');
    await settle();
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'conflict', text: 'FIRST_LINE_K4\nMINE_Z5\n' });
    expect(documents.status(doc.documentId)!.problem).toEqual({ kind: 'conflict', theirsRevision: fakeRevision('CHANGED_ELSEWHERE_M2\n'), theirsText: 'CHANGED_ELSEWHERE_M2\n' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    expect((await documents.save(doc.documentId)).status).toBe('conflict');
    expect(saves().length, 'no save is attempted while the conflict stands').toBe(0);
    expect(onDisk()).toBe('CHANGED_ELSEWHERE_M2\n');
  });

  it('a save that finds the file changed is a conflict, found by the save itself', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'MINE_Z5\n');
    shell.files.get(fileId)!.content = 'CHANGED_ELSEWHERE_M2\n'; // no event came
    expect((await documents.save(doc.documentId)).status).toBe('conflict');
    await settle();
    expect(documents.get(doc.documentId)!.state).toBe('conflict');
    expect(documents.status(doc.documentId)!.problem).toMatchObject({ kind: 'conflict', theirsText: 'CHANGED_ELSEWHERE_M2\n' });
    expect(onDisk()).toBe('CHANGED_ELSEWHERE_M2\n');
  });

  it('is settled by the person: take theirs, keep mine over theirs, or keep both in the buffer', async () => {
    const start = async () => {
      const doc = await documents.open(fileId, 'view-1');
      typeAtEnd(doc, 'MINE_Z5\n');
      externalEdit('CHANGED_ELSEWHERE_M2\n');
      await settle();
      return doc;
    };
    let doc = await start();
    await documents.resolveConflict(doc.documentId, 'theirs');
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'CHANGED_ELSEWHERE_M2\n', state: 'clean' });
    // taking theirs can itself be taken back: mine is one undo away
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\nMINE_Z5\n', state: 'dirty' });
    await documents.closeView('view-1');
    shell.drafts.clear();

    shell.files.get(fileId)!.content = 'FIRST_LINE_K4\n';
    doc = await start();
    await documents.resolveConflict(doc.documentId, 'mine');
    expect(onDisk()).toBe('FIRST_LINE_K4\nMINE_Z5\n');
    expect(saves().at(-1)!.args[1], 'mine is written over the content the person was shown, not over whatever is there by then').toBe(fakeRevision('CHANGED_ELSEWHERE_M2\n'));
    expect(documents.get(doc.documentId)!.state).toBe('clean');
    await documents.closeView('view-1');

    shell.files.get(fileId)!.content = 'FIRST_LINE_K4\n';
    doc = await start();
    await documents.resolveConflict(doc.documentId, 'both', { mine: 'mine', theirs: 'on disk' });
    const merged = documents.get(doc.documentId)!;
    expect(merged.text).toBe('<<<<<<< mine\nFIRST_LINE_K4\nMINE_Z5\n=======\nCHANGED_ELSEWHERE_M2\n>>>>>>> on disk\n');
    expect(merged.state).toBe('dirty');
    // sorting the two out by hand takes more than a second: nothing is written until the person saves
    documents.applyEdit(doc.documentId, { baseBufferRevision: merged.bufferRevision, changes: [{ from: 0, to: 13, insert: '' }], originSurfaceId: 'view-1' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    expect(onDisk(), 'keeping both writes nothing by itself').toBe('CHANGED_ELSEWHERE_M2\n');
    expect(shell.drafts.get(fileId)?.text.startsWith('FIRST_LINE_K4\nMINE_Z5\n=======')).toBe(true);
    expect((await documents.save(doc.documentId)).status).toBe('saved');
    expect(onDisk().startsWith('FIRST_LINE_K4\nMINE_Z5\n=======')).toBe(true);
  });

  it('is not confused by the news of its own save', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'second\n');
    const slow = shell.holdNext('saveText');
    const saving = documents.save(doc.documentId);
    await settle();
    typeAtEnd(doc, 'third\n');
    slow.release();
    await saving;
    // the workspace announces the save that just landed, while newer typing is unsaved
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision('FIRST_LINE_K4\nsecond\n'), opId: String(saves()[0].args[3]), record: shell.record(fileId) });
    await settle();
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'dirty', text: 'FIRST_LINE_K4\nsecond\nthird\n' });
  });

  it('a save that finds the file gone says the file is lost, and keeps the buffer', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'unsaved\n');
    const working = window.desktopWorkspace!.saveText;
    window.desktopWorkspace!.saveText = async () => ({ status: 'conflict', currentRevision: null });
    await documents.save(doc.documentId);
    window.desktopWorkspace!.saveText = working;
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'error', text: 'FIRST_LINE_K4\nunsaved\n' });
    expect(documents.status(doc.documentId)!.problem).toEqual({ kind: 'lost' });
    await vi.advanceTimersByTimeAsync(DRAFT_MS);
    expect(shell.drafts.get(fileId)?.text).toBe('FIRST_LINE_K4\nunsaved\n');
  });

  it('a file that goes missing keeps its buffer and says the file is lost; when it is back, work goes on', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'unsaved\n');
    shell.files.get(fileId)!.status = 'missing';
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'missing', observedRevision: null, opId: null, record: shell.record(fileId) });
    await settle();
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'error', text: 'FIRST_LINE_K4\nunsaved\n' });
    expect(documents.status(doc.documentId)!.problem).toEqual({ kind: 'lost' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(saves().length).toBe(0);

    shell.files.get(fileId)!.status = 'ready';
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'restored', observedRevision: fakeRevision('FIRST_LINE_K4\n'), opId: null, record: shell.record(fileId) });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(onDisk()).toBe('FIRST_LINE_K4\nunsaved\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });
});

describe('a file that cannot be written', () => {
  it('opens read-only: it can be read, nothing can be typed into it, and nothing is saved', async () => {
    shell.files.get(fileId)!.status = 'readonly';
    const doc = await documents.open(fileId, 'view-1');
    expect(doc.state).toBe('readonly');
    expect(documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: insert(0, 'x'), originSurfaceId: 'view-1' })).toMatchObject({ ok: false, reason: 'readonly' });
    expect((await documents.save(doc.documentId)).status).toBe('readonly');
    expect(saves().length).toBe(0);
  });

  it('turns read-only when a save is refused for that reason, and keeps what was typed', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'typed\n');
    const refuse = window.desktopWorkspace!.saveText;
    window.desktopWorkspace!.saveText = async () => ({ status: 'readonly', reason: 'the file cannot be written' });
    expect((await documents.save(doc.documentId)).status).toBe('readonly');
    window.desktopWorkspace!.saveText = refuse;
    expect(documents.get(doc.documentId)).toMatchObject({ state: 'readonly', text: 'FIRST_LINE_K4\ntyped\n' });
    await vi.advanceTimersByTimeAsync(DRAFT_MS);
    expect(shell.drafts.get(fileId)?.text).toBe('FIRST_LINE_K4\ntyped\n');
  });
});

describe('undo and redo belong to the document', () => {
  it('take back and put back what was typed, for every view, whoever typed it', async () => {
    const doc = await documents.open(fileId, 'view-1');
    await documents.open(fileId, 'view-2');
    typeAtEnd(doc, 'one\n', 'view-1');
    await vi.advanceTimersByTimeAsync(2000);
    typeAtEnd(doc, 'two\n', 'view-2');
    expect(documents.status(doc.documentId)).toMatchObject({ canUndo: true, canRedo: false });

    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\none\n');
    documents.undo(doc.documentId, 'view-2');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\n');
    expect(documents.status(doc.documentId)).toMatchObject({ canUndo: false, canRedo: true });
    documents.redo(doc.documentId, 'view-1');
    documents.redo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\none\ntwo\n');
  });

  it('never go backwards in buffer revision: an undo is a new state of the buffer', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'one\n');
    documents.undo(doc.documentId, 'view-1');
    documents.redo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.bufferRevision).toBe(3);
  });

  it('forget what could be redone once something new is typed', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'one\n');
    documents.undo(doc.documentId, 'view-1');
    typeAtEnd(doc, 'other\n');
    expect(documents.status(doc.documentId)!.canRedo).toBe(false);
    expect(documents.redo(doc.documentId, 'view-1')).toBe(false);
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nother\n');
  });

  it('take back a run of typing as one step, and typing after a pause as another', async () => {
    const doc = await documents.open(fileId, 'view-1');
    for (const letter of 'abc') typeAtEnd(doc, letter);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    for (const letter of 'de') typeAtEnd(doc, letter);
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nabc');
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\n');
  });

  it('know when undoing has brought the buffer back to what is saved', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'one\n');
    expect(documents.get(doc.documentId)!.state).toBe('dirty');
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(saves().length, 'there is nothing to save').toBe(0);
  });
});

describe('what was typed and not saved', () => {
  it('is kept as a draft shortly after it is typed, and the draft is let go once the text is in the file', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'typed\n');
    await vi.advanceTimersByTimeAsync(DRAFT_MS);
    expect(shell.drafts.get(fileId)).toMatchObject({ text: 'FIRST_LINE_K4\ntyped\n', baseRevision: fakeRevision('FIRST_LINE_K4\n') });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(onDisk()).toBe('FIRST_LINE_K4\ntyped\n');
    await settle();
    expect(shell.drafts.has(fileId)).toBe(false);
  });

  it('comes back when the file is opened again after a crash, as unsaved typing over the same content', async () => {
    shell.drafts.set(fileId, { fileId, text: 'FIRST_LINE_K4\nRECOVERED_V6\n', baseRevision: fakeRevision('FIRST_LINE_K4\n'), savedAt: '2026-10-05T00:00:00Z' });
    const doc = await documents.open(fileId, 'view-1');
    expect(doc).toMatchObject({ text: 'FIRST_LINE_K4\nRECOVERED_V6\n', state: 'dirty', sourceContentHash: fakeRevision('FIRST_LINE_K4\n') });
    expect(documents.status(doc.documentId)!.restoredFromDraft).toBe(true);
    // what was recovered can be taken back to what the file holds
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\n', state: 'clean' });
  });

  it('is a conflict, not a silent overwrite, when the file changed since the draft was typed', async () => {
    shell.drafts.set(fileId, { fileId, text: 'FIRST_LINE_K4\nRECOVERED_V6\n', baseRevision: fakeRevision('FIRST_LINE_K4\n'), savedAt: '2026-10-05T00:00:00Z' });
    shell.files.get(fileId)!.content = 'CHANGED_WHILE_CLOSED_T9\n';
    const doc = await documents.open(fileId, 'view-1');
    expect(doc).toMatchObject({ text: 'FIRST_LINE_K4\nRECOVERED_V6\n', state: 'conflict' });
    expect(documents.status(doc.documentId)!.problem).toMatchObject({ kind: 'conflict', theirsText: 'CHANGED_WHILE_CLOSED_T9\n' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(onDisk()).toBe('CHANGED_WHILE_CLOSED_T9\n');
  });

  it('is not kept when it says nothing the file does not: a draft equal to the file is let go', async () => {
    shell.drafts.set(fileId, { fileId, text: 'FIRST_LINE_K4\n', baseRevision: fakeRevision('older'), savedAt: '2026-10-05T00:00:00Z' });
    const doc = await documents.open(fileId, 'view-1');
    expect(doc.state).toBe('clean');
    await settle();
    expect(shell.drafts.has(fileId)).toBe(false);
  });

  it('is saved when the last view of the document is closed', async () => {
    const doc = await documents.open(fileId, 'view-1');
    await documents.open(fileId, 'view-2');
    typeAtEnd(doc, 'typed\n');
    await documents.closeView('view-1');
    expect(saves().length, 'another view is still open: nothing is forced').toBe(0);
    expect(documents.get(doc.documentId)).toBeDefined();
    await documents.closeView('view-2');
    expect(onDisk()).toBe('FIRST_LINE_K4\ntyped\n');
    expect(documents.get(doc.documentId)).toBeUndefined();
  });

  it('is kept as a draft when the last view is closed and it cannot be saved, and is there when the file is opened again', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'MINE_Z5\n');
    shell.files.get(fileId)!.content = 'CHANGED_ELSEWHERE_M2\n';
    await documents.closeView('view-1');
    expect(onDisk()).toBe('CHANGED_ELSEWHERE_M2\n');
    expect(shell.drafts.get(fileId)).toMatchObject({ text: 'FIRST_LINE_K4\nMINE_Z5\n', baseRevision: fakeRevision('FIRST_LINE_K4\n') });
    expect(documents.get(doc.documentId)).toBeUndefined();

    const again = await documents.open(fileId, 'view-1');
    expect(again).toMatchObject({ text: 'FIRST_LINE_K4\nMINE_Z5\n', state: 'conflict' });
    expect(again.documentId).not.toBe(doc.documentId);
  });

  it('is put in a draft at once when asked, for every open document', async () => {
    const doc = await documents.open(fileId, 'view-1');
    typeAtEnd(doc, 'typed\n');
    await documents.keepDrafts();
    expect(shell.drafts.get(fileId)?.text).toBe('FIRST_LINE_K4\ntyped\n');
  });
});

describe('who the service listens to', () => {
  it('names the workspaces of the documents that are open, so the page hears about their files', async () => {
    expect(documents.workspaceIds()).toEqual([]);
    await documents.open(fileId, 'view-1');
    expect(documents.workspaceIds()).toEqual(['ws_1']);
    await documents.closeView('view-1');
    expect(documents.workspaceIds()).toEqual([]);
  });

  it('stops telling a listener that left', async () => {
    const doc = await documents.open(fileId, 'view-1');
    const heard: number[] = [];
    const stop = documents.subscribe(doc.documentId, (model) => heard.push(model.bufferRevision));
    typeAtEnd(doc, 'a');
    stop();
    typeAtEnd(doc, 'b');
    expect(heard).toEqual([1]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openEdit, saveEdit, toDisk } from '../../src/lib/workspace/quick-edit';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// Typing into a workspace file from its node, against a stand-in for the
// shell's workspace door: what is saved, against which revision, and what
// happens when the file was changed elsewhere in the meantime.

let shell: FakeWorkspace;
let fileId: string;
const onDisk = () => shell.files.get(fileId)!.content;

beforeEach(() => {
  shell = installFakeWorkspace();
  shell.seed('notes/a.md', 'FIRST_LINE_K4\nsecond\n');
  fileId = [...shell.files.keys()][0];
});
afterEach(() => shell.uninstall());

describe('typing into a file from its node', () => {
  it('reads the text with the revision it was read at', async () => {
    const session = await openEdit(fileId);
    expect(session).toMatchObject({ fileId, loaded: 'FIRST_LINE_K4\nsecond\n', base: fakeRevision('FIRST_LINE_K4\nsecond\n'), newline: 'lf' });
  });

  it('saves against that revision and moves on to the one the save left', async () => {
    const session = await openEdit(fileId);
    const { session: next, result } = await saveEdit(session, 'FIRST_LINE_K4\nsecond\nTHIRD_Q8\n');
    expect(result).toMatchObject({ status: 'saved', revision: fakeRevision('FIRST_LINE_K4\nsecond\nTHIRD_Q8\n') });
    expect(onDisk()).toBe('FIRST_LINE_K4\nsecond\nTHIRD_Q8\n');
    expect(next).toMatchObject({ base: fakeRevision('FIRST_LINE_K4\nsecond\nTHIRD_Q8\n'), loaded: 'FIRST_LINE_K4\nsecond\nTHIRD_Q8\n' });
    const saves = shell.calls.filter((c) => c.method === 'saveText');
    expect(saves.map((c) => c.args[1])).toEqual([session.base]);
  });

  it('does not write over a change made elsewhere: the answer is a conflict and the session stays where it was', async () => {
    const session = await openEdit(fileId);
    shell.editExternally(fileId, 'CHANGED_ELSEWHERE_M2\n');
    const { session: after, result } = await saveEdit(session, 'MINE_Z5\n');
    expect(result).toEqual({ status: 'conflict', currentRevision: fakeRevision('CHANGED_ELSEWHERE_M2\n') });
    expect(onDisk()).toBe('CHANGED_ELSEWHERE_M2\n');
    expect(after).toEqual(session);
  });

  it('writes over that change only when told to, against the revision the change left', async () => {
    const session = await openEdit(fileId);
    shell.editExternally(fileId, 'CHANGED_ELSEWHERE_M2\n');
    const first = await saveEdit(session, 'MINE_Z5\n');
    if (first.result.status !== 'conflict' || !first.result.currentRevision) throw new Error('expected a conflict that names the current revision');
    const second = await saveEdit(first.session, 'MINE_Z5\n', first.result.currentRevision);
    expect(second.result.status).toBe('saved');
    expect(onDisk()).toBe('MINE_Z5\n');
  });

  it('uses an operation id of its own for every save', async () => {
    const session = await openEdit(fileId);
    const one = await saveEdit(session, 'one\n');
    await saveEdit(one.session, 'two\n');
    const ids = shell.calls.filter((c) => c.method === 'saveText').map((c) => c.args[3]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('a file with Windows line endings', () => {
  it('is shown with plain line feeds and written back with its own', async () => {
    shell.files.get(fileId)!.content = 'one\r\ntwo\r\n';
    const session = await openEdit(fileId);
    expect(session).toMatchObject({ loaded: 'one\ntwo\n', newline: 'crlf' });
    await saveEdit(session, 'one\ntwo\nthree\n');
    expect(onDisk()).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('is unchanged on disk when nothing was typed', async () => {
    shell.files.get(fileId)!.content = 'one\r\ntwo\r\n';
    const session = await openEdit(fileId);
    expect(toDisk(session, session.loaded)).toBe('one\r\ntwo\r\n');
  });

  it('leaves a file with plain line feeds exactly as typed', () => {
    expect(toDisk({ newline: 'lf' }, 'a\nb\n')).toBe('a\nb\n');
    expect(toDisk({ newline: 'mixed' }, 'a\nb\n')).toBe('a\nb\n');
  });
});

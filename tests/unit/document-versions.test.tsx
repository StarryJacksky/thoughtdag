import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import DocumentBody from '../../src/components/surfaces/DocumentBody';
import { ConflictCompare } from '../../src/components/surfaces/VersionsPanel';
import { documents } from '../../src/lib/documents/document-service';
import { compareLines } from '../../src/lib/documents/line-diff';
import { useUiStore } from '../../src/lib/ui-store';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, withoutLayout, type Mounted } from '../helpers/render';

// What a file held before each save, in the document's own surface: listed,
// looked at, and put back. And the two sides of a conflict, line by line.
// (T10b: the workspace could list and restore versions since M1; nothing
// on screen used it.)

let shell: FakeWorkspace;
let view: Mounted | null = null;
let fileId = '';
let documentId = '';
const onDisk = () => shell.files.get(fileId)!.content;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const until = async (ready: () => unknown) => { for (let i = 0; i < 200 && !ready(); i++) await during(tick); };
const q = <T extends Element = HTMLElement>(selector: string) => view!.container.querySelector<T>(selector);
const all = (selector: string) => [...view!.container.querySelectorAll<HTMLElement>(selector)];
const text = () => documents.get(documentId)!.text;
/** Replace the document's text and save it, as typing and the save key would. */
async function saveAs(content: string) {
  await during(async () => {
    documents.setText(documentId, content, 'view-1');
    await documents.save(documentId);
  });
}
const openHistory = async () => {
  await during(() => q('[data-versions-toggle]')!.click());
  await until(() => q('[data-versions]') && !q('[data-versions-loading]'));
};

beforeAll(() => withoutLayout());
beforeEach(async () => {
  shell = installFakeWorkspace();
  shell.seed('notes/a.md', 'VERSION_ONE_H1\n');
  fileId = [...shell.files.keys()][0];
  useUiStore.setState({ toasts: [] });
  documentId = (await documents.open(fileId, 'view-1')).documentId;
  view = await mount(<div style={{ height: 500, display: 'flex', flexDirection: 'column' }}><DocumentBody documentId={documentId} surfaceId="view-1" kind="text" /></div>);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  await documents.dispose();
  shell.uninstall();
});

describe('what a file held before each save', () => {
  const savedThreeTimes = async () => {
    await saveAs('VERSION_TWO_H2\n');
    await saveAs('VERSION_THREE_H3\n');
    await saveAs('VERSION_FOUR_H4\n');
  };

  it('is listed in the document\'s surface: one entry for each save that replaced something, newest first', async () => {
    await savedThreeTimes();
    expect(q('[data-versions]'), 'not shown until asked for').toBeNull();
    await openHistory();
    expect(all('[data-version]').map((row) => row.dataset.version)).toEqual([fakeRevision('VERSION_THREE_H3\n'), fakeRevision('VERSION_TWO_H2\n'), fakeRevision('VERSION_ONE_H1\n')]);
    // each says how large it was, and none of them is the text itself
    for (const row of all('[data-version]')) expect(row.textContent).toMatch(/\d/);
    expect(q('[data-versions]')!.textContent).not.toContain('VERSION_TWO_H2');
  });

  it('can be looked at without being put back', async () => {
    await savedThreeTimes();
    await openHistory();
    await during(() => q(`[data-version="${fakeRevision('VERSION_TWO_H2\n')}"] [data-version-preview]`)!.click());
    await until(() => q('[data-version-text]'));
    expect(q('[data-version-text]')!.textContent).toBe('VERSION_TWO_H2\n');
    expect(onDisk()).toBe('VERSION_FOUR_H4\n');
    expect(text()).toBe('VERSION_FOUR_H4\n');
  });

  it('can be put back: the file and the document hold it, and what it replaced is kept as a version in turn', async () => {
    await savedThreeTimes();
    await openHistory();
    await during(() => q(`[data-version="${fakeRevision('VERSION_ONE_H1\n')}"] [data-version-restore]`)!.click());
    await until(() => text() === 'VERSION_ONE_H1\n');
    expect(onDisk()).toBe('VERSION_ONE_H1\n');
    expect(documents.get(documentId)).toMatchObject({ text: 'VERSION_ONE_H1\n', state: 'clean', sourceContentHash: fakeRevision('VERSION_ONE_H1\n') });
    await until(() => all('[data-version]').length === 4);
    expect(all('[data-version]')[0].dataset.version, 'what was replaced can be put back in turn').toBe(fakeRevision('VERSION_FOUR_H4\n'));
  });

  it('is not put back over a change another program made since: the file keeps that change, and the person is told', async () => {
    await savedThreeTimes();
    await openHistory();
    shell.files.get(fileId)!.content = 'CHANGED_ELSEWHERE_M2\n'; // no news of it has come yet
    await during(() => q(`[data-version="${fakeRevision('VERSION_ONE_H1\n')}"] [data-version-restore]`)!.click());
    await until(() => useUiStore.getState().toasts.length > 0);
    expect(onDisk()).toBe('CHANGED_ELSEWHERE_M2\n');
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error']);
    await until(() => text() === 'CHANGED_ELSEWHERE_M2\n');
    expect(text(), 'the document shows what the file holds now').toBe('CHANGED_ELSEWHERE_M2\n');
  });

  it('is not put back while there is unsaved typing: that would be lost', async () => {
    await savedThreeTimes();
    await during(() => { documents.setText(documentId, 'VERSION_FOUR_H4\nNOT_SAVED_YET\n', 'view-1'); });
    await openHistory();
    const restore = q<HTMLButtonElement>(`[data-version="${fakeRevision('VERSION_ONE_H1\n')}"] [data-version-restore]`)!;
    expect(restore.disabled).toBe(true);
    expect((await documents.restoreVersion(documentId, fakeRevision('VERSION_ONE_H1\n'))).status).toBe('error');
    expect(text()).toBe('VERSION_FOUR_H4\nNOT_SAVED_YET\n');
    expect(onDisk()).toBe('VERSION_FOUR_H4\n');
  });

  it('can be looked at and not put back in a file that cannot be written', async () => {
    await savedThreeTimes();
    await view!.unmount();
    await documents.dispose();
    shell.files.get(fileId)!.status = 'readonly';
    documentId = (await documents.open(fileId, 'view-1')).documentId;
    view = await mount(<div style={{ height: 500, display: 'flex', flexDirection: 'column' }}><DocumentBody documentId={documentId} surfaceId="view-1" kind="text" /></div>);
    await openHistory();
    expect(all('[data-version]').length).toBe(3);
    expect(all('[data-version-preview]').length).toBe(3);
    expect(all('[data-version-restore]')).toEqual([]);
    expect((await documents.restoreVersion(documentId, fakeRevision('VERSION_ONE_H1\n'))).status).toBe('readonly');
    expect(onDisk()).toBe('VERSION_FOUR_H4\n');
  });

  it('says so when there is none yet', async () => {
    await openHistory();
    expect(all('[data-version]')).toEqual([]);
    expect(q('[data-versions-empty]')).not.toBeNull();
  });
});

describe('the two sides of a conflict, line by line', () => {
  it('marks the lines that differ and no others', () => {
    const rows = compareLines('title\nMINE changed this\nsame middle\nsame end\n', 'title\nbase line two\nsame middle\nTHEIRS changed this\n');
    expect(rows.map((r) => [r.mine, r.theirs, r.changed])).toEqual([
      ['title', 'title', false],
      ['MINE changed this', 'base line two', true],
      ['same middle', 'same middle', false],
      ['same end', 'THEIRS changed this', true],
    ]);
  });

  it('shows a line only one side has beside nothing, and keeps the lines after it in step', () => {
    const rows = compareLines('a\nb\nc\n', 'a\nINSERTED\nb\nc\n');
    expect(rows.map((r) => [r.mine, r.theirs, r.changed])).toEqual([['a', 'a', false], [null, 'INSERTED', true], ['b', 'b', false], ['c', 'c', false]]);
    expect(compareLines('a\nGONE\nb\n', 'a\nb\n').map((r) => [r.mine, r.theirs, r.changed])).toEqual([['a', 'a', false], ['GONE', null, true], ['b', 'b', false]]);
    expect(compareLines('same\n', 'same\n').every((r) => !r.changed)).toBe(true);
    expect(compareLines('', 'only theirs\n').map((r) => [r.mine, r.theirs])).toEqual([[null, 'only theirs']]);
  });

  it('is drawn side by side with the differing lines marked', async () => {
    await view!.unmount();
    view = await mount(<ConflictCompare mine={'title\nMINE changed this\nsame end\n'} theirs={'title\nbase line two\nTHEIRS added\nsame end\n'} />);
    const rows = all('[data-compare-row]');
    expect(rows.map((row) => row.dataset.compareRow)).toEqual(['same', 'changed', 'changed', 'same']);
    expect(rows[1].querySelector('[data-compare-mine]')!.textContent).toBe('MINE changed this');
    expect(rows[1].querySelector('[data-compare-theirs]')!.textContent).toBe('base line two');
    expect(rows[2].querySelector('[data-compare-mine]')!.textContent).toBe('');
    expect(rows[2].querySelector('[data-compare-theirs]')!.textContent).toBe('THEIRS added');
  });

  it('is offered in the document when its typing is in conflict with the file, and the three ways to settle it stay', async () => {
    await during(() => { documents.setText(documentId, 'VERSION_ONE_H1\nMINE_Z5\n', 'view-1'); });
    await during(() => { shell.files.get(fileId)!.content = 'VERSION_ONE_H1\nTHEIRS_M2\n'; });
    await during(() => documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision('VERSION_ONE_H1\nTHEIRS_M2\n'), opId: null, record: shell.record(fileId) }));
    await until(() => q('[data-surface-conflict]'));
    expect(q('[data-compare-row]'), 'not drawn until asked for').toBeNull();
    await during(() => q('[data-conflict-compare]')!.click());
    expect(all('[data-compare-row]').map((row) => row.dataset.compareRow)).toEqual(['same', 'changed']);
    expect(q('[data-compare-row="changed"] [data-compare-mine]')!.textContent).toBe('MINE_Z5');
    expect(q('[data-compare-row="changed"] [data-compare-theirs]')!.textContent).toBe('THEIRS_M2');
    for (const way of ['[data-conflict-reload]', '[data-conflict-overwrite]', '[data-conflict-both]']) expect(q(way)).not.toBeNull();
  });
});

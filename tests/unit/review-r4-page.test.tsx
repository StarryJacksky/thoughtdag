import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import LargeTextView from '../../src/components/surfaces/LargeTextView';
import { noteFileEvent } from '../../src/lib/workspace/file-news';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// What the review of the large-text view found (its R4 number is kept in the
// test names; the report itself was never written to disk, so the case is
// built from the line later reports carry of it): the view noticed a change
// to the file only when it read its next part, so once it had read to the end
// it showed the old text for good. On a stand-in for the desktop shell.

let shell: FakeWorkspace;
let view: Mounted | null = null;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const shown = () => [...view!.container.querySelectorAll('[data-large-part]')].map((part) => part.textContent).join('');
const settle = async (until: () => boolean) => { for (let i = 0; i < 100 && !until(); i++) await during(tick); };
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const changed = (fileId: string, content: string, change: 'content' | 'restored' = 'content') => {
  shell.files.get(fileId)!.content = content;
  noteFileEvent({ workspaceId: 'ws_1', fileId, change, observedRevision: fakeRevision(content), opId: null, record: shell.record(fileId) });
};

beforeEach(() => { shell = installFakeWorkspace(); });
afterEach(async () => {
  await view?.unmount();
  view = null;
  shell.uninstall();
});

describe('[R4-16] a large text whose file changes', () => {
  it('[R4-16] read to its end, it is read again from the start when the file changes, with no scrolling or asking', async () => {
    shell.seed('data/huge.txt', 'FIRST_VERSION\n');
    const fileId = fileIdOf('data/huge.txt');
    view = await mount(<LargeTextView fileId={fileId} name="huge.txt" />);
    await settle(() => shown() === 'FIRST_VERSION\n');
    expect(shown()).toBe('FIRST_VERSION\n');
    expect(view.container.querySelector('[data-large-more]'), 'it is at its end: nothing more would be read').toBeNull();
    await during(async () => { changed(fileId, 'SECOND_VERSION\n'); await tick(); });
    await settle(() => shown() === 'SECOND_VERSION\n');
    expect(shown()).toBe('SECOND_VERSION\n');
  });

  it('[R4-16] part way through, what is shown is let go at once, and it starts again', async () => {
    shell.seed('data/huge.txt', `${'row\n'.repeat(200000)}`);
    const fileId = fileIdOf('data/huge.txt');
    view = await mount(<LargeTextView fileId={fileId} name="huge.txt" />);
    await settle(() => shown().length > 0);
    expect(view.container.querySelector('[data-large-more]')).not.toBeNull();
    await during(async () => { changed(fileId, 'SHORT_NOW\n'); await tick(); });
    await settle(() => shown() === 'SHORT_NOW\n');
    expect(shown()).toBe('SHORT_NOW\n');
    expect(view.container.querySelector('[data-large-more]')).toBeNull();
  });

  it('[R4-16] a change that lands while a part is being read is not lost: the view ends up on what the file holds now', async () => {
    shell.seed('data/huge.txt', 'FIRST_VERSION\n');
    const fileId = fileIdOf('data/huge.txt');
    const held = shell.delayNext('readTextRange');
    view = await mount(<LargeTextView fileId={fileId} name="huge.txt" />);
    await during(tick);
    await during(async () => { changed(fileId, 'SECOND_VERSION\n'); await tick(); });
    await during(async () => { held.release(); await tick(); });
    await settle(() => shown() === 'SECOND_VERSION\n');
    expect(shown()).toBe('SECOND_VERSION\n');
  });

  it('[R4-16] news of a move changes nothing it shows, and of another file neither', async () => {
    shell.seed('data/huge.txt', 'FIRST_VERSION\n');
    shell.seed('data/other.txt', 'OTHER\n');
    const fileId = fileIdOf('data/huge.txt');
    view = await mount(<LargeTextView fileId={fileId} name="huge.txt" />);
    await settle(() => shown() === 'FIRST_VERSION\n');
    const reads = () => shell.calls.filter((c) => c.method === 'readTextRange').length;
    const before = reads();
    await during(async () => {
      noteFileEvent({ workspaceId: 'ws_1', fileId, change: 'moved', observedRevision: fakeRevision('FIRST_VERSION\n'), opId: null, record: shell.record(fileId) });
      changed(fileIdOf('data/other.txt'), 'OTHER_2\n');
      await tick();
    });
    expect(reads()).toBe(before);
    expect(shown()).toBe('FIRST_VERSION\n');
  });
});

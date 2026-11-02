import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SourceMenu from '../../src/components/focus-panel/SourceMenu';
import { listSourceRoots, pickSources } from '../../src/lib/workspace/source-picker';
import { useStore } from '../../src/store';
import { useProjects } from '../../src/store/projects';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// The sources an attachment can come from (T37). A file from this computer is as it
// always was. A ChatGPT Space is listed, and says why it cannot be used: there is no
// interface to reach one with yet (space-capability-report.md). Nothing here sends or
// reads a thing.

let shell: FakeWorkspace;
let mounted: Mounted | null = null;
beforeEach(() => {
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'c', name: 'c', createdAt: 0, updatedAt: 0 }], activeId: 'c', switching: false });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  shell.uninstall();
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('[T37] the sources', () => {
  it('[T37] a file from this computer, ready; a Space, blocked, saying why', async () => {
    const roots = await listSourceRoots('c');
    expect(roots.map((r) => r.kind)).toEqual(['local-file', 'space']);
    expect(roots[0]).toMatchObject({ status: 'ready', blockedReason: null });
    expect(roots[1]).toMatchObject({ status: 'blocked' });
    expect(roots[1].blockedReason).toBeTruthy();
  });

  it('[T37] a file of an open folder picked is a reference to it: nothing is copied, sent or read', async () => {
    const entryId = shell.seed('notes/a.md', 'WHAT_THE_FILE_HOLDS\n');
    const [ref] = await pickSources([{ workspaceId: 'ws_1', entryId }]);
    expect(ref.fileId).toBeTruthy();
    expect(ref.selector).toEqual({ kind: 'document' });
    expect(ref.version).toEqual({ kind: 'live' });
    expect(ref.payload).toBe('text');
    expect(JSON.stringify(ref)).not.toContain('WHAT_THE_FILE_HOLDS');
  });

  it('[T37] with a part of it selected, the reference says so', async () => {
    const entryId = shell.seed('notes/a.md', 'text\n');
    const selector = { kind: 'text' as const, quote: 'text', prefix: '', suffix: '' };
    const [ref] = await pickSources([{ workspaceId: 'ws_1', entryId, selector } as never]);
    expect(ref.selector).toEqual(selector);
  });
});

describe('[T37] the menu', () => {
  async function menu(onLocal = vi.fn(), onClose = vi.fn()) {
    mounted = await mount(<SourceMenu projectId="c" onLocal={onLocal} onClose={onClose} />);
    await vi.waitFor(() => expect(mounted!.container.querySelectorAll('[data-source]')).toHaveLength(2));
    return { root: mounted.container, onLocal, onClose };
  }
  const local = (root: HTMLElement) => root.querySelector('[data-source="local-file"]') as HTMLButtonElement;
  const space = (root: HTMLElement) => root.querySelector('[data-source="space"]') as HTMLButtonElement;

  it('[T37] choosing a file from this computer goes the way it always went', async () => {
    const { root, onLocal, onClose } = await menu();
    await during(() => local(root).click());
    expect(onLocal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('[T37] a Space is shown with its reason, and choosing it does nothing', async () => {
    const { root, onLocal, onClose } = await menu();
    expect(space(root).disabled).toBe(true);
    expect(root.querySelector('[data-source-blocked]')?.textContent).toBeTruthy();
    await during(() => space(root).click());
    expect(onLocal).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('[T37] opening the menu changes nothing on the canvas', async () => {
    const before = useStore.getState().nodes;
    await menu();
    expect(useStore.getState().nodes).toBe(before);
  });
});

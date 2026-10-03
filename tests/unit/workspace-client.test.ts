import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceError, chooseRoot, listChildren, listWorkspaces, registerEntry, workspaceAvailable } from '../../src/lib/workspace/client';
import type { FileEntry, ResourceRecord, WorkspaceRecord } from '../../src/lib/workspace/contracts';

// The renderer's side of the workspace door, against a stand-in for the
// shell: what it passes on, what it refuses to pass on, and how a refusal
// from the shell reaches the caller.

const workspace: WorkspaceRecord = { workspaceId: 'ws_1', displayName: 'research-project', readOnly: false, kind: 'local', rootGrantId: 'grant_1' };
const entry: FileEntry = { entryId: 'e_cmVhZG1lLm1k', parentId: null, name: 'readme.md', kind: 'file' };
const resource: ResourceRecord = {
  fileId: 'file_1', workspaceId: 'ws_1', relativePath: 'readme.md', locator: { kind: 'local', rootGrantId: 'grant_1', relativePath: 'readme.md' },
  sourceRevision: null, mediaType: 'text/markdown', origin: 'workspace', status: 'ready', revision: null,
};

function shell(overrides: Partial<Record<keyof DesktopWorkspaceBridge, unknown>> = {}) {
  const answer = (value: unknown) => async () => value;
  window.desktopWorkspace = {
    chooseRoot: answer(workspace),
    listWorkspaces: answer([workspace]),
    close: answer(true),
    listChildren: answer([entry]),
    registerEntry: answer(resource),
    ...overrides,
  } as DesktopWorkspaceBridge;
}
/** A refusal as it arrives through Electron's IPC. */
const refusal = (channel: string, text: string) => async () => { throw new Error(`Error invoking remote method '${channel}': Error: ${text}`); };

afterEach(() => { delete window.desktopWorkspace; });

describe('without the desktop shell', () => {
  it('says project folders are unavailable instead of failing obscurely', async () => {
    expect(workspaceAvailable()).toBe(false);
    await expect(chooseRoot()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('answers from the shell', () => {
  it('are passed on when they fit the contract', async () => {
    shell();
    expect(workspaceAvailable()).toBe(true);
    expect(await chooseRoot()).toEqual(workspace);
    expect(await listWorkspaces()).toEqual([workspace]);
    expect(await listChildren('ws_1')).toEqual([entry]);
    expect(await registerEntry('ws_1', entry.entryId)).toEqual(resource);
  });

  it('a cancelled picker is null, not an error', async () => {
    shell({ chooseRoot: async () => null });
    expect(await chooseRoot()).toBeNull();
  });

  it('are refused when they do not fit the contract', async () => {
    shell({
      chooseRoot: async () => ({ ...workspace, rootPath: '/synthetic/project' }),
      listChildren: async () => [{ ...entry, kind: 'socket' }],
      registerEntry: async () => ({ ...resource, revision: 'not-a-hash' }),
      listWorkspaces: async () => ({ workspaces: [workspace] }),
    });
    await expect(chooseRoot()).rejects.toMatchObject({ code: 'contract' });
    await expect(listChildren('ws_1')).rejects.toMatchObject({ code: 'contract' });
    await expect(registerEntry('ws_1', entry.entryId)).rejects.toMatchObject({ code: 'contract' });
    await expect(listWorkspaces()).rejects.toMatchObject({ code: 'contract' });
  });
});

describe('refusals from the shell', () => {
  it('arrive with their code and their words', async () => {
    shell({ listChildren: refusal('workspace:list-children', 'escapes-root: the path leads outside the workspace') });
    const error = await listChildren('ws_1', 'e_b3V0LWxpbms').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({ code: 'escapes-root', message: 'the path leads outside the workspace' });
  });

  it('from a caller the shell does not trust are reported as refused', async () => {
    shell({ registerEntry: refusal('workspace:register-entry', 'refused: the call came from a frame inside the page') });
    await expect(registerEntry('ws_1', entry.entryId)).rejects.toMatchObject({ code: 'refused' });
  });

  it('with no recognizable reason are reported as failed, without the raw text', async () => {
    shell({ listWorkspaces: async () => { throw new Error('ENOENT: no such file or directory, open \'/synthetic/state/workspace-grants.json\''); } });
    const error = await listWorkspaces().catch((e: unknown) => e) as WorkspaceError;
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('/synthetic');
  });
});

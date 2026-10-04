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

// ── file operations and change events ──────────────────────────────────

import { createFile, importText, newOperationId, readText, rescanWorkspace, saveText, trashFile } from '../../src/lib/workspace/client';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import type { WorkspaceEvent } from '../../src/lib/workspace/contracts';

const HASH = 'sha256:' + 'a'.repeat(64);

describe('file operations through the door', () => {
  it('pass a valid request on and check what comes back', async () => {
    const seen: unknown[] = [];
    shell({
      createFile: async (r: unknown) => { seen.push(r); return resource; },
      readText: async () => ({ text: 'x', revision: HASH, encoding: 'utf-8', newline: 'lf' }),
      saveText: async () => ({ status: 'conflict', currentRevision: HASH }),
      trashFile: async () => ({ receiptId: 'trash_1', fileId: 'file_1', opId: 'op-1', location: 'system-trash', restorable: true }),
      rescan: async () => [resource],
    });
    const request = { workspaceId: 'ws_1', extension: 'md', origin: 'graph' as const, idempotencyKey: newOperationId() };
    expect(await createFile(request)).toEqual(resource);
    expect(seen).toEqual([request]);
    expect((await readText('file_1')).revision).toBe(HASH);
    // a conflict is an answer, not an exception
    expect(await saveText('file_1', HASH, 'y', 'op-1')).toEqual({ status: 'conflict', currentRevision: HASH });
    expect((await trashFile('file_1', 'op-1')).location).toBe('system-trash');
    expect(await rescanWorkspace('ws_1')).toEqual([resource]);
  });

  it('refuse to send a request that is not one, before the shell sees it', async () => {
    let asked = 0;
    shell({ createFile: async () => { asked++; return resource; }, importText: async () => { asked++; return resource; } });
    const bad = { workspaceId: 'ws_1', extension: '../sh', origin: 'graph', idempotencyKey: 'op-1' } as const;
    await expect(createFile(bad)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(importText({ ...bad, extension: 'md', path: '/synthetic' } as never, { text: 'x', provenance: { source: 'chatgpt-space' } })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(asked).toBe(0);
  });

  it('refuse a save result that claims saved with nothing to show for it', async () => {
    shell({ saveText: async () => ({ status: 'saved' }) });
    await expect(saveText('file_1', HASH, 'y', 'op-1')).rejects.toMatchObject({ code: 'contract' });
  });

  it('give every operation an id of its own', () => {
    expect(newOperationId()).toMatch(/^op_[0-9a-f-]{36}$/);
    expect(newOperationId()).not.toBe(newOperationId());
  });
});

describe('change events', () => {
  // the module listens to the shell once per page: every test here shares that one line in
  let push: (e: unknown) => void = () => {};
  const event = (workspaceId: string, change: WorkspaceEvent['change'] = 'content'): WorkspaceEvent => ({ workspaceId, fileId: 'file_1', change, observedRevision: HASH, opId: null, record: { ...resource, workspaceId, revision: HASH } });

  it('reach the listeners of their workspace only, and the shell is asked to watch once per workspace', async () => {
    const calls: string[] = [];
    shell({
      onEvent: (cb: (e: unknown) => void) => { push = cb; },
      subscribe: async (id: string) => { calls.push(`subscribe ${id}`); return true; },
      unsubscribe: async (id: string) => { calls.push(`unsubscribe ${id}`); return true; },
    });
    const heardA: WorkspaceEvent[] = [];
    const alsoA: WorkspaceEvent[] = [];
    const heardB: WorkspaceEvent[] = [];
    const stopA = await subscribeWorkspace('ws_a', (e) => heardA.push(e));
    const stopAlsoA = await subscribeWorkspace('ws_a', (e) => alsoA.push(e));
    const stopB = await subscribeWorkspace('ws_b', (e) => heardB.push(e));
    push(event('ws_a'));
    push(event('ws_b', 'missing'));
    expect(heardA.map((e) => e.change)).toEqual(['content']);
    expect(alsoA.length).toBe(1);
    expect(heardB.map((e) => e.change)).toEqual(['missing']);
    stopA();
    push(event('ws_a', 'moved'));
    expect(heardA.length).toBe(1);
    expect(alsoA.map((e) => e.change)).toEqual(['content', 'moved']);
    stopAlsoA();
    stopB();
    expect(calls).toEqual(['subscribe ws_a', 'subscribe ws_b', 'unsubscribe ws_a', 'unsubscribe ws_b']);
  });

  it('that do not fit the contract are dropped, and a listener that throws stops nobody else', async () => {
    shell({ onEvent: (cb: (e: unknown) => void) => { push = cb; }, subscribe: async () => true, unsubscribe: async () => true });
    const heard: WorkspaceEvent[] = [];
    const stopBad = await subscribeWorkspace('ws_c', () => { throw new Error('listener bug'); });
    const stop = await subscribeWorkspace('ws_c', (e) => heard.push(e));
    push({ ...event('ws_c'), change: 'deleted-forever' });
    push({ workspaceId: 'ws_c' });
    push(event('ws_c'));
    expect(heard.length).toBe(1);
    stopBad();
    stop();
  });
});

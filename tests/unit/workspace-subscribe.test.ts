import { beforeEach, describe, expect, it } from 'vitest';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import type { WorkspaceEvent } from '../../src/lib/workspace/contracts';

// Asking the shell to watch a workspace, when several parts of the page ask
// at the same moment and the first asking fails or is still under way. A
// bridge whose subscribe answers when the test says so.

type Pending = { resolve: () => void; reject: (e: Error) => void };
let asked: { workspaceId: string; answer: Pending }[];
let unsubscribed: string[];
let push: (event: unknown) => void = () => {};
let serial = 0;
let ws: string;

const event = (workspaceId: string): WorkspaceEvent => ({
  workspaceId, fileId: 'file_1', change: 'content', observedRevision: null, opId: null,
  record: { fileId: 'file_1', workspaceId, relativePath: 'a.md', locator: { kind: 'local', rootGrantId: 'grant_1', relativePath: 'a.md' }, sourceRevision: null, mediaType: 'text/markdown', origin: 'workspace', status: 'ready', revision: null },
});

beforeEach(() => {
  asked = [];
  unsubscribed = [];
  ws = `ws_${++serial}`; // the module remembers workspaces across tests; each test has its own
  window.desktopWorkspace = {
    subscribe: (workspaceId: string) => new Promise<boolean>((resolve, reject) => { asked.push({ workspaceId, answer: { resolve: () => resolve(true), reject } }); }),
    unsubscribe: async (workspaceId: string) => { unsubscribed.push(workspaceId); return true; },
    onEvent: (cb: (event: unknown) => void) => { push = cb; },
  } as unknown as DesktopWorkspaceBridge;
});

describe('several listeners asking for one workspace at the same moment', () => {
  it('ask the shell once, and all of them hear events once it answers', async () => {
    const heard: string[] = [];
    const all = Promise.all(['one', 'two', 'three'].map((name) => subscribeWorkspace(ws, () => heard.push(name))));
    await expect.poll(() => asked.length).toBe(1);
    asked[0].answer.resolve();
    await all;
    expect(asked.length).toBe(1);
    push(event(ws));
    expect(heard.sort()).toEqual(['one', 'three', 'two']);
  });

  it('all fail when the shell refuses, none is left believing it is subscribed, and asking again asks the shell again', async () => {
    const heard: string[] = [];
    const all = Promise.allSettled(['one', 'two', 'three'].map((name) => subscribeWorkspace(ws, () => heard.push(name))));
    await expect.poll(() => asked.length).toBe(1);
    asked[0].answer.reject(new Error("Error invoking remote method 'workspace:subscribe': Error: no-grant: that workspace is not open"));
    expect((await all).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    push(event(ws));
    expect(heard).toEqual([]);

    const again = subscribeWorkspace(ws, () => heard.push('again'));
    await expect.poll(() => asked.length).toBe(2);
    asked[1].answer.resolve();
    await again;
    push(event(ws));
    expect(heard).toEqual(['again']);
  });

  it('a listener that leaves while the shell is still being asked is not left subscribed once it answers', async () => {
    const asking = subscribeWorkspace(ws, () => {});
    await expect.poll(() => asked.length).toBe(1);
    // the part of the page that asked goes away before the answer
    const second = subscribeWorkspace(ws, () => {});
    asked[0].answer.resolve();
    const [stopFirst, stopSecond] = await Promise.all([asking, second]);
    stopFirst();
    expect(unsubscribed).toEqual([]);
    stopSecond();
    expect(unsubscribed).toEqual([ws]);
    // the workspace can be subscribed to again afterwards
    const later = subscribeWorkspace(ws, () => {});
    await expect.poll(() => asked.length).toBe(2);
    asked[1].answer.resolve();
    (await later)();
    expect(unsubscribed).toEqual([ws, ws]);
  });

  it('the shell is told to stop only when the last listener has left', async () => {
    const one = subscribeWorkspace(ws, () => {});
    await expect.poll(() => asked.length).toBe(1);
    asked[0].answer.resolve();
    const stopOne = await one;
    const stopTwo = await subscribeWorkspace(ws, () => {});
    expect(asked.length).toBe(1);
    stopOne();
    stopOne(); // leaving twice is leaving once
    expect(unsubscribed).toEqual([]);
    stopTwo();
    expect(unsubscribed).toEqual([ws]);
  });
});

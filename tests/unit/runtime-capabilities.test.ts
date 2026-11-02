import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCatalog } from '../../src/lib/agents/agent-runtime';
import { createTarget, newTask, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { capabilitiesOf, noteCapabilities, verifyPolicy } from '../../src/lib/context/policy';
import type { CapabilityReport } from '../../src/lib/context/contracts';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the page does with what a runtime was probed to be able to do (T15): a
// run is held to the report, and the run says what it is held to. On a stand-in
// for the desktop shell: what is checked is what the shell is asked.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const report = (over: Partial<CapabilityReport['capabilities']> = {}): CapabilityReport => ({
  runtime: 'codex', binaryVersion: '9.9.9-synthetic', probedAt: '2026-01-01T00:00:00Z',
  capabilities: { fresh: 'supported', resume: 'supported', forkAtCompletedTurn: 'supported', observeState: 'supported', cancel: 'supported', approvals: 'supported', readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported', ...over },
});
let desktop: FakeDesktop;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function task(question: string) {
  const id = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 600 });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: 'an earlier answer', responses: ['an earlier answer'] } } : n)) }));
  return id;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
  setModelsCache({ models: [{ id: CODEX, name: 'synthetic', provider: '__agent__', vision: false }], default: null } as never);
  await recheckAgents();
  useUiStore.getState().setSelectedModel(CODEX);
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  noteCapabilities('codex', null);
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('[T15] what is known of a runtime', () => {
  it('[T15] nothing until the host says, then what it said, and a new report replaces the last', () => {
    expect(capabilitiesOf('codex')).toBeNull();
    noteCapabilities('codex', report());
    expect(capabilitiesOf('codex')?.binaryVersion).toBe('9.9.9-synthetic');
    noteCapabilities('codex', report({ readOnlyRoots: 'unsupported' }));
    expect(capabilitiesOf('codex')?.capabilities.readOnlyRoots).toBe('unsupported');
    noteCapabilities('codex', null);
    expect(capabilitiesOf('codex')).toBeNull();
  });

  it('[T15] looking at the runtimes asks the host what each can do, without waiting for it', async () => {
    let answer: (r: CapabilityReport) => void = () => {};
    const asked: string[] = [];
    window.desktopAgents!.runtimeCapabilities = (runtime) => { asked.push(runtime); return runtime === 'codex' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(null); };
    await agentCatalog();
    await settled();
    expect(asked.sort()).toEqual(['claude-code', 'codex', 'pi']);
    expect(capabilitiesOf('codex')).toBeNull();
    answer(report());
    await settled();
    expect(capabilitiesOf('codex')?.binaryVersion).toBe('9.9.9-synthetic');
  });

  it('[T15] a report of another runtime says nothing of this one', () => {
    const envelope = { mode: 'research' as const, runtime: { kind: 'agent' as const, runtime: 'codex' }, policy: { read: { scope: 'inputs-only' }, write: { scope: 'none' }, tools: { allow: [], mcpServers: [] }, network: 'off', recall: 'off' } } as never;
    expect(verifyPolicy(envelope, { ...report(), runtime: 'claude-code' }).ok).toBe(false);
    expect(verifyPolicy(envelope, report()).ok).toBe(true);
  });
});

describe('[T15] a run on what is known', () => {
  it('[T15] research on a runtime that cannot keep to its inputs is not sent, and says which', async () => {
    noteCapabilities('codex', report({ readOnlyRoots: 'unsupported', autoContextControl: 'unknown' }));
    const id = task('Look at this?');
    setRunMode(id, 'research');
    await useStore.getState().rerunNode(id, {});
    await settled();
    expect(desktop.runs).toEqual([]);
    expect(node(id).data.response).toBeTruthy();
  });

  it('[T15] research on a runtime known to keep to its inputs is sent, starts anew, and the runtime is told it is research', async () => {
    noteCapabilities('codex', report());
    const id = task('Look at this?');
    setRunMode(id, 'research');
    await useStore.getState().rerunNode(id, {});
    await settled();
    expect(desktop.runs).toHaveLength(1);
    expect(desktop.runs[0].mode).toBe('research');
    expect(desktop.runs[0].sessionPath).toBeUndefined();
  });

  it('[T15] a run at work is not told it is research', async () => {
    const id = task('Do this?');
    await useStore.getState().rerunNode(id, {});
    await settled();
    expect(desktop.runs).toHaveLength(1);
    expect(desktop.runs[0].mode).toBeUndefined();
  });

  it('[T15] the thread, the session it belongs to and the turn that finished are kept on the node', async () => {
    desktop.uninstall();
    desktop = installFakeDesktop({ hold: true });
    const id = task('Do this?');
    const running = useStore.getState().rerunNode(id, {});
    await vi.waitFor(() => expect(desktop.runIds).toHaveLength(1));
    await settled();
    const runId = desktop.runIds[0];
    desktop.emit(runId, { type: 'session', sessionId: 'thread-1', threadId: 'thread-1', nativeSessionId: 'tree-1', sessionFile: '/synthetic/rollout-thread-1.jsonl', cwd: '/synthetic/project', model: null });
    desktop.emit(runId, { type: 'binding', threadId: 'thread-1', nativeSessionId: 'tree-1', sessionFile: '/synthetic/rollout-thread-1.jsonl', turnId: 'turn-9', turnStatus: 'completed', lastCompletedTurnId: 'turn-9' });
    desktop.end(runId, 'done');
    await running;
    expect(node(id).data.agentSession).toMatchObject({ sessionId: 'thread-1', threadId: 'thread-1', nativeSessionId: 'tree-1', lastTurnId: 'turn-9', lastCompletedTurnId: 'turn-9' });
  });
});

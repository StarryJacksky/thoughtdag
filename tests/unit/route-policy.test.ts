import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentOutbound, agentTarget } from '../../src/lib/agents/agent-runtime';
import { decideRoute, inspectExpectedPrefix } from '../../src/lib/agents/route-policy';
import { bindingFor } from '../../src/lib/agents/runtime-binding';
import { setRunMode } from '../../src/lib/agents/targets';
import { prepareRun } from '../../src/lib/context/prepare-run';
import { emptyDoc } from '../../src/lib/profile';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';
import { fixture, type FixtureGraph } from '../fixtures/research';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// Whether a question below a mirrored agent session goes on in that session
// or starts a new one. The session holds the turns as they were imported
// (each node's `source`); the run goes on in it only when what the run is
// to be given above its question is exactly that, and nothing else: an
// answer or a question rewritten on the canvas, a file wired in, a role, a
// memory, an exclusion taken back, a turn left out all start a new session
// that is given the whole of it. Research always starts anew, and is not
// run at all on an agent not known to keep to its inputs. Every decision
// says why, in words a person can read.

const f = fixture('single-parent-edited-ancestor');
const MODEL = f.policy.model;
const TARGET = f.expected.targetNodeId; // n3, hanging off the session's tail n2
let desktop: FakeDesktop;

function canvas(graph: FixtureGraph, change: (nodes: ThoughtNode[]) => ThoughtNode[] = (n) => n) {
  const history = f.nativeHistory!;
  useStore.setState({ nodes: change(structuredClone(graph.nodes)), edges: structuredClone(graph.edges) });
  useProjects.setState({
    projects: [{ id: 'fixture-canvas', name: f.name, createdAt: 0, updatedAt: 0, agentCwd: f.policy.cwd, sourceSession: { sessionId: history.sessionId, runner: history.runner, importedCount: history.importedCount, tailNodeId: history.tailNodeId } }],
    activeId: 'fixture-canvas',
    switching: false,
  });
}
const patch = (id: string, data: Partial<ThoughtNode['data']>) => (nodes: ThoughtNode[]) => nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
const question = () => useStore.getState().nodes.find((n) => n.id === TARGET)!.data.question;
const envelopeNow = (mode: 'workspace' | 'research' = 'workspace') => prepareRun({
  graphId: 'fixture-canvas', targetNodeId: TARGET, question: question(), mode,
  runtimeSelection: { kind: 'agent', runtime: agentTarget(MODEL)!.runtime, connectionRef: `runtime:${agentTarget(MODEL)!.runtime}`, model: MODEL, effort: null, capabilityVersion: null },
});
async function route() {
  const envelope = await envelopeNow();
  return agentOutbound(MODEL, TARGET, envelope);
}
const NOTE = { id: 'att-note', name: 'reviewer.md', type: 'text/markdown', size: 20, content: 'WIRED_NOTE_R4: add a section.' };

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  setModelsCache({ models: [{ id: MODEL, name: 'gpt-synthetic', provider: '__agent__', vision: false }], default: null });
  await recheckAgents();
  useUiStore.setState({ memoryEnabled: false, recallEnabled: false, toasts: [] });
  useUiStore.getState().setSelectedModel(MODEL);
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.setState({ memoryEnabled: false, profile: { identity: emptyDoc(), preferences: emptyDoc() } });
  useUiStore.getState().setSelectedModel(null);
});

describe('going on in a mirrored session', () => {
  it('[T14] goes on when what is above the question is exactly what the session holds, and says so', async () => {
    canvas(f.graph);
    const r = await route();
    expect(r).toMatchObject({ continue: true, sessionPath: f.nativeHistory!.sessionFile, decision: { action: 'resume', reason: 'same-conversation' } });
  });

  for (const [what, change, reason] of [
    ['an answer above rewritten on the canvas', patch('n1', { response: 'EDITED_UPSTREAM_M3: the draft uses the trimmed mean.' }), 'edited'],
    ['a question above rewritten on the canvas', patch('n2', { question: 'Is it robust, really?' }), 'edited'],
    ['a file attached above', patch('n1', { attachments: [NOTE] }), 'materials'],
    ['a role set above', patch('n2', { rolePrompt: 'You are a strict reviewer.' }), 'role'],
    ['a turn above left out', patch('n1', { archived: true }), 'conversation'],
  ] as const) {
    it(`[T14] starts anew, given the whole context, with ${what}`, async () => {
      canvas(f.graph, change);
      const r = await route();
      expect(r?.continue).toBeFalsy();
      expect(r?.sessionPath).toBeUndefined();
      expect(r?.decision).toEqual({ action: 'fresh', reason });
    });
  }

  it('[T14] follows an exclusion: a file left out above keeps the session; taken back in by the question, it does not', async () => {
    canvas(f.graph, (nodes) => patch('n2', { excludedAttachmentIds: [NOTE.id] })(patch('n1', { attachments: [NOTE] })(nodes)));
    expect((await route())?.decision).toMatchObject({ action: 'resume', reason: 'same-conversation' });
    canvas(f.graph, (nodes) => patch(TARGET, { includedAttachmentIds: [NOTE.id] })(patch('n2', { excludedAttachmentIds: [NOTE.id] })(patch('n1', { attachments: [NOTE] })(nodes))));
    expect((await route())?.decision).toEqual({ action: 'fresh', reason: 'materials' });
  });

  it('[T14] does not go on in a session whose turns it cannot know: a turn imported without its source', async () => {
    canvas(f.graph, (nodes) => nodes.map((n) => (n.id === 'n1' ? { ...n, data: { ...n.data, source: undefined } } : n)));
    const envelope = await envelopeNow();
    const binding = await bindingFor(TARGET, 'codex');
    expect(binding).not.toBeNull();
    expect(inspectExpectedPrefix(envelope, binding!)).toMatchObject({ result: 'unknown' });
    expect((await agentOutbound(MODEL, TARGET, envelope))?.decision).toEqual({ action: 'fresh', reason: 'unknown-history' });
  });

  it('[T14] decides nothing without the run prepared: no envelope, no going on', async () => {
    canvas(f.graph);
    const r = await agentOutbound(MODEL, TARGET);
    expect(r?.continue).toBeFalsy();
    expect(r?.decision).toEqual({ action: 'fresh', reason: 'not-prepared' });
  });

  it('[T14] starts anew from a turn that is not the session\'s last, while forking at a turn is not known to work', async () => {
    canvas(f.graph, (nodes) => nodes);
    useStore.setState((st) => ({ edges: st.edges.map((e) => (e.target === TARGET ? { ...e, source: 'n1', id: 'n1->n3' } : e)) }));
    const r = await route();
    expect(r?.continue).toBeFalsy();
    expect(r?.decision).toEqual({ action: 'fresh', reason: 'not-the-last-turn' });
  });

  it('[T14] does not run research on an agent not known to keep to its inputs, and never goes on in a session for it', async () => {
    canvas(f.graph);
    setRunMode(TARGET, 'research');
    const envelope = await envelopeNow('research');
    const binding = await bindingFor(TARGET, 'codex');
    expect(decideRoute(envelope, binding, null)).toEqual({ action: 'blocked', reason: 'research-unverified' });
    const verified = { runtime: 'codex' as const, binaryVersion: '1', probedAt: '2026-10-17T00:00:00Z', capabilities: { fresh: 'supported' as const, resume: 'supported' as const, forkAtCompletedTurn: 'unknown' as const, observeState: 'unknown' as const, cancel: 'supported' as const, approvals: 'supported' as const, readOnlyRoots: 'supported' as const, networkRestriction: 'supported' as const, autoContextControl: 'supported' as const } };
    expect(decideRoute(envelope, binding, verified)).toEqual({ action: 'fresh', reason: 'research' });
  });

  it('[T14] does not go on in a session the runtime says it cannot resume, or that is known to be busy elsewhere', async () => {
    canvas(f.graph);
    const envelope = await envelopeNow();
    const binding = (await bindingFor(TARGET, 'codex'))!;
    const report = (resume: 'supported' | 'unsupported') => ({ runtime: 'codex' as const, binaryVersion: '1', probedAt: '2026-10-17T00:00:00Z', capabilities: { fresh: 'supported' as const, resume, forkAtCompletedTurn: 'unknown' as const, observeState: 'unknown' as const, cancel: 'unknown' as const, approvals: 'unknown' as const, readOnlyRoots: 'unknown' as const, networkRestriction: 'unknown' as const, autoContextControl: 'unknown' as const } });
    expect(decideRoute(envelope, binding, report('unsupported'))).toEqual({ action: 'fresh', reason: 'resume-unsupported' });
    expect(decideRoute(envelope, { ...binding, nativeState: { status: 'busy', observedAt: '2026-10-17T00:00:00Z', evidence: 'app-server' } }, report('supported'))).toEqual({ action: 'blocked', reason: 'session-busy' });
    expect(decideRoute(envelope, binding, report('supported'))).toMatchObject({ action: 'resume', bindingId: binding.bindingId });
  });
});

describe('through the run path', () => {
  const asked = f.graph.nodes.find((n) => n.id === TARGET)!.data.question;
  async function ask() {
    await useStore.getState().addQuestion(asked, { parentId: 'n2' });
    return desktop.runs.at(-1)!;
  }

  it('[T14] a memory added to the run starts a new session given the whole of it; without one, the question goes on in the session', async () => {
    canvas(f.graph, (nodes) => nodes.filter((n) => n.id !== TARGET));
    useStore.setState((st) => ({ edges: st.edges.filter((e) => e.target !== TARGET) }));
    const plain = await ask();
    expect(plain.sessionPath).toBe(f.nativeHistory!.sessionFile);
    expect(plain.prompt).toBe(asked);
    expect(useStore.getState().nodes.at(-1)!.data.lastRun?.route).toEqual({ action: 'resume', reason: 'same-conversation' });

    canvas(f.graph, (nodes) => nodes.filter((n) => n.id !== TARGET));
    useStore.setState((st) => ({ edges: st.edges.filter((e) => e.target !== TARGET) }));
    useUiStore.setState({ memoryEnabled: true, profile: { identity: { ...emptyDoc(), text: 'MEMORY_MARKER_M3' }, preferences: emptyDoc() } });
    const withMemory = await ask();
    expect(withMemory.sessionPath).toBeUndefined();
    expect(withMemory.prompt).toContain('MEMORY_MARKER_M3');
    expect(withMemory.prompt).toContain('ORIGINAL_UPSTREAM_A1');
    expect(useStore.getState().nodes.at(-1)!.data.lastRun?.route).toEqual({ action: 'fresh', reason: 'memory' });
  });
});

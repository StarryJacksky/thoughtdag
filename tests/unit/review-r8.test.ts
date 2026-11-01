import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentOutbound, agentTarget } from '../../src/lib/agents/agent-runtime';
import { bindingFor } from '../../src/lib/agents/runtime-binding';
import { prepareRun } from '../../src/lib/context/prepare-run';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { Attachment, ThoughtEdge, ThoughtNode } from '../../src/types';
import { fixture } from '../fixtures/research';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of going on in a native session found (its R8 numbers are
// kept in the test names): what a session holds was read off the canvas's
// wiring, so cutting a turn from the canvas cut it from what the session was
// said to hold, and the two still agreed; and only words were compared, so an
// image, which the canvas's words do not show, went on in the old session.
// On a stand-in for the desktop shell: what is checked is what the shell is
// asked to do, never a real agent's session. Whether a real runtime treats
// these the same is for T15 and T16 to accept.

const f = fixture('single-parent-edited-ancestor');
const MODEL = f.policy.model;
const TARGET = f.expected.targetNodeId; // n3, hanging off the session's tail n2
const SESSION = f.nativeHistory!;
let desktop: FakeDesktop;

type Change = { nodes?: (nodes: ThoughtNode[]) => ThoughtNode[]; edges?: (edges: ThoughtEdge[]) => ThoughtEdge[]; ledger?: Record<string, unknown> };
function canvas({ nodes = (n) => n, edges = (e) => e, ledger = {} }: Change = {}) {
  useStore.setState({ nodes: nodes(structuredClone(f.graph.nodes)), edges: edges(structuredClone(f.graph.edges)) });
  useProjects.setState({
    projects: [{ id: 'fixture-canvas', name: f.name, createdAt: 0, updatedAt: 0, agentCwd: f.policy.cwd, sourceSession: { sessionId: SESSION.sessionId, runner: SESSION.runner, importedCount: SESSION.importedCount, tailNodeId: SESSION.tailNodeId, ...ledger } }],
    activeId: 'fixture-canvas',
    switching: false,
  });
}
const patch = (id: string, data: Partial<ThoughtNode['data']>) => (nodes: ThoughtNode[]) => nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
const envelopeNow = () => prepareRun({
  graphId: 'fixture-canvas', targetNodeId: TARGET, question: useStore.getState().nodes.find((n) => n.id === TARGET)!.data.question, mode: 'workspace',
  runtimeSelection: { kind: 'agent', runtime: agentTarget(MODEL)!.runtime, connectionRef: `runtime:${agentTarget(MODEL)!.runtime}`, model: MODEL, effort: null, capabilityVersion: null },
});
const route = async () => agentOutbound(MODEL, TARGET, await envelopeNow());
/** A question of the same words asked at the tail, through the real run path. */
async function ask(parentId = 'n2') {
  const question = f.graph.nodes.find((n) => n.id === TARGET)!.data.question;
  useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== TARGET), edges: st.edges.filter((e) => e.target !== TARGET) }));
  await useStore.getState().addQuestion(question, { parentId });
  return desktop.runs.at(-1)!;
}
const GOES_ON = { continue: true, sessionPath: SESSION.sessionFile, decision: { action: 'resume', reason: 'same-conversation' } };

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  setModelsCache({ models: [{ id: MODEL, name: 'gpt-synthetic', provider: '__agent__', vision: true }], default: null });
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
  useUiStore.getState().setSelectedModel(null);
});

const otherSessionTurn = (id: string, question: string, response: string): ThoughtNode => ({
  ...structuredClone(f.graph.nodes.find((n) => n.id === 'n1')!),
  id,
  data: {
    ...structuredClone(f.graph.nodes.find((n) => n.id === 'n1')!.data),
    question, response, responses: [response],
    importSource: { runner: 'codex', sessionId: 'sess-synthetic-OTHER', itemIds: ['other-1'], cwd: f.policy.cwd },
    source: { question, response },
  },
});

describe('[R8-01] what a session holds is not what the canvas still shows of it', () => {
  it('[R8-01] control: the canvas as it was imported goes on in the session', async () => {
    canvas();
    expect(await route()).toMatchObject(GOES_ON);
  });

  const cases: [string, Change][] = [
    ['the wire above the last turn cut, the turn kept', { edges: (e) => e.filter((x) => x.source !== 'n1') }],
    ['the first turn deleted with its wire', { nodes: (n) => n.filter((x) => x.id !== 'n1'), edges: (e) => e.filter((x) => x.source !== 'n1') }],
    ['the first turn deleted, its wire left hanging', { nodes: (n) => n.filter((x) => x.id !== 'n1') }],
    ['the wire above the last turn taken to a turn of another session, its own first turn kept', {
      nodes: (n) => [otherSessionTurn('other', 'Which estimator does the draft use?', 'ORIGINAL_UPSTREAM_A1: the draft uses the plain mean.'), ...n],
      edges: (e) => e.map((x) => (x.target === 'n2' ? { ...x, source: 'other' } : x)),
    }],
    ['the first turn replaced by another session\'s turn of the very same words', {
      nodes: (n) => [otherSessionTurn('other', 'Which estimator does the draft use?', 'ORIGINAL_UPSTREAM_A1: the draft uses the plain mean.'), ...n.filter((x) => x.id !== 'n1')],
      edges: (e) => e.map((x) => (x.target === 'n2' ? { ...x, source: 'other' } : x)).filter((x) => x.source !== 'n1'),
    }],
    ['a turn of another session added above the first', {
      nodes: (n) => [otherSessionTurn('other', 'An earlier question', 'An earlier answer'), ...n],
      edges: (e) => [{ id: 'other-n1', source: 'other', target: 'n1' }, ...e],
    }],
    ['the session\'s own turns put in another order', {
      nodes: (n) => [...n.slice(0, 2), { ...structuredClone(n[1]), id: 'n2b', data: { ...structuredClone(n[1].data), question: 'A third turn', response: 'Its answer', responses: ['Its answer'], source: { question: 'A third turn', response: 'Its answer' } } }, ...n.slice(2)],
      edges: (e) => [{ id: 'n1-n2b', source: 'n1', target: 'n2b' }, { id: 'n2b-n2', source: 'n2b', target: 'n2' }, ...e.filter((x) => x.source !== 'n1')],
      ledger: { importedCount: 3 },
    }],
    ['a turn the session holds that the canvas has never had', { ledger: { importedCount: 3 } }],
  ];
  for (const [what, change] of cases) {
    it(`[R8-01] starts anew with ${what}`, async () => {
      canvas(change);
      const r = await route();
      expect(r?.continue).toBeFalsy();
      expect(r?.sessionPath).toBeUndefined();
      expect(r?.decision?.action).toBe('fresh');
    });
  }

  it('[R8-01] through the run path: a cut turn is not in what is sent, and no old session is named', async () => {
    canvas({ edges: (e) => e.filter((x) => x.source !== 'n1') });
    const sent = await ask();
    expect(sent.sessionPath).toBeUndefined();
    expect(sent.prompt).toContain('With the plain mean, no.');
    expect(sent.prompt).not.toContain('ORIGINAL_UPSTREAM_A1');
  });

  it('[R8-01] a chapter is judged by its own session: what comes from the chapter before is not in it', async () => {
    const chapter = (n: ThoughtNode[]) => n.map((x) => (x.id === 'n2' ? { ...x, data: { ...x.data, importSource: { runner: 'codex' as const, sessionId: 'sess-chapter', itemIds: ['c-1'], cwd: f.policy.cwd }, agentSession: { runtime: 'codex' as const, sessionId: 'sess-chapter', sessionFile: '/synthetic/sessions/chapter.jsonl', cwd: f.policy.cwd } } } : x));
    canvas({ nodes: chapter, ledger: { tailNodeId: 'n1', importedCount: 1, chapters: [{ sessionId: 'sess-chapter', runner: 'codex', importedCount: 1, tailNodeId: 'n2' }] } });
    const r = await route();
    expect(r?.continue).toBeFalsy();
    expect(r?.decision).toEqual({ action: 'fresh', reason: 'conversation' });
  });

  it('[R8-01] a session wholly on its canvas as a chapter goes on in that chapter\'s session', async () => {
    const chapter = (n: ThoughtNode[]) => n.filter((x) => x.id !== 'n1').map((x) => (x.id === 'n2' ? { ...x, data: { ...x.data, importSource: { runner: 'codex' as const, sessionId: 'sess-chapter', itemIds: ['c-1'], cwd: f.policy.cwd }, agentSession: { runtime: 'codex' as const, sessionId: 'sess-chapter', sessionFile: '/synthetic/sessions/chapter.jsonl', cwd: f.policy.cwd } } } : x));
    canvas({ nodes: chapter, edges: (e) => e.filter((x) => x.source !== 'n1'), ledger: { tailNodeId: '', importedCount: 0, chapters: [{ sessionId: 'sess-chapter', runner: 'codex', importedCount: 1, tailNodeId: 'n2' }] } });
    expect((await route())?.decision).toEqual({ action: 'resume', bindingId: 'binding:codex:sess-chapter', reason: 'same-conversation' });
  });

  it('[R8-01] controls: a turn archived, or an answer rewritten, still starts anew for the reason it did', async () => {
    canvas({ nodes: patch('n1', { archived: true }) });
    expect((await route())?.decision).toEqual({ action: 'fresh', reason: 'conversation' });
    canvas({ nodes: patch('n1', { response: 'EDITED_UPSTREAM_M3' }) });
    expect((await route())?.decision).toEqual({ action: 'fresh', reason: 'edited' });
  });

  it('[R8-01] the binding says what is known of the session: nothing, when a turn it holds is gone from the canvas', async () => {
    canvas({ nodes: (n) => n.filter((x) => x.id !== 'n1') });
    expect((await bindingFor(TARGET, 'codex'))?.holds ?? null).toBeNull();
  });
});

const png = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const IMAGE: Attachment = { id: 'att-img', name: 'shot.png', type: 'image/png', size: 4, content: png([1, 2, 3, 4]) };
const OTHER_BYTES: Attachment = { ...IMAGE, content: png([9, 9, 9, 9]) };
const COMPANION: Attachment = { ...IMAGE, id: 'att-img-c', extractedText: 'A_SCREENSHOT_OF_A_TABLE' };
const TEXT_ONLY: Attachment = { ...COMPANION, id: 'att-img-t', renderMode: 'text-only' };

describe('[R8-02] an image is an input as much as a text is', () => {
  for (const [what, att] of [['with no text beside it', IMAGE], ['of other bytes and the same length', OTHER_BYTES], ['with text beside it', COMPANION]] as const) {
    it(`[R8-02] an image ${what} added above starts anew and is given as a material`, async () => {
      canvas({ nodes: patch('n1', { attachments: [att] }) });
      const r = await route();
      expect(r?.continue).toBeFalsy();
      expect(r?.decision).toEqual({ action: 'fresh', reason: 'materials' });
      const sent = await ask();
      expect(sent.sessionPath).toBeUndefined();
      expect(sent.images).toHaveLength(1);
      expect(desktop.materials.at(-1)!.files.map((x) => x.name).join(' ')).toContain('shot.png');
    });
  }

  it('[R8-02] an image kept to its text alone is the text: it starts anew, with nothing on the image channel', async () => {
    canvas({ nodes: patch('n1', { attachments: [TEXT_ONLY] }) });
    expect((await route())?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    const sent = await ask();
    expect(sent.images ?? []).toHaveLength(0);
  });

  it('[R8-02] an image taken back in by the question starts anew', async () => {
    canvas({ nodes: (n) => patch(TARGET, { includedAttachmentIds: [IMAGE.id] })(patch('n2', { excludedAttachmentIds: [IMAGE.id] })(patch('n1', { attachments: [IMAGE] })(n))) });
    expect((await route())?.decision).toEqual({ action: 'fresh', reason: 'materials' });
  });

  it('[R8-02] an image left out is not in the run, but a session that was given it holds it all the same: it starts anew', async () => {
    canvas({ nodes: (n) => patch('n2', { excludedAttachmentIds: [IMAGE.id] })(patch('n1', { attachments: [IMAGE] })(n)) });
    const r = await route();
    expect(r?.continue).toBeFalsy();
    expect(r?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    const sent = await ask();
    expect(sent.images ?? []).toHaveLength(0);
  });

  it('[R8-02] an image the question itself is asked with starts anew, and is written for the agent', async () => {
    canvas();
    const question = f.graph.nodes.find((n) => n.id === TARGET)!.data.question;
    useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== TARGET), edges: st.edges.filter((e) => e.target !== TARGET) }));
    await useStore.getState().addQuestion(question, { parentId: 'n2', initialAttachments: [IMAGE] });
    const sent = desktop.runs.at(-1)!;
    expect(sent.sessionPath).toBeUndefined();
    expect(sent.images).toHaveLength(1);
    expect(desktop.materials.at(-1)!.files.map((x) => x.name).join(' ')).toContain('shot.png');
    expect(useStore.getState().nodes.at(-1)!.data.lastRun?.route).toEqual({ action: 'fresh', reason: 'materials' });
  });

  it('[R8-02] control: the same canvas with no image goes on in the session, and hands over no image', async () => {
    canvas();
    const sent = await ask();
    expect(sent.sessionPath).toBe(SESSION.sessionFile);
    expect(sent.images ?? []).toHaveLength(0);
  });
});

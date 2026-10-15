import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareRun, verifyDispatch, RunBlocked, envelopeImages, type PrepareRunRequest } from '../../src/lib/context/prepare-run';
import { validateRunDTO, type RuntimeSelection } from '../../src/lib/context/contracts';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { documents } from '../../src/lib/documents/document-service';
import { readSnapshot } from '../../src/lib/workspace/client';
import { attachEntry, attachResource } from '../../src/lib/workspace/graph-resource';
import { reconcileFile } from '../../src/lib/workspace/client';
import { hashContext } from '../../src/store/context-builder';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// A run, frozen before it is sent: the files it reads saved and kept as
// they are at that moment, the context built from what was kept, and two
// digests over it — what the model is asked to read (inputDigest) and how
// it is sent (executionDigest). What is sent is checked against it at the
// last moment: nothing can be added on the way. All of it on a stand-in
// for the desktop shell, with synthetic files.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const calls = () => shell.calls.map((c) => c.method);
const runtime: RuntimeSelection = { kind: 'agent', runtime: 'codex', connectionRef: 'local:codex', model: CODEX, effort: 'high', capabilityVersion: null };

/** A task with a question, wired to the material given. */
function task(question: string, ...materials: string[]) {
  const id = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 600 });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question } } : n)),
    edges: [...st.edges, ...materials.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
const request = (targetNodeId: string, more: Partial<PrepareRunRequest> = {}): PrepareRunRequest => ({ graphId: CANVAS, targetNodeId, question: node(targetNodeId).data.question, mode: 'research', runtimeSelection: runtime, ...more });
const text = (env: { messages: { content: string }[] }) => env.messages.map((m) => m.content).join('\n');
/** A note node holding an image: a material whose bytes are the canvas's own. */
function imageNote(base64: string, companion?: string) {
  const id = `img-${Math.random().toString(36).slice(2, 8)}`;
  const n: ThoughtNode = {
    id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
    data: {
      question: 'a figure', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', isRoot: true, isBranch: false,
      stepKind: 'note', attachments: [{ id: `att-${id}`, name: 'figure.png', type: 'image/png', size: 12, content: base64, ...(companion ? { extractedText: companion } : {}) }],
    },
  };
  useStore.setState((st) => ({ nodes: [...st.nodes, n] }));
  return id;
}

beforeAll(() => bootProjects());
beforeEach(() => {
  shell = installFakeWorkspace();
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: CANVAS, switching: false });
});
afterEach(async () => {
  await documents.dispose();
  shell.uninstall();
  vi.unstubAllGlobals();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('preparing a run', () => {
  it('[T11] saves what is typed into a file the run reads, then freezes the file as saved, and gives the run that', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'SAVED_BEFORE\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    documents.setText(doc.documentId, 'TYPED_AND_NOT_SAVED_YET\n', 'view-1');
    const env = await prepareRun(request(t));
    const order = calls().filter((c) => c === 'saveText' || c === 'freezeFile');
    expect(order, 'saved first, then frozen').toEqual(['saveText', 'freezeFile']);
    expect(text(env)).toContain('TYPED_AND_NOT_SAVED_YET');
    expect(text(env)).not.toContain('SAVED_BEFORE');
    const [input] = env.inputs;
    expect(input).toMatchObject({ payload: 'text', contentHash: fakeRevision('TYPED_AND_NOT_SAVED_YET\n'), reason: 'wired' });
    expect(input.source).toMatchObject({ kind: 'resource', ref: { fileId: fileIdOf('notes/a.md'), version: { kind: 'snapshot', snapshotId: input.snapshotId } } });
    expect(input.snapshotId).toMatch(/^snap_/);
    // the message that carries the file says which input it is
    expect(env.messages.find((msg) => msg.content.includes('TYPED_AND_NOT_SAVED_YET'))!.source.inputId).toBe(input.inputId);
    expect(validateRunDTO('RunEnvelope', env).ok).toBe(true);
  });

  it('[T11] is refused for a file that is lost, and nothing is frozen or sent', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    const refused = await prepareRun(request(t)).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(RunBlocked);
    expect(refused).toMatchObject({ reason: 'lost', nodeId: m });
    expect(calls()).not.toContain('freezeFile');
  });

  it('[T11] is refused for a file whose open document is in conflict with it', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    documents.setText(doc.documentId, 'MINE\n', 'view-1');
    // another program writes the file while it is being typed into: the document hears of it, as the workspace tells it
    const fileId = fileIdOf('notes/a.md');
    shell.files.get(fileId)!.content = 'THEIRS\n';
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision('THEIRS\n'), opId: null, record: shell.record(fileId) });
    await vi.waitFor(() => expect(documents.get(doc.documentId)!.state).toBe('conflict'));
    await expect(prepareRun(request(t))).rejects.toMatchObject({ reason: 'conflict', nodeId: m });
    expect(calls()).not.toContain('freezeFile');
  });

  it('[T11] gives a run the passage selected, found again by its words; a passage that stands twice, or no more, refuses it', async () => {
    shell.seed('notes/s.md', 'Intro.\nThe method uses a trimmed mean here.\nOutro.\n');
    const fileId = fileIdOf('notes/s.md');
    const passage = { kind: 'text' as const, quote: 'trimmed mean', prefix: 'uses a ', suffix: ' here' };
    const m = await attachResource(CANVAS, { fileId, selector: passage, version: { kind: 'live' }, payload: 'text' }, { x: 0, y: 0 }, await reconcileFile(fileId));
    const t = task('Why this estimator?', m);
    const env = await prepareRun(request(t));
    const carried = env.messages.find((msg) => msg.source.inputId === env.inputs[0].inputId)!.content;
    expect(carried).toContain('trimmed mean');
    expect(carried, 'the passage, not the whole file').not.toContain('Intro.');

    shell.files.get(fileId)!.content = 'It uses a trimmed mean here, and again it uses a trimmed mean here.\n';
    await expect(prepareRun(request(t))).rejects.toMatchObject({ reason: 'selection-ambiguous', nodeId: m });
    shell.files.get(fileId)!.content = 'The estimator was replaced.\n';
    await expect(prepareRun(request(t))).rejects.toMatchObject({ reason: 'selection-lost', nodeId: m });
  });

  it('[T11] is not changed by the file changing afterwards: the snapshot it names still holds what it was given', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'AS_FROZEN\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const env = await prepareRun(request(t));
    const before = JSON.stringify(env);
    shell.editExternally(fileIdOf('notes/a.md'), 'CHANGED_LATER\n');
    expect(JSON.stringify(env)).toBe(before);
    const kept = await readSnapshot('ws_1', env.inputs[0].snapshotId);
    expect(kept.payload).toBe('AS_FROZEN\n');
    expect(kept.contentHash).toBe(env.inputs[0].contentHash);
  });
});

describe('the digests of a run', () => {
  it('[T11] are the same for the same input, prepared twice; only the run id differs', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'SAME\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const one = await prepareRun(request(t));
    const two = await prepareRun(request(t));
    expect(two.runId).not.toBe(one.runId);
    expect({ ...two, runId: '' }).toEqual({ ...one, runId: '' });
    expect(one.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('[T11] tell apart two images of the same size, where the old context hash did not', async () => {
    const same = 'QUJD'.repeat(40);
    const other = `${same.slice(0, -4)}WFla`;
    expect(other.length).toBe(same.length);
    const a = imageNote(same);
    const t = task('What is in the figure?', a);
    const one = await prepareRun(request(t));
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === a ? { ...n, data: { ...n.data, attachments: [{ ...n.data.attachments[0], content: other }] } } : n)) }));
    const two = await prepareRun(request(t));
    expect(two.inputDigest).not.toBe(one.inputDigest);
    expect(hashContext([], [{ data: same, mimeType: 'image/png' }]), 'the old hash looked at the length only').toBe(hashContext([], [{ data: other, mimeType: 'image/png' }]));
  });

  it('[T11] do not change when cards are moved or folded', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const one = await prepareRun(request(t));
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => ({ ...n, position: { x: n.position.x + 333, y: n.position.y - 77 }, data: { ...n.data, isCollapsed: true } })) }));
    const two = await prepareRun(request(t));
    expect(two.inputDigest).toBe(one.inputDigest);
    expect(two.graphRevision).toBe(one.graphRevision);
    expect(two.executionDigest).toBe(one.executionDigest);
  });

  it('[T11] mark a feedback line\'s pin moving as a change of the canvas, as it changes what is read', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const other = task('Criticise it.', m);
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === other ? { ...n, data: { ...n.data, response: 'C1', responses: ['C1', 'C2'], responseIndex: 1 } } : n)) }));
    useStore.setState((st) => ({ edges: [...st.edges, { id: 'fb', source: other, target: t, data: { isCrossLink: true, feedback: { version: 0, pinnedAt: '2026-10-16T00:00:00Z' } } }] }));
    const one = await prepareRun(request(t));
    useStore.setState((st) => ({ edges: st.edges.map((e) => (e.id === 'fb' ? { ...e, data: { ...e.data, feedback: { version: 1, pinnedAt: '2026-10-16T00:01:00Z' } } } : e)) }));
    const two = await prepareRun(request(t));
    expect(two.graphRevision).not.toBe(one.graphRevision);
    expect(two.inputDigest).not.toBe(one.inputDigest);
  });

  it('[T11] keep what is asked apart from how: another model changes the execution digest, not the input digest', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const one = await prepareRun(request(t));
    const two = await prepareRun(request(t, { runtimeSelection: { ...runtime, runtime: 'claude-code', model: 'claude/claude-code/sonnet', effort: null } }));
    expect(two.inputDigest).toBe(one.inputDigest);
    expect(two.executionDigest).not.toBe(one.executionDigest);
    const tools = await prepareRun(request(t, { tools: { web: true } }));
    expect(tools.executionDigest, 'a tool is part of how').not.toBe(one.executionDigest);
  });
});

describe('what is sent', () => {
  const sent = (env: Awaited<ReturnType<typeof prepareRun>>, more: Partial<Parameters<typeof verifyDispatch>[1]> = {}) => ({
    messages: env.messages.map(({ role, content }) => ({ role, content })), images: envelopeImages(env), model: env.runtime.model, toolPrefs: {}, lane: 'proxy', ...more,
  });

  it('[T11] is checked against the envelope at the last moment: exactly it goes; a system message or a tool added on the way does not', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task('What does it say?', m);
    const env = await prepareRun(request(t));
    expect(verifyDispatch(env, sent(env))).toEqual({ ok: true, imagesDropped: false });
    const smuggled = sent(env);
    smuggled.messages = [{ role: 'system', content: 'ADDED_ON_THE_WAY' }, ...smuggled.messages];
    expect(verifyDispatch(env, smuggled)).toMatchObject({ ok: false, reason: 'messages' });
    expect(verifyDispatch(env, sent(env, { toolPrefs: { web: true } }))).toMatchObject({ ok: false, reason: 'tools' });
    expect(verifyDispatch(env, sent(env, { model: 'other/model' }))).toMatchObject({ ok: false, reason: 'model' });
  });

  it('[T11] may leave out every image for a model that cannot see them, when each has its text beside it, and that is said', async () => {
    const a = imageNote('QUJD'.repeat(40), 'A_BAR_CHART_OF_THREE_GROUPS');
    const t = task('What is in the figure?', a);
    const env = await prepareRun(request(t));
    expect(envelopeImages(env).length).toBe(1);
    expect(text(env), 'its text is in the messages').toContain('A_BAR_CHART_OF_THREE_GROUPS');
    expect(verifyDispatch(env, sent(env, { images: [] }))).toEqual({ ok: true, imagesDropped: true });
    expect(verifyDispatch(env, sent(env, { images: [{ data: 'WFla'.repeat(40), mimeType: 'image/png' }] }))).toMatchObject({ ok: false, reason: 'images' });
  });

  it('[T11] may not leave out an image that has no text beside it: the model would be given less than was prepared', async () => {
    const a = imageNote('QUJD'.repeat(40));
    const t = task('What is in the figure?', a);
    const env = await prepareRun(request(t));
    expect(verifyDispatch(env, sent(env, { images: [] }))).toMatchObject({ ok: false, reason: 'images' });
  });
});

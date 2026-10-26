import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { validateRunDTO, type RuntimeSelection } from '../../src/lib/context/contracts';
import { envelopeHeld, prepareRun, previewRun, type PrepareRunRequest } from '../../src/lib/context/prepare-run';
import { useUiStore } from '../../src/lib/ui-store';
import { setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { Attachment, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What the review of the upstream 0.5.26 merge found in the wiring from the
// context to a run (its R9 numbers are kept in the test names): a turn's
// several tool records, rendered into one message, reached the run's
// inputs, the bytes held for it, its preview and the files written for an
// agent as their first record only, and the message's source broke the
// shared contract. All of it on stand-ins for the desktop shell, with
// synthetic canvases.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_A = 'synthetic-a/model-a';
const API_B = 'synthetic-b/model-b';
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false, ...(id.startsWith('codex/') ? { efforts: ['low', 'medium', 'high'] } : {}) });
const MODELS = () => ({ models: [model(CODEX), model(API_A), model(API_B)], default: null });

let desktop: FakeDesktop;
let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;

function thought(id: string, data: Partial<ThoughtNode['data']>): ThoughtNode {
  return {
    id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
    data: {
      question: '', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
      roleMode: 'inherit', isRoot: false, isBranch: false, ...data,
    },
  };
}

beforeAll(() => bootProjects());
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setSelectedModel(CODEX);
});
afterEach(() => {
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

// ── R9-02: several tool records in one message ─────────────────────────

const RUNTIME: RuntimeSelection = { kind: 'agent', runtime: 'codex', connectionRef: 'local:codex', model: CODEX, effort: 'high', capabilityVersion: null };
const record = (id: string, result: string): Attachment => ({ id, name: 'tool: bash', type: 'text/plain', size: result.length, content: `[call] {"command":"cat ${id}.txt"}\n[result]\n${result}` });
const fileAttachment = (id: string, text: string): Attachment => ({ id, name: `${id}.md`, type: 'text/markdown', size: text.length, content: text });

/** An agent turn that ran tools (its records on the node), and a task asked below it. */
function turnWithTools(attachments: Attachment[], leftOut: string[] = []): { turn: string; task: string } {
  useStore.setState((st) => ({ nodes: [...st.nodes, thought('turn', { question: 'run the checks', response: 'the checks ran', responses: ['the checks ran'], responseIndex: 0, isRoot: true, attachments })] }));
  const task = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 600 });
  useStore.setState((st) => ({
    // what the person leaves out of the task's context, from the task's panel
    nodes: st.nodes.map((n) => (n.id === task ? { ...n, data: { ...n.data, question: 'what did the checks find?', excludedAttachmentIds: leftOut } } : n)),
    edges: [...st.edges, { id: 'edge-turn-task', source: 'turn', target: task }],
  }));
  return { turn: 'turn', task };
}
const request = (task: string): PrepareRunRequest => ({ graphId: CANVAS, targetNodeId: task, question: node(task).data.question, mode: 'workspace', runtimeSelection: RUNTIME });
const textOfBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
async function sha256Text(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** What a run of `task` is given of `expected` (attachments of the turn, in order): inputs, held bytes, the message's ties, the preview. */
async function expectEveryRecord(task: string, expected: Attachment[]) {
  const env = await prepareRun(request(task));
  const ids = expected.map((a) => a.id);
  const inputs = env.inputs.filter((i) => i.source.kind === 'attachment' && i.source.nodeId === 'turn');
  expect(inputs.map((i) => (i.source.kind === 'attachment' ? i.source.attachmentId : null)), 'every attachment rendered is an input of the run').toEqual(ids);
  const held = envelopeHeld(env);
  for (const [i, att] of expected.entries()) {
    expect(inputs[i].contentHash).toBe(await sha256Text(att.content));
    expect(textOfBase64(held[inputs[i].inputId]), `${att.id}: what is held is its text`).toBe(att.content);
  }
  expect(env.policy.read.inputIds).toEqual(expect.arrayContaining(inputs.map((i) => i.inputId)));
  // each message names the inputs it renders; together they are all of them
  const tied = env.messages.flatMap((m) => m.source.inputIds ?? (m.source.inputId ? [m.source.inputId] : []));
  expect(new Set(tied)).toEqual(new Set(inputs.map((i) => i.inputId)));
  const verdict = validateRunDTO('RunEnvelope', env);
  expect(verdict.ok ? [] : verdict.errors, 'the envelope as made keeps to the shared contract').toEqual([]);
  const { nodes, edges } = useStore.getState();
  expect(previewRun(task, nodes, edges).inputs.filter((i) => i.nodeId === 'turn').map((i) => i.attachmentId), 'the preview lists the same').toEqual(ids);
  return env;
}

describe('[R9-02] a turn\'s tool records, rendered into one message', () => {
  it('[R9-02] two records: the envelope, its held bytes, the message\'s ties and the preview name both', async () => {
    const one = record('one', 'FIRST_RESULT_Q1');
    const two = record('two', 'SECOND_RESULT_Q2');
    const { task } = turnWithTools([one, two]);
    const env = await expectEveryRecord(task, [one, two]);
    const message = env.messages.find((m) => m.content.includes('FIRST_RESULT_Q1'))!;
    expect(message.content, 'the record message carries both results').toContain('SECOND_RESULT_Q2');
    expect(message.source.attachmentIds).toEqual(['one', 'two']);
    expect(message.source.inputIds).toHaveLength(2);
    expect(message.source.inputId, 'the first input still stands where a single one did').toBe(message.source.inputIds![0]);
  });

  it('[R9-02] one record and three records alike', async () => {
    const solo = record('solo', 'ONLY_RESULT');
    const { task } = turnWithTools([solo]);
    await expectEveryRecord(task, [solo]);
    useStore.setState({ nodes: [], edges: [] });
    const three = [record('r1', 'R1_OUT'), record('r2', 'R2_OUT'), record('r3', 'R3_OUT')];
    const again = turnWithTools(three);
    await expectEveryRecord(again.task, three);
  });

  it('[R9-02] a record left out is not an input; a record repeated is one input; a record beside an ordinary file keeps both', async () => {
    const r1 = record('r1', 'KEPT_ONE');
    const r2 = record('r2', 'LEFT_OUT');
    const r3 = record('r3', 'KEPT_THREE');
    const twin = { ...r1, id: 'twin' };
    const notes = fileAttachment('notes', 'AN_ORDINARY_FILE');
    const { task } = turnWithTools([r1, r2, r3, twin, notes], ['r2']);
    // the context reads the ordinary file first, then the turn's records together
    const env = await expectEveryRecord(task, [notes, r1, r3]);
    expect(env.messages.map((m) => m.content).join('\n')).not.toContain('LEFT_OUT');
    expect(env.excluded.map((x) => (x.source.kind === 'attachment' ? x.source.attachmentId : null))).toEqual(['r2']);
  });

  it('[R9-02] an agent run below the turn gets every record on disk, as the envelope names them', async () => {
    setModelsCache(MODELS());
    const one = record('one', 'FIRST_ON_DISK');
    const two = record('two', 'SECOND_ON_DISK');
    const { task } = turnWithTools([one, two]);
    const before = desktop.runs.length;
    await useStore.getState().editQuestion(task, 'what did the checks find?');
    expect(desktop.runs.length).toBe(before + 1);
    const onDisk = desktop.readableFileContents();
    expect(onDisk, 'the first record is written for the agent').toContain(one.content);
    expect(onDisk, 'and so is the second').toContain(two.content);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { documents } from '../../src/lib/documents/document-service';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { Attachment, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What the review of runs found in the wiring from the canvas to a run (its R6
// numbers are kept in the test names): a file the person left out was still
// saved and frozen before the run, and could stop it; and what a question was
// asked with, attached there and then, had no place in the run's list of
// inputs, nor did the sources of the rest of its context when it was a text.
// All of it on stand-ins for the desktop shell, with synthetic canvases.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
const model = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: true, ...more });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL)], default: null });

let desktop: FakeDesktop;
let shell: FakeWorkspace;
let posted: { messages: { role: string; content: string }[]; images?: unknown[] }[] = [];
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const last = () => useStore.getState().nodes.at(-1)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const touched = () => shell.calls.map((c) => c.method).filter((m) => ['reconcile', 'reconcileFile', 'freezeFile', 'saveText', 'readText', 'readBytes'].includes(m));
const patch = (id: string, data: Partial<ThoughtNode['data']>) => useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) }));

function task(modelId: string, question: string, ...from: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 200 * useStore.getState().nodes.length });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question } } : n)),
    edges: [...st.edges, ...from.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  posted = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ text: 'SYNTHETIC_ANSWER' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, autoRefreshPaused: false });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  useUiStore.getState().setSelectedModel(API_MODEL);
});
afterEach(async () => {
  await documents.dispose();
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

/** A task wired to a file and asked to leave it out, with the door's calls forgotten up to here. */
async function leftOutFile(how: 'on-the-task' | 'inherited' | 'archived' = 'on-the-task') {
  const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/secret.md', 'LEFT_OUT_TEXT_K7\n'), { x: 0, y: 0 });
  const copy = node(m).data.attachments[0].id;
  const t = task(API_MODEL, 'What is left?', m);
  if (how === 'on-the-task') patch(t, { excludedAttachmentIds: [copy] });
  if (how === 'inherited') patch(m, { excludedAttachmentIds: [copy] });
  if (how === 'archived') patch(m, { archived: true });
  shell.calls.length = 0;
  return { m, t, copy };
}
const run = (id: string) => useStore.getState().rerunNode(id);
const sent = () => posted.at(-1)!.messages.map((x) => x.content).join('\n');

describe('[R6-02] what is left out of a run is not touched by it', () => {
  for (const how of ['on-the-task', 'inherited', 'archived'] as const) {
    it(`[R6-02] a file left out (${how}) is neither looked at, saved nor frozen`, async () => {
      const { t } = await leftOutFile(how);
      await run(t);
      expect(touched()).toEqual([]);
      expect(sent()).not.toContain('LEFT_OUT_TEXT_K7');
      expect(node(t).data.generationFailed).toBeFalsy();
      expect(node(t).data.response).toBe('SYNTHETIC_ANSWER');
    });

    it(`[R6-02] a file left out (${how}) that is lost stops nothing`, async () => {
      const { t } = await leftOutFile(how);
      shell.files.get(fileIdOf('notes/secret.md'))!.status = 'missing';
      await run(t);
      expect(node(t).data.generationFailed).toBeFalsy();
      expect(node(t).data.response).toBe('SYNTHETIC_ANSWER');
      expect(touched()).toEqual([]);
    });
  }

  it('[R6-02] a file left out with typing not saved is not saved by a run that does not read it', async () => {
    const { t } = await leftOutFile();
    const doc = await documents.open(fileIdOf('notes/secret.md'), 'view-1');
    documents.setText(doc.documentId, 'TYPED_NOT_SAVED\n', 'view-1');
    shell.calls.length = 0;
    await run(t);
    expect(touched()).toEqual([]);
    expect(documents.get(doc.documentId)!.state).not.toBe('clean');
    expect(node(t).data.response).toBe('SYNTHETIC_ANSWER');
  });

  it('[R6-02] a file left out whose document is in conflict stops nothing', async () => {
    const { t } = await leftOutFile();
    const fileId = fileIdOf('notes/secret.md');
    const doc = await documents.open(fileId, 'view-1');
    documents.setText(doc.documentId, 'MINE\n', 'view-1');
    shell.files.get(fileId)!.content = 'THEIRS\n';
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision('THEIRS\n'), opId: null, record: shell.record(fileId) });
    await vi.waitFor(() => expect(documents.get(doc.documentId)!.state).toBe('conflict'));
    shell.calls.length = 0;
    await run(t);
    expect(node(t).data.generationFailed).toBeFalsy();
    expect(touched()).toEqual([]);
  });

  it('[R6-02] taken back in by the question, the file is looked at and frozen again, and a lost one stops the run again', async () => {
    const { m, t, copy } = await leftOutFile('inherited');
    patch(t, { includedAttachmentIds: [copy] });
    await run(t);
    expect(touched()).toContain('freezeFile');
    expect(sent()).toContain('LEFT_OUT_TEXT_K7');
    shell.files.get(fileIdOf('notes/secret.md'))!.status = 'missing';
    posted = [];
    await run(t);
    expect(posted).toEqual([]);
    expect(node(t).data.generationFailed).toBe(true);
    void m;
  });

  it('[R6-02] a file that is read beside one left out is frozen, and only it', async () => {
    const { m, t } = await leftOutFile();
    const kept = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/kept.md', 'KEPT_TEXT\n'), { x: 300, y: 0 });
    useStore.setState((st) => ({ edges: [...st.edges, { id: `edge-${kept}-${t}`, source: kept, target: t }] }));
    shell.calls.length = 0;
    await run(t);
    const frozen = shell.calls.filter((c) => c.method === 'freezeFile').map((c) => c.args[0]);
    expect(frozen).toEqual([fileIdOf('notes/kept.md')]);
    expect(sent()).toContain('KEPT_TEXT');
    expect(sent()).not.toContain('LEFT_OUT_TEXT_K7');
    void m;
  });
});

describe('[R6-01] a run keeps what it was given until it is over', () => {
  it('[R6-01] the shell is told a run given materials has ended, only then, and where they are', async () => {
    useUiStore.getState().setSelectedModel(CODEX);
    await useStore.getState().addQuestion('describe my attachment', { initialAttachments: [{ id: 'att-1', name: 'note.txt', type: 'text/plain', size: 6, content: 'OWN123' }] });
    const written = desktop.materials.at(-1)!;
    await vi.waitFor(() => expect(desktop.ended).toEqual([{ cwd: written.cwd, runId: written.runId }]));
  });

  it('[R6-01] a run given nothing on disk tells the shell nothing', async () => {
    await useStore.getState().addQuestion('no attachment');
    await vi.waitFor(() => expect(last().data.isLoading).toBe(false));
    expect(desktop.ended).toEqual([]);
  });
});

const TEXT: Attachment = { id: 'att-text', name: 'note.txt', type: 'text/plain', size: 6, content: 'OWN123' };
const PDF: Attachment = { id: 'att-pdf', name: 'paper.pdf', type: 'application/pdf', size: 9, content: 'cGRm', extractedText: 'PDF_TEXT_P1' };
const HTML: Attachment = { id: 'att-html', name: 'page.html', type: 'text/html', size: 9, content: '<b>raw</b>', extractedText: 'HTML_TEXT_H1' };
const IMAGE: Attachment = { id: 'att-image', name: 'shot.png', type: 'image/png', size: 4, content: 'iVBORw0K' };
const EACH = [['text', TEXT, 'OWN123'], ['PDF', PDF, 'PDF_TEXT_P1'], ['HTML', HTML, 'HTML_TEXT_H1']] as const;
const inputsOf = (id: string) => node(id).data.lastRun?.inputs ?? [];

/** A follow-up's parent: an answered question, reading a file. */
async function answered() {
  const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/upstream.md', 'UPSTREAM_TEXT_U1\n'), { x: 0, y: 0 });
  const parent = task(API_MODEL, 'The upstream question', m);
  await run(parent);
  expect(node(parent).data.response).toBe('SYNTHETIC_ANSWER');
  return parent;
}

describe('[R6-03] what a question is asked with is among what its run is given', () => {
  for (const [kind, att, words] of EACH) {
    it(`[R6-03] a first question with a ${kind} attached lists it as an input`, async () => {
      await useStore.getState().addQuestion('describe my attachment', { initialAttachments: [att] });
      expect(sent()).toContain(words);
      expect(inputsOf(last().id).map((i) => i.name)).toEqual([att.name]);
    });

    it(`[R6-03] a follow-up with a ${kind} attached lists it, and the upstream file still has its place`, async () => {
      const parent = await answered();
      await useStore.getState().addQuestion('and this one?', { parentId: parent, initialAttachments: [att] });
      expect(sent()).toContain(words);
      expect(sent()).toContain('UPSTREAM_TEXT_U1');
      expect(inputsOf(last().id).map((i) => i.name)).toEqual(['upstream.md', att.name]);
    });
  }

  it('[R6-03] an agent is given what the question was asked with, as a file of the run\'s own', async () => {
    useUiStore.getState().setSelectedModel(CODEX);
    await useStore.getState().addQuestion('describe my attachment', { initialAttachments: [TEXT] });
    const files = desktop.materials.at(-1)!.files;
    expect(files.map((f) => f.content)).toContain('OWN123');
    expect(desktop.runs.at(-1)!.prompt).toContain('OWN123');
  });

  it('[R6-03] an image attached to a first question and to a follow-up is an input, on the image channel', async () => {
    await useStore.getState().addQuestion('what is this?', { initialAttachments: [IMAGE] });
    expect(posted.at(-1)!.images).toHaveLength(1);
    expect(inputsOf(last().id).map((i) => i.name)).toEqual(['shot.png']);
    const parent = await answered();
    await useStore.getState().addQuestion('and this?', { parentId: parent, initialAttachments: [IMAGE] });
    expect(inputsOf(last().id).map((i) => i.name)).toEqual(['upstream.md', 'shot.png']);
  });

  it('[R6-03] an image attached for an agent is written for it and handed over', async () => {
    useUiStore.getState().setSelectedModel(CODEX);
    await useStore.getState().addQuestion('what is this?', { initialAttachments: [IMAGE] });
    expect(desktop.materials.at(-1)!.files.map((f) => f.name).join(' ')).toContain('shot.png');
    expect(desktop.runs.at(-1)!.images).toHaveLength(1);
  });

  it('[R6-03] a file attached under the name of one upstream with other words in it is not dropped: both are read', async () => {
    const m: ThoughtNode['data']['attachments'][number] = { id: 'att-up', name: 'note.txt', type: 'text/plain', size: 8, content: 'UPSTREAM' };
    await useStore.getState().addQuestion('first', { initialAttachments: [m] });
    const parent = last().id;
    await vi.waitFor(() => expect(node(parent).data.isLoading).toBe(false));
    await useStore.getState().addQuestion('second', { parentId: parent, initialAttachments: [TEXT] });
    expect(sent()).toContain('UPSTREAM');
    expect(sent()).toContain('OWN123');
    expect(inputsOf(last().id)).toHaveLength(2);
  });

  it('[R6-03] the very same file attached again is read once', async () => {
    await useStore.getState().addQuestion('first', { initialAttachments: [TEXT] });
    const parent = last().id;
    await vi.waitFor(() => expect(node(parent).data.isLoading).toBe(false));
    await useStore.getState().addQuestion('second', { parentId: parent, initialAttachments: [{ ...TEXT, id: 'att-text-2' }] });
    expect(sent().match(/OWN123/g)).toHaveLength(1);
    expect(inputsOf(last().id)).toHaveLength(1);
  });

  it('[R6-03] the record of the run says what it was asked with', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/upstream.md', 'UPSTREAM_TEXT_U1\n'), { x: 0, y: 0 });
    const parent = task(API_MODEL, 'The upstream question', m);
    await run(parent);
    await useStore.getState().addQuestion('and this?', { parentId: parent, initialAttachments: [TEXT] });
    await vi.waitFor(() => expect(shell.runRecords.at(-1)?.record.state).toBe('completed'));
    // a run's record in a workspace lists the inputs held there; the rest of what it read is on the answer
    expect(shell.runRecords.at(-1)!.record.inputs.map((i) => i.fileId)).toEqual([fileIdOf('notes/upstream.md')]);
    expect(inputsOf(last().id).map((i) => i.name)).toEqual(['upstream.md', 'note.txt']);
  });
});

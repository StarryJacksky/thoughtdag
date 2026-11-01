import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeSessionConversation } from '../../src/lib/adapters/claude-code-session';
import { appServerThreadConversation } from '../../src/lib/adapters/codex-appserver';
import { codexSessionConversation } from '../../src/lib/adapters/codex-session';
import { piSessionConversation } from '../../src/lib/adapters/pi-session';
import { agentOutbound, agentTarget } from '../../src/lib/agents/agent-runtime';
import { prepareRun } from '../../src/lib/context/prepare-run';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { Attachment, ThoughtEdge, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of the R8-02 fix found (R12-03): whether a session holds an
// image was read off the attachments the canvas shows now, and the importers
// bring over a turn's words and tool calls and not its images. So a session with
// an image in it looked like one without: right after importing it, and after an
// image was taken off a node. Now the session's own record says, when it is
// imported. Real importers on synthetic session files, a stand-in for the desktop
// shell: what is checked is what the shell is told to do. No real session file,
// runtime or model is involved; real ones are for T15 and T16 to accept.

const CWD = '/synthetic/project';
const PIXEL = 'AQIDBA==';

/** A session file of one runtime: `turns` in order, each a question's parts and an answer. */
type Part = { text: string } | { image: string } | { other: string };
type Turn = { parts: Part[]; answer: string };
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const FILES = {
  codex: {
    model: 'codex/gpt-synthetic',
    write: (turns: Turn[]) => [
      { type: 'session_meta', payload: { id: SESSION_ID, cwd: CWD } },
      ...turns.flatMap((t, i) => [
        { type: 'turn_context', payload: { turn_id: `t${i}` } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: t.parts.map((p) => ('text' in p ? { type: 'input_text', text: p.text } : 'image' in p ? { type: 'input_image', image_url: `data:image/png;base64,${p.image}` } : { type: p.other })) } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.answer }] } },
      ]),
    ],
    read: codexSessionConversation,
  },
  'claude-code': {
    model: 'claude/synthetic',
    write: (turns: Turn[]) => turns.flatMap((t, i) => [
      { type: 'user', uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, sessionId: SESSION_ID, cwd: CWD, timestamp: `2026-01-01T00:00:0${i}Z`, message: { role: 'user', content: t.parts.map((p) => ('text' in p ? { type: 'text', text: p.text } : 'image' in p ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: p.image } } : { type: p.other })) } },
      { type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, sessionId: SESSION_ID, cwd: CWD, timestamp: `2026-01-01T00:00:0${i}Z`, message: { role: 'assistant', content: [{ type: 'text', text: t.answer }] } },
    ]),
    read: claudeCodeSessionConversation,
  },
  pi: {
    model: 'pi/synthetic/model',
    write: (turns: Turn[]) => [
      { type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: CWD },
      ...turns.flatMap((t, i) => [
        { type: 'message', id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: `2026-01-01T00:00:0${i}Z`, message: { role: 'user', content: t.parts.map((p) => ('text' in p ? { type: 'text', text: p.text } : 'image' in p ? { type: 'image', data: p.image, mimeType: 'image/png' } : { type: p.other })) } },
        { type: 'message', id: `a${i}`, parentId: `u${i}`, timestamp: `2026-01-01T00:00:0${i}Z`, message: { role: 'assistant', content: [{ type: 'text', text: t.answer }] } },
      ]),
    ],
    read: piSessionConversation,
  },
};
type Runtime = keyof typeof FILES;
const RUNTIMES = Object.keys(FILES) as Runtime[];

const TEXT_ONLY: Turn[] = [{ parts: [{ text: 'Describe the method.' }], answer: 'A plain method.' }];
const WITH_IMAGE: Turn[] = [{ parts: [{ text: 'Describe this picture.' }, { image: PIXEL }], answer: 'A blue square.' }];

let desktop: FakeDesktop;
const SHOT: Attachment = { id: 'att-shot', name: 'shot.png', type: 'image/png', content: PIXEL } as Attachment;
const OTHER_SHOT: Attachment = { id: 'att-other', name: 'other.png', type: 'image/png', content: 'BQYHCA==' } as Attachment;

/** The canvas importing a session file makes: its turns as the real importer builds them, and the ledger. */
async function imported(runtime: Runtime, turns: Turn[], change: (nodes: ThoughtNode[]) => ThoughtNode[] = (n) => n) {
  const def = FILES[runtime];
  const conv = await def.read(def.write(turns).map((l) => JSON.stringify(l)).join('\n'));
  if (!conv) throw new Error('the importer recognized nothing');
  const built = conv.build();
  const tail = built.nodes.at(-1)!;
  const sessionFile = `/synthetic/sessions/rollout-${SESSION_ID}.jsonl`;
  const nodes = built.nodes.map((n) => (n.id === tail.id ? { ...n, data: { ...n.data, agentSession: { runtime, sessionId: conv.sessionId!, sessionFile, cwd: CWD } } } : n));
  useStore.setState({ nodes: change(nodes), edges: built.edges });
  useProjects.setState({
    projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: CWD, sourceSession: { sessionId: conv.sessionId!, runner: runtime, importedCount: built.nodes.length, tailNodeId: tail.id } }],
    activeId: 'canvas-1',
    switching: false,
  });
  useUiStore.getState().setSelectedModel(def.model);
  return { tail, sessionFile, model: def.model, runtime };
}

/** The run path as far as the route, for a question asked at the tail. */
async function routeAt(model: string, tailId: string) {
  const id = 'asked';
  useStore.setState((st) => ({
    nodes: [...st.nodes.filter((n) => n.id !== id), { ...structuredClone(st.nodes.find((n) => n.id === tailId)!), id, data: { question: 'And then?', response: '', responses: [] } as unknown as ThoughtNode['data'] }],
    edges: [...st.edges.filter((e) => e.target !== id), { id: 'to-asked', source: tailId, target: id } as ThoughtEdge],
  }));
  const target = agentTarget(model)!;
  const envelope = await prepareRun({
    graphId: 'canvas-1', targetNodeId: id, question: 'And then?', mode: 'workspace',
    runtimeSelection: { kind: 'agent', runtime: target.runtime, connectionRef: `runtime:${target.runtime}`, model, effort: null, capabilityVersion: null },
  });
  const route = await agentOutbound(model, id, envelope);
  useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== id), edges: st.edges.filter((e) => e.target !== id) }));
  return route;
}
/** A question asked at the tail through the real run path: what the shell was told. */
async function ask(tailId: string) {
  await useStore.getState().addQuestion('And then?', { parentId: tailId });
  return desktop.runs.at(-1)!;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  setModelsCache({ models: RUNTIMES.map((r) => ({ id: FILES[r].model, name: 'synthetic', provider: '__agent__', vision: true })), default: null } as never);
  await recheckAgents();
  useUiStore.setState({ memoryEnabled: false, recallEnabled: false, toasts: [] });
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  delete (window as { desktopSessions?: unknown }).desktopSessions;
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

for (const runtime of RUNTIMES) {
  describe(`[R12-03] ${runtime}: what the session's own record says`, () => {
    it(`[R12-03] ${runtime}: a question and an image in the session: the import shows only words, and the next run starts anew`, async () => {
      const { tail, model } = await imported(runtime, WITH_IMAGE);
      expect((tail.data.attachments ?? []).filter((a) => a.type.startsWith('image/'))).toEqual([]);
      const route = await routeAt(model, tail.id);
      expect(route?.continue).toBeFalsy();
      expect(route?.sessionPath).toBeUndefined();
      expect(route?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    });

    it(`[R12-03] ${runtime}: through the run path: no old session is named, and the turn's words are given`, async () => {
      const { tail } = await imported(runtime, WITH_IMAGE);
      const sent = await ask(tail.id);
      expect(sent.sessionPath).toBeUndefined();
      expect(sent.prompt).toContain('A blue square.');
    });

    it(`[R12-03] ${runtime}: an image on an earlier turn counts, not only the last`, async () => {
      const { tail, model } = await imported(runtime, [...WITH_IMAGE, ...TEXT_ONLY]);
      expect((await routeAt(model, tail.id))?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    });

    it(`[R12-03] ${runtime}: an image sent in a message of no words of its own counts`, async () => {
      const { tail, model } = await imported(runtime, [{ parts: [{ image: PIXEL }], answer: 'What should I look for?' }, ...TEXT_ONLY]);
      const route = await routeAt(model, tail.id);
      expect(route?.continue).toBeFalsy();
      expect(route?.sessionPath).toBeUndefined();
    });

    it(`[R12-03] ${runtime}: something sent that is neither words nor an image is not known not to be an image: it starts anew`, async () => {
      const { tail, model } = await imported(runtime, [{ parts: [{ text: 'Read this.' }, { other: 'some_new_input_kind' }], answer: 'Read.' }]);
      const route = await routeAt(model, tail.id);
      expect(route?.continue).toBeFalsy();
      expect(route?.decision).toEqual({ action: 'fresh', reason: 'unknown-history' });
    });

    it(`[R12-03] ${runtime}: control: a session of words only goes on`, async () => {
      const { tail, model, sessionFile } = await imported(runtime, TEXT_ONLY);
      expect(await routeAt(model, tail.id)).toMatchObject({ continue: true, sessionPath: sessionFile, decision: { action: 'resume', reason: 'same-conversation' } });
    });

    it(`[R12-03] ${runtime}: control: through the run path, a session of words only is named`, async () => {
      const { tail, sessionFile } = await imported(runtime, TEXT_ONLY);
      expect((await ask(tail.id)).sessionPath).toBe(sessionFile);
    });
  });
}

describe('[R12-03] codex: an image in a scheduling step of its own', () => {
  const lines = (...steps: unknown[][]) => steps.flatMap((content, i) => [
    { type: 'turn_context', payload: { turn_id: `t${i}` } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content } },
  ]);
  const IMAGE = { type: 'input_image', image_url: `data:image/png;base64,${PIXEL}` };
  const WORDS = { type: 'input_text', text: 'Describe the method.' };
  const answer = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A plain method.' }] } };
  const says = (rows: unknown[]) => codexSessionConversation([{ type: 'session_meta', payload: { id: SESSION_ID, cwd: CWD } }, ...rows].map((l) => JSON.stringify(l)).join('\n'))!.build().nodes.map((n) => n.data.source?.images);

  it('[R12-03] an image that came after a turn, on its own with nothing answered, goes with that turn', () => {
    expect(says([...lines([WORDS]), answer, ...lines([IMAGE])])).toEqual(['present']);
  });

  it('[R12-03] an image before any words, with nothing answered, is kept as a turn of its own and said', () => {
    expect(says([...lines([IMAGE], [WORDS]), answer])).toEqual(['present', 'none']);
  });
});

describe('[R12-03] a thread read through the app server', () => {
  const thread = (...content: { type: string; text?: string }[]) => ({
    sessionId: SESSION_ID,
    turns: [{ id: 't0', items: [{ type: 'userMessage', id: 'u0', content }, { type: 'agentMessage', id: 'a0', text: 'An answer.' }] }],
  });
  const says = (t: ReturnType<typeof thread>) => appServerThreadConversation(t)!.build().nodes[0].data.source?.images;

  it('[R12-03] words and an image, words and something else, and words only are told apart', () => {
    expect(says(thread({ type: 'text', text: 'Look.' }, { type: 'image' }))).toBe('present');
    expect(says(thread({ type: 'text', text: 'Look.' }, { type: 'localImage' }))).toBe('present');
    expect(says(thread({ type: 'text', text: 'Look.' }, { type: 'some_new_input_kind' }))).toBe('unknown');
    expect(says(thread({ type: 'text', text: 'Look.' }))).toBe('none');
  });
});

describe('[R12-03] the canvas does not speak for the session', () => {
  it('[R12-03] an image shown on the canvas and taken off: the session still holds what it held', async () => {
    const { tail, model } = await imported('codex', WITH_IMAGE, (n) => n.map((x) => ({ ...x, data: { ...x.data, attachments: [...(x.data.attachments ?? []), SHOT] } })));
    expect((await routeAt(model, tail.id))?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    useStore.getState().removeAttachment(tail.id, SHOT.id);
    const route = await routeAt(model, tail.id);
    expect(route?.sessionPath).toBeUndefined();
    expect(route?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    expect((await ask(tail.id)).sessionPath).toBeUndefined();
  });

  it('[R12-03] an image put in place of another: starts anew', async () => {
    const { tail, model } = await imported('codex', WITH_IMAGE, (n) => n.map((x) => ({ ...x, data: { ...x.data, attachments: [...(x.data.attachments ?? []), SHOT] } })));
    useStore.getState().removeAttachment(tail.id, SHOT.id);
    useStore.getState().addAttachment(tail.id, OTHER_SHOT);
    expect((await routeAt(model, tail.id))?.decision).toEqual({ action: 'fresh', reason: 'materials' });
  });

  it('[R12-03] an image left out of the context: the session still holds it', async () => {
    const { tail, model } = await imported('codex', WITH_IMAGE, (n) => n.map((x) => ({ ...x, data: { ...x.data, attachments: [...(x.data.attachments ?? []), SHOT] } })));
    useStore.getState().toggleExcludeAttachment(tail.id, SHOT.id);
    expect((await routeAt(model, tail.id))?.sessionPath).toBeUndefined();
  });

  it('[R12-03] nothing done to a node\'s attachments changes what its import said', async () => {
    const { tail } = await imported('codex', WITH_IMAGE, (n) => n.map((x) => ({ ...x, data: { ...x.data, attachments: [...(x.data.attachments ?? []), SHOT] } })));
    useStore.getState().removeAttachment(tail.id, SHOT.id);
    expect(useStore.getState().nodes.find((n) => n.id === tail.id)!.data.source?.images).toBe('present');
  });

  it('[R12-03] control: an image put on a session of words only starts anew while it is there; taken off, the session is as it was and goes on', async () => {
    const { tail, model, sessionFile } = await imported('codex', TEXT_ONLY);
    useStore.getState().addAttachment(tail.id, SHOT);
    expect((await routeAt(model, tail.id))?.decision).toEqual({ action: 'fresh', reason: 'materials' });
    useStore.getState().removeAttachment(tail.id, SHOT.id);
    expect(await routeAt(model, tail.id)).toMatchObject({ continue: true, sessionPath: sessionFile });
  });
});

describe('[R12-03] what was imported before this was recorded', () => {
  const unsaid = (x: ThoughtNode): ThoughtNode => ({ ...x, data: { ...x.data, source: { question: x.data.source!.question, response: x.data.source!.response } } });

  it('[R12-03] a session none of whose turns say: not known, so it starts anew, and no old session is named', async () => {
    const { tail, model } = await imported('codex', TEXT_ONLY, (n) => n.map(unsaid));
    const route = await routeAt(model, tail.id);
    expect(route?.continue).toBeFalsy();
    expect(route?.sessionPath).toBeUndefined();
    expect(route?.decision).toEqual({ action: 'fresh', reason: 'unknown-history' });
  });

  it('[R12-03] one turn that does not say is enough', async () => {
    const { tail, model } = await imported('codex', [...TEXT_ONLY, ...TEXT_ONLY.map((t) => ({ ...t, answer: 'And more.' }))], (n) => n.map((x, i) => (i === 0 ? unsaid(x) : x)));
    expect((await routeAt(model, tail.id))?.decision).toEqual({ action: 'fresh', reason: 'unknown-history' });
  });

  it('[R12-03] through the run path: no old session is named', async () => {
    const { tail } = await imported('codex', TEXT_ONLY, (n) => n.map(unsaid));
    expect((await ask(tail.id)).sessionPath).toBeUndefined();
  });
});

describe('[R12-03] chapters', () => {
  /** Two sessions on one canvas: the first of them a chapter that went before, the tail in the second. */
  async function twoSessions(first: Turn[], second: Turn[], { wired }: { wired: boolean }) {
    const { tail: firstTail, sessionFile } = await imported('codex', first);
    const firstNodes = useStore.getState().nodes;
    const firstEdges = useStore.getState().edges;
    const conv = await codexSessionConversation(FILES.codex.write(second).map((l) => JSON.stringify(l)).join('\n').replaceAll(SESSION_ID, 'chapter-two'));
    const built = conv!.build();
    const tail = built.nodes.at(-1)!;
    const file = '/synthetic/sessions/rollout-chapter-two.jsonl';
    useStore.setState({
      nodes: [...firstNodes, ...built.nodes.map((n) => (n.id === tail.id ? { ...n, data: { ...n.data, agentSession: { runtime: 'codex' as const, sessionId: 'chapter-two', sessionFile: file, cwd: CWD } } } : n))],
      edges: [...firstEdges, ...built.edges, ...(wired ? [{ id: 'across', source: firstTail.id, target: built.nodes[0].id } as ThoughtEdge] : [])],
    });
    useProjects.setState((st) => ({ projects: st.projects.map((p) => ({ ...p, sourceSession: { ...p.sourceSession!, chapters: [{ sessionId: 'chapter-two', runner: 'codex', importedCount: built.nodes.length, tailNodeId: tail.id }] } })) }));
    return { tail, firstTail, file, sessionFile };
  }

  it('[R12-03] a chapter with an image, asked at its own tail: starts anew, whatever the chapter before says', async () => {
    const { tail } = await twoSessions(TEXT_ONLY, WITH_IMAGE, { wired: false });
    expect((await routeAt(FILES.codex.model, tail.id))?.sessionPath).toBeUndefined();
  });

  it('[R12-03] a chapter of words below a chapter with an image, wired together: starts anew', async () => {
    const { tail } = await twoSessions(WITH_IMAGE, TEXT_ONLY, { wired: true });
    expect((await routeAt(FILES.codex.model, tail.id))?.sessionPath).toBeUndefined();
  });

  it('[R12-03] control: a chapter of words, not wired to the chapter with the image, is judged by its own session: it goes on', async () => {
    const { tail, file } = await twoSessions(WITH_IMAGE, TEXT_ONLY, { wired: false });
    expect(await routeAt(FILES.codex.model, tail.id)).toMatchObject({ continue: true, sessionPath: file });
  });
});

describe('[R12-03] a turn this application ran itself', () => {
  /** A run through the real path whose session file then says what `turns` say; the node becomes that turn's mirror. */
  async function ran(turns: Turn[], attachments: Attachment[] = []) {
    desktop.uninstall();
    desktop = installFakeDesktop({ hold: true });
    const file = `/synthetic/sessions/rollout-${SESSION_ID}.jsonl`;
    window.desktopSessions = {
      roots: async () => [{ key: 'codex-sessions', path: '/synthetic/sessions/' }],
      read: async () => FILES.codex.write(turns).map((l) => JSON.stringify(l)).join('\n'),
      list: async () => [],
    } as unknown as typeof window.desktopSessions;
    useStore.setState({ nodes: [], edges: [] });
    useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: CWD }], activeId: 'canvas-1', switching: false });
    useUiStore.getState().setSelectedModel(FILES.codex.model);
    const asking = useStore.getState().addQuestion(turns[0].parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n'), { initialAttachments: attachments });
    await vi.waitFor(() => expect(desktop.runIds.length).toBe(1));
    const [runId] = desktop.runIds;
    desktop.emit(runId, { type: 'session', sessionId: SESSION_ID, sessionFile: file, cwd: CWD });
    desktop.end(runId, turns[0].answer);
    await asking;
    await vi.waitFor(() => expect(useStore.getState().nodes.at(-1)!.data.source).toBeTruthy());
    desktop.uninstall();
    desktop = installFakeDesktop();
    return { node: useStore.getState().nodes.at(-1)!, file };
  }

  it('[R12-03] an image the run was given is in the session, even if the runtime\'s record shows only words: taken off the node, the next run starts anew', async () => {
    const { node } = await ran(TEXT_ONLY, [SHOT]);
    expect(node.data.source?.images).toBe('present');
    useStore.getState().removeAttachment(node.id, SHOT.id);
    expect((await ask(node.id)).sessionPath).toBeUndefined();
  });

  it('[R12-03] control: a run of words whose record shows only words goes on', async () => {
    const { node, file } = await ran(TEXT_ONLY);
    expect(node.data.source?.images).toBe('none');
    expect((await ask(node.id)).sessionPath).toBe(file);
  });
});

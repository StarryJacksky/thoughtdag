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
import type { ThoughtEdge, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of the R12-03 fix found (R13-03): a Pi session whose first
// input was only an image, then an answer. The input opened no turn, so the
// image was noted for a next turn that never came to hold it: the answer's turn
// said its session holds no image, and the next question went on in that session.
// Real importers on synthetic session files, through the real binding and route,
// with a stand-in for the desktop shell. No real session file, runtime or model
// is involved.

const CWD = '/synthetic/project';
const PIXEL = 'AQIDBA==';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** One entry of a session: an input of the parts given, an answer, or an answer's tool call and its result. */
type Part = { text: string } | { image: string } | { other: string };
type Step = { input: Part[] } | { answer: string } | { tool: string };

const lineage = (steps: Step[]) => steps.map((step, i) => ({ step, id: `i${i}`, parent: i ? `i${i - 1}` : null, at: `2026-01-01T00:00:0${i}Z` }));

const FILES = {
  'claude-code': {
    model: 'claude/synthetic',
    write: (steps: Step[]) => lineage(steps).map(({ step, id, parent, at }) => {
      const base = { uuid: id, parentUuid: parent, sessionId: SESSION_ID, cwd: CWD, timestamp: at };
      if ('input' in step) return { ...base, type: 'user', message: { role: 'user', content: step.input.map((p) => ('text' in p ? { type: 'text', text: p.text } : 'image' in p ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: p.image } } : { type: p.other })) } };
      if ('tool' in step) return { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: step.tool, name: 'Read', input: { file_path: 'a.md' } }] } };
      return { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.answer }] } };
    }),
    read: claudeCodeSessionConversation,
  },
  pi: {
    model: 'pi/synthetic/model',
    write: (steps: Step[]) => [
      { type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: CWD },
      ...lineage(steps).map(({ step, id, parent, at }) => {
        const base = { type: 'message', id, parentId: parent, timestamp: at };
        if ('input' in step) return { ...base, message: { role: 'user', content: step.input.map((p) => ('text' in p ? { type: 'text', text: p.text } : 'image' in p ? { type: 'image', data: p.image, mimeType: 'image/png' } : { type: p.other })) } };
        if ('tool' in step) return { ...base, message: { role: 'assistant', content: [{ type: 'toolCall', id: step.tool, name: 'read', arguments: { path: 'a.md' } }] } };
        return { ...base, message: { role: 'assistant', content: [{ type: 'text', text: step.answer }] } };
      }),
    ],
    read: piSessionConversation,
  },
  codex: {
    model: 'codex/gpt-synthetic',
    write: (steps: Step[]) => {
      let turn = -1;
      return [
        { type: 'session_meta', payload: { id: SESSION_ID, cwd: CWD } },
        ...steps.flatMap((step): unknown[] => {
          if ('input' in step) { turn++; return [{ type: 'turn_context', payload: { turn_id: `t${turn}` } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: step.input.map((p) => ('text' in p ? { type: 'input_text', text: p.text } : 'image' in p ? { type: 'input_image', image_url: `data:image/png;base64,${p.image}` } : { type: p.other })) } }]; }
          if ('tool' in step) return [{ type: 'response_item', payload: { type: 'function_call', call_id: step.tool, name: 'shell', arguments: '{"command":["true"]}' } }];
          return [{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step.answer }] } }];
        }),
      ];
    },
    read: codexSessionConversation,
  },
};
type Runtime = keyof typeof FILES;
const RUNTIMES = Object.keys(FILES) as Runtime[];

let desktop: FakeDesktop;

async function importedFile(runtime: Runtime, steps: Step[]) {
  const def = FILES[runtime];
  const conv = await def.read(def.write(steps).map((l) => JSON.stringify(l)).join('\n'));
  if (!conv) throw new Error('the importer recognized nothing');
  return { conv, built: conv.build() };
}

/** The canvas importing a session file makes, and the ledger. */
async function imported(runtime: Runtime, steps: Step[]) {
  const { conv, built } = await importedFile(runtime, steps);
  const answered = built.nodes.filter((n) => !n.data.stepKind || n.data.stepKind !== 'note');
  const tail = answered.at(-1)!;
  const sessionFile = `/synthetic/sessions/rollout-${SESSION_ID}.jsonl`;
  const nodes = built.nodes.map((n) => (n.id === tail.id ? { ...n, data: { ...n.data, agentSession: { runtime, sessionId: conv.sessionId!, sessionFile, cwd: CWD } } } : n));
  useStore.setState({ nodes, edges: built.edges });
  useProjects.setState({
    projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: CWD, sourceSession: { sessionId: conv.sessionId!, runner: runtime, importedCount: built.nodes.length, tailNodeId: tail.id } }],
    activeId: 'canvas-1',
    switching: false,
  });
  useUiStore.getState().setSelectedModel(FILES[runtime].model);
  return { nodes: built.nodes, tail, sessionFile, model: FILES[runtime].model };
}

/** The run path as far as the route, for a question asked at a node. */
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
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

const IMAGE: Part[] = [{ image: PIXEL }];
const UNKNOWN: Part[] = [{ other: 'some_new_input_kind' }];
const WORDS = (text: string): Part[] => [{ text }];
const FRESH_IMAGE = { action: 'fresh', reason: 'materials' };
const FRESH_UNKNOWN = { action: 'fresh', reason: 'unknown-history' };

for (const runtime of RUNTIMES) {
  describe(`[R13-03] ${runtime}: an input with no words`, () => {
    it(`[R13-03] ${runtime}: only an image first, then an answer: the answer is its turn's, that turn holds an image, and the next question starts anew`, async () => {
      const { nodes, tail, model } = await imported(runtime, [{ input: IMAGE }, { answer: 'A blue square.' }]);
      expect(nodes).toHaveLength(1);
      expect(tail.data.response).toBe('A blue square.');
      expect(tail.data.source?.images).toBe('present');
      expect(tail.data.question).toBe('(image-only turn)');
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: something unknown first, then an answer: not known not to be an image`, async () => {
      const { tail, model } = await imported(runtime, [{ input: UNKNOWN }, { answer: 'Read.' }]);
      expect(tail.data.source?.images).toBe('unknown');
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_UNKNOWN);
    });

    it(`[R13-03] ${runtime}: only an image first, then a tool, then an answer`, async () => {
      const { nodes, tail, model } = await imported(runtime, [{ input: IMAGE }, { tool: 'call-1' }, { answer: 'Looked.' }]);
      expect(nodes).toHaveLength(1);
      expect(tail.data.source?.images).toBe('present');
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: only an image first, then words, then an answer: one question`, async () => {
      const { nodes, tail, model } = await imported(runtime, [{ input: IMAGE }, { input: WORDS('What is it?') }, { answer: 'A square.' }]);
      expect(tail.data.question).toBe('What is it?');
      // a Codex rollout has steps of its own: a step that held only the image stays a turn before the question (R12-03)
      expect(nodes.map((n) => n.data.source?.images)).toEqual(runtime === 'codex' ? ['present', 'none'] : ['present']);
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: only an image in the middle, then an answer: the next question starts anew`, async () => {
      const { tail, model } = await imported(runtime, [{ input: WORDS('First?') }, { answer: 'First.' }, { input: IMAGE }, { answer: 'A square.' }]);
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: only an image in the middle, then more words and an answer: still starts anew at the end`, async () => {
      const { tail, model } = await imported(runtime, [{ input: WORDS('First?') }, { answer: 'First.' }, { input: IMAGE }, { answer: 'A square.' }, { input: WORDS('Then?') }, { answer: 'Then.' }]);
      expect(tail.data.source?.images).toBe('none');
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: the session ends on an input of only an image, with no answer: what comes before is not said to hold none`, async () => {
      const { nodes, tail, model } = await imported(runtime, [{ input: WORDS('First?') }, { answer: 'First.' }, { input: IMAGE }]);
      expect(nodes).toHaveLength(1);
      expect(tail.data.response).toBe('First.');
      expect((await routeAt(model, tail.id))?.decision).toEqual(FRESH_IMAGE);
    });

    it(`[R13-03] ${runtime}: control: words only go on`, async () => {
      const { tail, model, sessionFile } = await imported(runtime, [{ input: WORDS('First?') }, { answer: 'First.' }, { input: WORDS('Then?') }, { answer: 'Then.' }]);
      expect(tail.data.source?.images).toBe('none');
      expect(await routeAt(model, tail.id)).toMatchObject({ continue: true, sessionPath: sessionFile, decision: { action: 'resume', reason: 'same-conversation' } });
    });
  });
}

for (const runtime of ['claude-code', 'pi'] as const) {
  describe(`[R13-03] ${runtime}: an input with no words keeps its place in the session's tree`, () => {
    it(`[R13-03] ${runtime}: its id belongs to its turn, and what names it as parent hangs from that turn`, async () => {
      const def = FILES[runtime];
      const rows = def.write([{ input: IMAGE }, { answer: 'A blue square.' }, { input: WORDS('Why blue?') }, { answer: 'It is.' }]) as Record<string, unknown>[];
      const named = rows.find((r) => r.id === 'i2' || r.uuid === 'i2')!;
      if ('parentId' in named) named.parentId = 'i0'; else named.parentUuid = 'i0';
      const conv = await def.read(rows.map((l) => JSON.stringify(l)).join('\n'));
      const { nodes, edges } = conv!.build();
      expect(nodes).toHaveLength(2);
      expect(nodes[0].data.importSource?.itemIds).toContain('i0');
      expect(nodes[0].data.importSource?.itemIds).toContain('i1');
      expect(edges.map((e) => [e.source, e.target])).toEqual([[nodes[0].id, nodes[1].id]]);
    });

    it(`[R13-03] ${runtime}: an image in the middle is its own turn, not the turn before it: going on from before it is not held back by it`, async () => {
      const { built: { nodes } } = await importedFile(runtime, [{ input: WORDS('First?') }, { answer: 'First.' }, { input: IMAGE }, { answer: 'A square.' }]);
      expect(nodes.map((n) => n.data.source?.images)).toEqual(['none', 'present']);
      expect(nodes.map((n) => n.data.response)).toEqual(['First.', 'A square.']);
      expect(nodes[1].data.importSource?.itemIds).toContain('i2');
    });

    it(`[R13-03] ${runtime}: an input of only an image while a question waits for its answer belongs to that question`, async () => {
      const { built: { nodes } } = await importedFile(runtime, [{ input: WORDS('What is this?') }, { input: IMAGE }, { answer: 'A square.' }]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].data.source?.images).toBe('present');
      expect(nodes[0].data.importSource?.itemIds).toContain('i1');
    });
  });
}

describe('[R13-03] codex app-server', () => {
  const thread = (items: unknown[]) => ({ sessionId: SESSION_ID, turns: [{ id: 't0', items }] });
  const convOf = (items: unknown[]) => appServerThreadConversation(thread(items) as never);

  it('[R13-03] only an image first, then an answer: that turn holds an image', () => {
    const conv = convOf([{ type: 'userMessage', id: 'u0', content: [{ type: 'image' }] }, { type: 'agentMessage', id: 'a0', text: 'A blue square.' }]);
    const { nodes } = conv!.build();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.source?.images).toBe('present');
    expect(nodes[0].data.question).toBe('(image-only turn)');
  });

  it('[R13-03] something unknown first, then an answer: not known not to be an image', () => {
    const conv = convOf([{ type: 'userMessage', id: 'u0', content: [{ type: 'someNewKind' }] }, { type: 'agentMessage', id: 'a0', text: 'Read.' }]);
    expect(conv!.build().nodes[0].data.source?.images).toBe('unknown');
  });

  it('[R13-03] control: words only hold none', () => {
    const conv = convOf([{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'First?' }] }, { type: 'agentMessage', id: 'a0', text: 'First.' }]);
    expect(conv!.build().nodes[0].data.source?.images).toBe('none');
  });
});

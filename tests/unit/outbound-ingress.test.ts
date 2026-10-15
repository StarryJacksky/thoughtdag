/// <reference types="node" />
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clear, get } from 'idb-keyval';
import { useStore } from '../../src/store';
import { projectStorageKey, useProjects } from '../../src/store/projects';
import { runNodeGeneration } from '../../src/store/streaming';
import { importProjectFromFile, parseImportFile } from '../../src/lib/export';
import { instantiateParadigm } from '../../src/lib/paradigm';
import { decodeViewerHash } from '../../src/lib/viewer';
import { flushPendingWrites } from '../../src/lib/persistence';
import { useUiStore } from '../../src/lib/ui-store';
import type { Reference, ThoughtData, ThoughtNode } from '../../src/types';

// Every entry test contains rejected and accepted URLs. Removing its boundary
// guard must fail that test, while titles, citation positions and prose survive.
const cases: { value: unknown; want: string | undefined }[] = [
  { value: 'smb://host/share', want: undefined },
  { value: 'ssh://host', want: undefined },
  { value: 'file:///tmp/paper.pdf', want: undefined },
  { value: 'javascript:alert(1)', want: undefined },
  { value: 'data:text/html,hello', want: undefined },
  { value: 'thoughtdag://why/session', want: undefined },
  { value: 'mailto:reader@example.com', want: undefined },
  { value: 'tel:123', want: undefined },
  { value: 'irc://host/channel', want: undefined },
  { value: '//example.com/paper', want: undefined },
  { value: '/tmp/paper.pdf', want: undefined },
  { value: 'https://', want: undefined },
  { value: 'https://[broken', want: undefined },
  { value: ' https://example.com', want: undefined },
  { value: 'https://example.com\n', want: undefined },
  { value: 'https://exam\tple.com', want: undefined },
  { value: 'https://example.com/a b', want: undefined },
  { value: '', want: undefined },
  { value: null, want: undefined },
  { value: 123, want: undefined },
  { value: undefined, want: undefined },
  { value: 'HTTPS://Example.COM:443/Paper?q=%2F#Part', want: 'HTTPS://Example.COM:443/Paper?q=%2F#Part' },
  { value: 'http://Example.com:80/a', want: 'http://Example.com:80/a' },
  { value: 'https://example.com/a%20b', want: 'https://example.com/a%20b' },
];
const prose = 'Evidence [1], [2], [24]. [Recall](thoughtdag://why/session) [Local](/tmp/paper.pdf)';
const references = (): Reference[] => cases.map(({ value }, i) => ({
  title: `Source ${i + 1}`, url: value as string | undefined,
  media: 'journal', date: '2026-10-04',
}));

function nodes(stepKind: ThoughtData['stepKind'] = 'link'): ThoughtNode[] {
  return cases.map(({ value }, i) => ({
    id: `node-${i}`, type: 'thought', position: { x: 0, y: i * 300 },
    data: {
      question: prose, response: prose, responses: [prose], responseIndex: 0,
      isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 10, highlights: [], highlightMode: 'tag', attachments: [],
      excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit',
      isRoot: true, isBranch: false, stepKind,
      linkUrl: value as string | undefined, linkTitle: `Material ${i + 1}`,
      references: references(),
    },
  }));
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function expectReferences(actual: Reference[] | undefined) {
  expect(actual).toHaveLength(cases.length);
  cases.forEach(({ want }, i) => {
    expect(actual![i]).toEqual({ title: `Source ${i + 1}`, url: want, media: 'journal', date: '2026-10-04' });
  });
}

function expectNodes(actual: ThoughtNode[], withReferences = true) {
  expect(actual).toHaveLength(cases.length);
  cases.forEach(({ want }, i) => {
    expect(actual[i].data.linkUrl, `link ${i + 1}`).toBe(want);
    expect(actual[i].data.linkTitle).toBe(`Material ${i + 1}`);
    expect(actual[i].data.question).toBe(prose);
    if (withReferences) {
      expect(actual[i].data.response).toBe(prose);
      expect(actual[i].data.responses).toEqual([prose]);
      expectReferences(actual[i].data.references);
    }
  });
}

async function expectImported(kind: 'chat' | 'paradigm') {
  const { activeId, projects } = useProjects.getState();
  expect(projects.find((p) => p.id === activeId)?.kind).toBe(kind);
  // Inspect both the persisted import and the real store after rehydration.
  const saved = await get(projectStorageKey(activeId!));
  const envelope = typeof saved === 'string' ? JSON.parse(saved) : saved;
  expectNodes(envelope.state.nodes);
  expectNodes(useStore.getState().nodes);
}

beforeEach(async () => {
  await flushPendingWrites();
  await clear();
  useStore.persist.setOptions({ name: 'ingress-test' });
  useStore.setState({ nodes: [], edges: [], events: [], history: [], historyIndex: -1 });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.setState({ selectedModel: null, recallEnabled: false, memoryEnabled: false });
  // Use Node's real web-platform Blob/File: jsdom lacks Blob.stream/File.text.
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/models')) return Response.json({ models: [], default: null });
    throw new Error(`Unexpected network request: ${String(input)}`);
  });
});

afterEach(async () => {
  await flushPendingWrites();
  vi.unstubAllGlobals();
});

describe('outbound URLs at client ingress', () => {
  it('sanitizes streamed sources through the real SSE parser and store', async () => {
    const source = freeze(references());
    const original = structuredClone(source);
    // a model to send to: with the models known and none to name, nothing would be sent at all (see L06 in review-round3-response.md)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/models')) return Response.json({ models: [{ id: 'synthetic-provider/model', name: 'model', provider: 'synthetic-provider', vision: false }], default: 'synthetic-provider/model' });
      if (String(input).endsWith('/api/stream')) {
        return new Response(`data: ${JSON.stringify({ sources: source })}\n\ndata: ${JSON.stringify({ text: prose })}\n\ndata: [DONE]\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected network request: ${String(input)}`);
    });
    const node = nodes('prompt')[0];
    useStore.setState({ nodes: [node] });
    await runNodeGeneration(useStore.setState, useStore.getState, node.id, {
      question: prose, messages: [{ role: 'user', content: prose }],
    });
    const result = useStore.getState().nodes[0].data;
    expect(result.generationFailed).toBeUndefined();
    expect(result.response).toBe(prose);
    expectReferences(result.references);
    expect(source).toEqual(original);
  });

  it('sanitizes normal canvas imports before IndexedDB and store adoption without mutating input', async () => {
    const input = freeze({ name: 'Ingress canvas', nodes: nodes(), edges: [] });
    const original = structuredClone(input);
    const file = new File([JSON.stringify(input)], 'canvas.thoughtdag.json');
    expect(await importProjectFromFile(file, input)).toBe(true);
    await expectImported('chat');
    expect(input).toEqual(original);
  });

  it('sanitizes paradigm file imports before IndexedDB and store adoption', async () => {
    const input = freeze({ kind: 'thoughtdag-paradigm', version: 1, name: 'Ingress paradigm', nodes: nodes(), edges: [] });
    const file = new File([JSON.stringify(input)], 'score.paradigm.json');
    expect(await parseImportFile(file)).toEqual({ kind: 'own', ok: true });
    await expectImported('paradigm');
    expect(await file.text()).toBe(JSON.stringify(input));
  });

  it.each(['note', 'file', 'link', 'frame'] as const)('sanitizes persisted paradigm %s material when instantiated without fresh import', (kind) => {
    const input = freeze(nodes(kind));
    const original = structuredClone(input);
    const result = instantiateParadigm(input, []);
    expectNodes(result.nodes, false);
    expect(input).toEqual(original);
  });

  it('sanitizes an independently compressed untrusted viewer payload on decode', async () => {
    const input = freeze({ nodes: nodes(), edges: [] });
    const original = structuredClone(input);
    const hash = `#view=${deflateRawSync(JSON.stringify(input)).toString('base64url')}`;
    const result = await decodeViewerHash(hash);
    expectNodes(result.nodes);
    expect(result.edges).toEqual([]);
    expect(input).toEqual(original);
  });
});

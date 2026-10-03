import type { Attachment, ThoughtEdge, ThoughtNode } from '../../../src/types';
import type { FixtureAttachment, FixtureEdge, FixtureGraph, FixtureNode, ResearchFixture, ResearchFixtureFile } from './types';

export type * from './types';

const files = import.meta.glob<ResearchFixtureFile>('./*.json', { eager: true, import: 'default' });

function expandAttachment(att: FixtureAttachment): Attachment {
  return {
    id: att.id,
    name: att.name,
    type: att.type ?? 'text/markdown',
    size: att.content.length,
    content: att.content,
  };
}

function expandNode(node: FixtureNode, index: number, edges: FixtureEdge[]): ThoughtNode {
  const response = node.response ?? '';
  return {
    id: node.id,
    type: 'thought',
    position: { x: 0, y: index * 240 },
    data: {
      question: node.question ?? '',
      response,
      responses: response ? [response] : [],
      responseIndex: 0,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: false,
      tokenCount: 0,
      highlights: [],
      highlightMode: 'off',
      roleMode: 'inherit',
      attachments: (node.attachments ?? []).map(expandAttachment),
      excludedAttachmentIds: node.excludedAttachmentIds ?? [],
      includedAttachmentIds: node.includedAttachmentIds ?? [],
      isRoot: !edges.some((e) => e.target === node.id && !e.isCrossLink),
      isBranch: false,
      ...(node.stepKind ? { stepKind: node.stepKind } : {}),
      ...(node.archived ? { archived: true } : {}),
      ...(node.rolePrompt ? { rolePrompt: node.rolePrompt } : {}),
      ...(node.importSource ? { importSource: node.importSource } : {}),
      ...(node.agentSession ? { agentSession: node.agentSession } : {}),
      ...(node.source ? { source: node.source } : {}),
    },
  };
}

function expandEdge(edge: FixtureEdge): ThoughtEdge {
  return {
    id: `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    ...(edge.isCrossLink ? { data: { isCrossLink: true, ...(edge.contextDepth ? { contextDepth: edge.contextDepth } : {}) } } : {}),
  };
}

function expandGraph(nodes: FixtureNode[], edges: FixtureEdge[]): FixtureGraph {
  return { nodes: nodes.map((n, i) => expandNode(n, i, edges)), edges: edges.map(expandEdge) };
}

export function fixtureNames(): string[] {
  return Object.keys(files).map((path) => path.replace(/^\.\//, '').replace(/\.json$/, '')).sort();
}

/** A research fixture by name, its canvas expanded to the shapes the store holds. */
export function fixture(name: string): ResearchFixture {
  const file = files[`./${name}.json`];
  if (!file) throw new Error(`no research fixture named "${name}" (have: ${fixtureNames().join(', ')})`);
  const { graph: rawGraph, files: workspaceFiles, nativeHistory, ...rest } = file;
  const graph = expandGraph(rawGraph.nodes, rawGraph.edges);
  const edits = file.edits ?? [];
  for (const edit of edits) {
    if (!rawGraph.nodes.some((n) => n.id === edit.nodeId)) throw new Error(`fixture "${name}" edits a node it does not have: ${edit.nodeId}`);
  }
  const edited = edits.length === 0
    ? graph
    : expandGraph(rawGraph.nodes.map((n) => edits.filter((e) => e.nodeId === n.id).reduce<FixtureNode>((acc, e) => ({ ...acc, [e.field]: e.value }), n)), rawGraph.edges);
  return { ...rest, name, graph, edited, files: workspaceFiles ?? {}, nativeHistory: nativeHistory ?? null };
}

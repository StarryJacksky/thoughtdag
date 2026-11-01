// Which answers are out of date, and why. An answer is out of date when
// something it was given has changed since it was written:
//   - a file its run read: the file's content now is not the content frozen
//     for the run (for a mind map, what it says, its layout left out), or
//     the file is lost;
//   - anything else upstream: the fingerprint of what its context is built
//     from (the conversation, the answers and notes wired in) is not the one
//     recorded when it was written.
// A file renamed or moved keeps its identity and its content and marks
// nothing; a card moved or folded marks nothing; nor does a mind map whose
// nodes are only moved about. What changed is named: the person sees which
// file, and which answer upstream.

import type { ThoughtEdge, ThoughtNode, RunSummary } from '../../types';
import { upstreamFingerprint, upstreamParts } from '../../store/context-builder';
import type { ContentHash } from '../workspace/contracts';
import { hashText } from './canonicalize';
import { meaningOf } from './meaning';

export type StaleReason =
  /** a file the run read holds something else now */
  | { nodeId: string; kind: 'input-changed'; inputId: string; fileId: string; name: string }
  /** a file the run read is lost */
  | { nodeId: string; kind: 'input-lost'; inputId: string; fileId: string; name: string }
  /** what the context is built from changed upstream; `via` names the nodes whose part of it changed, where that is known */
  | { nodeId: string; kind: 'upstream-changed'; via: string[] };

/** Nodes that write no answer of their own. */
const NOT_ASKED = new Set(['note', 'file', 'link', 'frame']);

/** The hash of what a mind map says (lib/context/meaning). */
export const meaningHashOf = (text: string): Promise<ContentHash> => hashText(meaningOf(text));

/**
 * What the answer on show was written from: its own run, and the fingerprint of what its context was
 * built from. A version keeps these itself. What the node records beside them (`lastRun`, `lastContext*`)
 * is of the newest version, and stands in only for that one: another version, with nothing of its own,
 * is one nothing is known about, and nobody else's record is said to be its.
 */
export function baselineOf(data: ThoughtNode['data']): { run: RunSummary | undefined; contextHash: string | undefined; contextParts: RunSummary['contextParts'] } {
  if (!data.runs) return { run: data.lastRun, contextHash: data.lastContextHash, contextParts: data.lastContextParts };
  const run = data.runs[data.responseIndex];
  const newest = data.responseIndex === data.responses.length - 1;
  return {
    run,
    contextHash: run?.contextHash ?? (newest ? data.lastContextHash : undefined),
    contextParts: run?.contextParts ?? (newest ? data.lastContextParts : undefined),
  };
}

/** The run each node's answer on show came from. */
export function shownRuns(nodes: ThoughtNode[]): Record<string, RunSummary | undefined> {
  return Object.fromEntries(nodes.map((n) => [n.id, baselineOf(n.data).run]).filter(([, run]) => run));
}

/**
 * Why each answer of the canvas is out of date, if it is. `records` are the runs the answers came
 * from (by default the one on show of each node). What a file holds now is what the canvas knows of it: the
 * revision of the copy on its node, and for a mind map what that copy says.
 */
export function detectStale(graph: { nodes: ThoughtNode[]; edges: ThoughtEdge[] }, records: Record<string, RunSummary | undefined> = shownRuns(graph.nodes)): StaleReason[] {
  const { nodes, edges } = graph;
  const fileNow = new Map<string, NonNullable<ThoughtNode['data']['resourceHint']>>();
  for (const n of nodes) {
    const fileId = n.data.resourceRef?.fileId;
    if (fileId && n.data.resourceHint && !fileNow.has(fileId)) fileNow.set(fileId, n.data.resourceHint);
  }
  const reasons: StaleReason[] = [];
  for (const n of nodes) {
    if (!n.data.response || NOT_ASKED.has(n.data.stepKind ?? '')) continue;
    // an archived answer feeds no context: replaying it would only cost model calls
    if (n.data.archived) continue;
    const own: StaleReason[] = [];
    for (const input of records[n.id]?.inputs ?? []) {
      if (!input.fileId) continue;
      const hint = fileNow.get(input.fileId);
      // no longer on the canvas: what it gave is gone from the context, which the fingerprint sees
      if (!hint) continue;
      const about = { nodeId: n.id, inputId: input.inputId, fileId: input.fileId, name: hint.name };
      if (hint.status === 'missing' || hint.status === 'ambiguous') { own.push({ ...about, kind: 'input-lost' }); continue; }
      if (!hint.revision || hint.revision === input.contentHash) continue;
      if (input.semanticHash) {
        // a mind map: out of date only when what it says changed; not known yet for this revision, not said yet
        if (hint.meaning?.revision !== hint.revision || hint.meaning.hash === input.semanticHash) continue;
      }
      own.push({ ...about, kind: 'input-changed' });
    }
    const { contextHash } = baselineOf(n.data);
    if (contextHash && upstreamFingerprint(n.id, nodes, edges) !== contextHash && own.length === 0) {
      own.push({ nodeId: n.id, kind: 'upstream-changed', via: changedUpstream(n, nodes, edges) });
    }
    reasons.push(...own);
  }
  return reasons;
}

/** The upstream nodes whose part of a node's context is not what it was when its answer was written. */
function changedUpstream(n: ThoughtNode, nodes: ThoughtNode[], edges: ThoughtEdge[]): string[] {
  const then = baselineOf(n.data).contextParts;
  if (!then) return [];
  const now = upstreamParts(n.id, nodes, edges);
  const ids = new Set([...Object.keys(then), ...Object.keys(now)]);
  return [...ids].filter((id) => then[id]?.h !== now[id]?.h);
}

/**
 * The key a node's staleness has now: the fingerprint of its context, and what each file it read
 * holds. A verdict on its staleness (the judge's, or the person's to keep the answer) stands while
 * the key does; anything that changes again asks again.
 */
export function staleKeyOf(n: ThoughtNode, nodes: ThoughtNode[], edges: ThoughtEdge[], reasons: StaleReason[]): string {
  const files = reasons.filter((r) => r.kind !== 'upstream-changed').map((r) => {
    const hint = nodes.find((x) => x.data.resourceRef?.fileId === (r as { fileId: string }).fileId)?.data.resourceHint;
    return `${(r as { fileId: string }).fileId}:${hint?.status}:${hint?.revision}`;
  });
  return [upstreamFingerprint(n.id, nodes, edges), ...files.sort()].join('|');
}

// Feedback lines: how two tasks read each other without a loop.
//
// A writer whose draft a critic reads, and the critic's critique read back
// by the writer: the line that closes that loop is a feedback line. It is a
// reference (dashed) that holds one finished answer of the node it comes
// from, not the live one. So:
//   - what a run reads is fixed when the run starts: the other node
//     answering again changes nothing this node has read;
//   - the other node answering again does not make this one stale (what it
//     read has not changed) and does not run it, by itself or as part of a
//     chain of runs;
//   - this node starting a run (a question, a follow-up, asking again) is a
//     new round: every feedback line it reads moves, then, to the latest
//     finished answer of its other end, and the answer it writes records
//     which one it read.
// A line is a feedback line when it is made: whoever makes a connection
// that would close a loop gets one. The lines that carry live answers stay
// a DAG; a feedback line is never made solid.

import type { ThoughtEdge, ThoughtNode } from '../types';

export const isFeedback = (edge: Pick<ThoughtEdge, 'data'> | undefined): boolean => !!edge?.data?.feedback;

/**
 * The latest of a node's answers that is finished: not one still being
 * written (that is not among its answers yet), and not a failure that was
 * kept as its last version. Null when it has none.
 */
export function latestFinished(node: ThoughtNode): number | null {
  const answers = node.data.responses ?? [];
  let last = answers.length - 1;
  // a run that failed keeps its message as the last version and shows it
  if (node.data.generationFailed && last >= 0 && answers[last] === node.data.response) last -= 1;
  for (let i = last; i >= 0; i--) if (answers[i]?.trim()) return i;
  return null;
}

/** A node as one of its answers shows it: that version's question and answer, whole (nothing of what is marked in the live one). */
export function asOfVersion(node: ThoughtNode, version: number | null): ThoughtNode {
  const response = version === null ? '' : node.data.responses?.[version] ?? '';
  const question = version === null ? node.data.question : node.data.questions?.[version] ?? node.data.question;
  return { ...node, data: { ...node.data, question, response, responseIndex: version ?? -1, highlights: [], highlightMode: 'off' } };
}

/**
 * Whether an edge from `sourceId` into `targetId` would close a loop: the
 * target already reaches the source along lines that carry live answers.
 * Feedback lines do not count: what they carry is fixed.
 */
export function closesLoop(sourceId: string, targetId: string, edges: ThoughtEdge[]): boolean {
  if (sourceId === targetId) return true;
  const seen = new Set<string>([targetId]);
  const queue = [targetId];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== from || isFeedback(edge) || seen.has(edge.target)) continue;
      if (edge.target === sourceId) return true;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return false;
}

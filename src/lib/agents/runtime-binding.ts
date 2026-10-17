// The native session a question could go on in: a mirrored agent session
// whose last turn the question hangs off, in the folder the canvas's agents
// run in, with its record on disk. What the session holds is known from the
// canvas itself: each imported turn keeps its question and answer as they
// were imported (`source`), whatever the canvas has made of them since. A
// turn imported without that is a session whose content is not known.
//
// That a binding exists is necessary for going on in a session, never
// enough: whether the run's context is what the session holds is for
// route-policy to say.

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import type { RuntimeBinding } from '../context/contracts';
import { digestOf } from '../context/canonicalize';
import type { AgentRuntime, ThoughtNode } from '../../types';
import { agentSessionFile } from './agent-runtime';

export interface SessionBinding extends RuntimeBinding {
  /** the turns the session holds, as the canvas gives a conversation: each imported question and answer as imported, oldest first; null where that is not known */
  holds: { role: 'user' | 'assistant'; content: string }[] | null;
  /** the folder the session ran in, when it says */
  cwd: string | null;
}

export type NoBinding = 'no-session' | 'not-the-last-turn' | 'other-folder' | 'no-session-file';

/** The conversation a session's last turn closes, oldest first, by structural parent; null at a merge. */
function chainTo(tail: ThoughtNode, nodes: ThoughtNode[]): ThoughtNode[] | null {
  const { edges } = useStore.getState();
  const chain: ThoughtNode[] = [];
  const seen = new Set<string>();
  for (let at: ThoughtNode | undefined = tail; at; ) {
    if (seen.has(at.id)) return null;
    seen.add(at.id);
    chain.unshift(at);
    const parents = edges.filter((e) => e.target === at!.id && !e.data?.isCrossLink);
    if (parents.length > 1) return null;
    at = parents[0] ? nodes.find((n) => n.id === parents[0].source) : undefined;
  }
  return chain;
}

/** What the session holds, from its turns' imported sources; null when any turn lacks one. */
function holdsOf(chain: ThoughtNode[] | null): SessionBinding['holds'] {
  if (!chain) return null;
  const out: NonNullable<SessionBinding['holds']> = [];
  for (const n of chain) {
    const source = n.data.source;
    if (!source || !n.data.importSource) return null;
    if (source.question) out.push({ role: 'user', content: source.question });
    if (source.response) out.push({ role: 'assistant', content: source.response });
  }
  return out;
}

/**
 * The session a question of `nodeId` could go on in on `runtime`, or why there is none. `cwd` is
 * the folder the run is to run in: a session that ran in another folder is not gone on in.
 */
export async function findBinding(nodeId: string, runtime: AgentRuntime, cwd?: string): Promise<{ binding: SessionBinding | null; reason: NoBinding | null }> {
  const none = (reason: NoBinding) => ({ binding: null, reason });
  const { projects, activeId } = useProjects.getState();
  const ss = projects.find((p) => p.id === activeId)?.sourceSession;
  if (!ss) return none('no-session');
  const { nodes, edges } = useStore.getState();
  const parents = edges.filter((e) => e.target === nodeId && !e.data?.isCrossLink);
  const parent = parents.length === 1 ? nodes.find((n) => n.id === parents[0].source) : undefined;
  if (!parent) return none('no-session');
  const entries = [ss, ...(ss.chapters ?? []), ...(ss.branches ?? [])].filter((e) => e.runner === runtime && e.sessionId);
  const entry = entries.find((e) => e.tailNodeId === parent.id);
  if (!entry) return none(parent.data.importSource?.runner === runtime ? 'not-the-last-turn' : 'no-session');
  const sessionCwd = parent.data.agentSession?.cwd ?? parent.data.importSource?.cwd ?? null;
  if (cwd && sessionCwd && sessionCwd !== cwd) return none('other-folder');
  const sessionPath = await agentSessionFile(runtime, entry.sessionId, parent);
  if (!sessionPath) return none('no-session-file');
  const holds = holdsOf(chainTo(parent, nodes));
  return {
    binding: {
      bindingId: `binding:${runtime}:${entry.sessionId}`,
      targetId: nodes.find((n) => n.id === nodeId)?.data.target?.targetId ?? 'unbound',
      connectionRef: `runtime:${runtime}`,
      runtime,
      threadId: null,
      sessionId: entry.sessionId,
      sessionPath,
      lastCompletedTurnId: parent.data.importSource?.itemIds.at(-1) ?? null,
      // nothing here watches the native session: its state is not known
      nativeState: { status: 'unknown', observedAt: null, evidence: 'none' },
      prefixDigest: holds ? await digestOf(holds) : null,
      configDigest: null,
      // a mirrored session was written by another program first: this application is not its one writer
      ownership: 'external',
      holds,
      cwd: sessionCwd,
    },
    reason: null,
  };
}

/** The session a question of `nodeId` could go on in, or null. */
export async function bindingFor(nodeId: string, runtime: AgentRuntime, cwd?: string): Promise<SessionBinding | null> {
  return (await findBinding(nodeId, runtime, cwd)).binding;
}

// The native session a question could go on in: a mirrored agent session
// whose last turn the question hangs off, in the folder the canvas's agents
// run in, with its record on disk. What the session holds is known from what
// was imported of it, not from the canvas's wiring, which can be edited: its
// turns are the nodes that say they are of this session (`importSource`), in
// the order they came onto the canvas, each with its question and answer as
// they were imported (`source`), whatever the canvas has made of them since;
// and the ledger says how many there are. Cutting a wire or deleting a turn
// changes what the run is given, never what the session holds. A session with
// a turn imported without that, or with fewer turns on the canvas than it
// holds, is a session whose content is not known. Its images are known the
// same way: from what the session's own record said of each turn when it was
// imported, never from the attachments the canvas shows now, which can be
// taken off and were never all brought over.
//
// That a binding exists is necessary for going on in a session, never
// enough: whether the run's context is what the session holds is for
// route-policy to say.

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import type { RuntimeBinding } from '../context/contracts';
import { digestOf } from '../context/canonicalize';
import type { AgentRuntime, NativeImages, ThoughtNode } from '../../types';
import { agentSessionFile } from './agent-runtime';

export interface SessionBinding extends RuntimeBinding {
  /** the turns the session holds, as the canvas gives a conversation: each imported question and answer as imported, oldest first; null where that is not known */
  holds: { role: 'user' | 'assistant'; content: string; nodeId: string }[] | null;
  /** a turn of the session shows an image on the canvas: the words above do not say what the session has of it */
  holdsImages: boolean;
  /** what the session's own record said of the images sent into its turns: any that did not say is not known */
  nativeImages: NativeImages;
  /** the folder the session ran in, when it says */
  cwd: string | null;
}

export type NoBinding = 'no-session' | 'not-the-last-turn' | 'other-folder' | 'no-session-file';

/** A session's turns on the canvas, oldest first. */
const turnsOf = (sessionId: string, runtime: AgentRuntime, nodes: ThoughtNode[]) => nodes.filter((n) => n.data.importSource?.sessionId === sessionId && n.data.importSource.runner === runtime);

/** What the session holds, from its turns' imported sources; null when any is missing, on the canvas or in what was imported. */
function holdsOf(turns: ThoughtNode[], count: number): SessionBinding['holds'] {
  if (turns.length !== count) return null;
  const out: NonNullable<SessionBinding['holds']> = [];
  for (const n of turns) {
    const source = n.data.source;
    if (!source) return null;
    if (source.question) out.push({ role: 'user', content: source.question, nodeId: n.id });
    if (source.response) out.push({ role: 'assistant', content: source.response, nodeId: n.id });
  }
  return out;
}

/** What the session's turns said, when they were imported, of the images sent into them. */
function nativeImagesOf(turns: ThoughtNode[]): NativeImages {
  const said = turns.map((n) => n.data.source?.images);
  if (said.includes('present')) return 'present';
  return said.every((images) => images === 'none') ? 'none' : 'unknown';
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
  const turns = turnsOf(entry.sessionId, runtime, nodes);
  const holds = holdsOf(turns, entry.importedCount);
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
      prefixDigest: holds ? await digestOf(holds.map(({ role, content }) => ({ role, content }))) : null,
      configDigest: null,
      // a mirrored session was written by another program first: this application is not its one writer
      ownership: 'external',
      holds,
      holdsImages: turns.some((n) => (n.data.attachments ?? []).some((a) => a.type.startsWith('image/'))),
      nativeImages: nativeImagesOf(turns),
      cwd: sessionCwd,
    },
    reason: null,
  };
}

/** The session a question of `nodeId` could go on in, or null. */
export async function bindingFor(nodeId: string, runtime: AgentRuntime, cwd?: string): Promise<SessionBinding | null> {
  return (await findBinding(nodeId, runtime, cwd)).binding;
}

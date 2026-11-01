import type { StateCreator } from 'zustand';
import { shownStaleIds } from '../../lib/stale-judge';
import type { ThoughtData } from '../../types';
import { buildContext } from '../context-builder';
import { runNodeGeneration, autoRunCounts, freezeForRun } from '../streaming';
import { toast, updateToast, useUiStore } from '../../lib/ui-store';
import { t, fmt } from '../../i18n';
import type { StoreState, EvaluatorSlice, RerunOutcome } from '../types';
import { writesFiles } from '../../lib/agents/target-model';
import { condenseGuard } from '../../lib/condense-guard';

// Batch-replay cancellation flag — one replay at a time, module-scoped.
let replayAborted = false;

// ── Primitives, not features ─────────────────────────────────────
// A "reviewer" is NOT a special node type. It is an ordinary node composed
// from two generic primitives:
//   • autoRerun  (node) — regenerate in place whenever an upstream ancestor
//                          finishes generating (versions accumulate)
//   • followsTip (edge) — the edge keeps sliding forward to the newest node
//                          of the thread it points from
// attachEvaluator below is merely a PRESET that combines them with a
// critic role. Any node can use either primitive for other purposes
// (live summaries, running translations, ...).

/** autoRerun with legacy fallback: old graphs stored evaluatorTrigger. */
export function isAutoRerun(data: ThoughtData): boolean {
  return data.autoRerun ?? data.evaluatorTrigger === 'auto';
}

/** Which AI a task is set to run on: its target as it is now, or its bare model. */
export const taskIdentity = (data: ThoughtData): string => (data.target ? `${data.target.targetId}@${data.target.revision}` : `model:${data.model ?? ''}`);

export const createEvaluatorSlice: StateCreator<StoreState, [], [], EvaluatorSlice> = (set, get) => ({
  /**
   * Regenerate a node IN PLACE from its incoming edges (standard context
   * walk — same one every node uses), appending to its version history.
   * This is the generic engine behind auto-rerun; also useful manually.
   * Resolves with how it went: only `answered` is a new answer.
   *
   * An automatic run never sets off an agent that may write files: that is
   * looked at here, as it starts and again once its files are frozen, since
   * the person can change the task's AI during either wait. `mayWrite` is for
   * what the person set going themselves (a feedback line's rounds, a
   * paradigm). `expect` is what the caller planned this run for: another AI
   * than that is not what was planned, and it does not start.
   */
  rerunNode: async (nodeId: string, opts?: { auto?: boolean; mayWrite?: boolean; expect?: string }): Promise<RerunOutcome> => {
    const notAllowed = (data: ThoughtData): RerunOutcome | null => {
      if (opts?.expect !== undefined && taskIdentity(data) !== opts.expect) return { status: 'needs-approval' };
      return opts?.auto && !opts.mayWrite && writesFiles(data) ? { status: 'needs-approval' } : null;
    };
    if (condenseGuard()) return { status: 'not-sent' };
    const { nodes } = get();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return { status: 'gone' };
    if (node.data.isLoading) return { status: 'busy' };
    const refused = notAllowed(node.data);
    if (refused) return refused;
    get().pushHistory();
    // In-place regenerate works for anything with a question — roots included
    // (their context is just role + question). Material/frames never generate.
    if (!node.data.question) return { status: 'not-sent' };
    if (['note', 'file', 'link', 'frame'].includes(node.data.stepKind ?? '')) return { status: 'not-sent' };

    // what the run comes to, as the one pipeline reports it; no report means nothing was written
    let ended: RerunOutcome = { status: 'not-sent' };
    const onEnded = (how: 'completed' | 'failed' | 'cancelled', versionIndex: number | null) => {
      ended = how === 'completed' && versionIndex !== null ? { status: 'answered', versionIndex } : { status: how === 'cancelled' ? 'cancelled' : 'failed' };
    };

    // Digest nodes regenerate through the digest prompt against the source
    // attachment's full extracted text — not the context walk (the walk
    // would summarize the summary once versions accumulate).
    if (node.data.digestOf) {
      const material = nodes.find((n) => n.data.attachments?.some((a) => a.id === node.data.digestOf));
      const att = material?.data.attachments?.find((a) => a.id === node.data.digestOf);
      if (!att?.extractedText?.trim()) return { status: 'not-sent' };
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, isLoading: true, isCollapsed: false, response: '' } } : n
        ),
      }));
      await runNodeGeneration(set, get, nodeId, {
        question: node.data.question,
        messages: [{ role: 'user', content: `${t('content.digestPrompt')}\n\n[Material: ${att.name}]\n${att.extractedText.slice(0, 120000)}` }],
        versionMode: 'append',
        sources: material ? [{ layer: 'material', nodeId: material.id, attachmentId: att.id, part: 'attachment' }] : [],
        autoChain: opts?.auto,
        onEnded,
      });
      return ended;
    }

    // A run in place starts a round: feedback lines into what it reads move to
    // their latest finished answers (lib/feedback), before the context is built.
    get().advanceFeedback(nodeId);
    // the files it reads are saved and frozen before its context is built (lib/context/prepare-run)
    if (!(await freezeForRun(set, get, nodeId))) return { status: 'not-sent' };
    // the wait is over: the task may have gone with the canvas, or been given another AI meanwhile
    const nodeNow = get().nodes.find((n) => n.id === nodeId);
    if (!nodeNow) return { status: 'gone' };
    const refusedNow = notAllowed(nodeNow.data);
    if (refusedNow) return refusedNow;
    const { nodes: nodesNow, edges: edgesNow } = get();
    // Standard context with this node's own Q&A blanked out (same pattern
    // as editQuestion) — ancestors, roles, highlights, attachments all
    // resolve exactly like any other generation.
    const ctx = buildContext(
      nodeId,
      nodesNow.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, question: '', response: '' } } : n)),
      edgesNow,
      undefined,
      node.data.excludedAttachmentIds,
      node.data.includedAttachmentIds,
      shownStaleIds(get()),
    );
    const messages = ctx.messages;
    const appliedRole = messages.find((m) => m.role === 'system')?.content || undefined;
    messages.push({ role: 'user', content: node.data.question });

    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, appliedRole, isLoading: true, isCollapsed: false, response: '' } } : n
      ),
    }));

    await runNodeGeneration(set, get, nodeId, {
      question: node.data.question,
      messages,
      images: ctx.images,
      versionMode: 'append',
      sources: ctx.sources,
      imageSources: ctx.imageSources,
      autoChain: opts?.auto,
      onEnded,
    });
    return ended;
  },

  /**
   * Batch replay: re-run every node that was stale AT CONFIRMATION TIME,
   * in dependency order (a node runs only after all its stale parents
   * finished; lib/context/replay-plan). The snapshot rule keeps the
   * confirm-dialog count honest and stops the run from chasing
   * reference-edge contagion — nodes that turn stale DURING the replay keep
   * their badges for the human. An agent that may write files is not run:
   * it waits for the person, and so does what reads it.
   */
  replayStale: async () => {
    replayAborted = false;
    get().recomputeStaleness();
    // the same set the chip counts and the dialog prices: the stale nodes minus the judge's dismissals
    const snapshot = shownStaleIds(get());
    if (snapshot.length === 0) return;
    autoRunCounts.clear(); // one user action = one auto-rerun wave
    const { planReplay, runReplay } = await import('../../lib/context/replay-plan');
    const plan = planReplay(snapshot, 'target-only');
    const total = plan.steps.length;
    const progress = toast('info', fmt(t('replay.progress'), { done: 0, total }), 0, {
      label: t('replay.stop'),
      run: () => { replayAborted = true; },
    });
    let done = 0;
    let waiting: string[] = [];
    let failed = 0;
    try {
      const outcome = await runReplay(plan, {
        stopped: () => replayAborted,
        onProgress: (ran) => { done = ran.length; updateToast(progress, fmt(t('replay.progress'), { done, total })); },
      });
      waiting = outcome.waiting;
      failed = outcome.failed?.length ?? 0;
    } finally {
      useUiStore.getState().dismissToast(progress);
      get().recomputeStaleness();
      toast('success', replayAborted
        ? fmt(t('replay.stopped'), { done, total })
        : fmt(t('replay.done'), { done }));
      if (failed > 0) toast('error', fmt(t('replay.failed'), { n: failed }), 9000);
      if (waiting.length > 0) toast('info', fmt(t('replay.waiting'), { n: waiting.length }), 9000);
    }
  },

  setAutoRerunRounds: (nodeId: string, rounds: number) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, autoRerunRounds: rounds } } : n
      ),
    }));
  },

  setAutoRerun: (nodeId: string, enabled: boolean) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, autoRerun: enabled, evaluatorTrigger: undefined } }
          : n
      ),
    }));
  },

  // NOTE: the old attachEvaluator preset dissolved into fanOut(follow: true)
  // — a reviewer is N=1 perspectives with the "keep reviewing" run policy.
});

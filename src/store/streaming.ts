import type { StoreApi } from 'zustand';
import { partitionContext, walkUpAncestors } from '../lib/graph';
import { isFeedback } from '../lib/feedback';
import { upstreamFingerprint, upstreamParts, recordParts, type MessageSource } from './context-builder';
import { sha256Hex, canonicalStringify } from '../lib/context-bundle';
import { pruneHighlights } from '../lib/highlight-match';
import { llmCall, llmCallStream, type ContextMessage, type ImageAttachment } from '../lib/api';
import { harnessOutbound, claimHarnessTurn, stampHarnessTurn } from '../lib/atlas/dsh-bridge';
import { agentOutbound, adoptAgentTurn, claimAgentTurn, isAgentModel } from '../lib/agents/agent-runtime';
import { countTokens, activeSummary } from '../utils';
import { toast, useUiStore } from '../lib/ui-store';
import { getModelsOnce, reconcileModelId } from '../lib/use-models';
import { checkSend, createTarget, describeTarget, RESEARCH_POLICY, templateFor, writesFiles } from '../lib/agents/target-model';
import { contextLengthFor } from '../lib/runtime-providers';
import { memoryContextBlock, judgeMemory } from '../lib/memory';
import { fetchRecallItems, recallContextBlock } from '../lib/recall';
import { fillCards } from '../lib/recall-cards';
import { judgeAvailable, decideTakeaway } from '../lib/judge';
import { buildLadder, ladderModelFor, inFlight, levelText, type LadderOptions } from '../lib/ladder';
import { ladderContextFor } from '../lib/ladder-context';
import type { Ladder } from '../types';
import { t, fmt } from '../i18n';
import { isViewerMode } from '../lib/viewer';
import type { Reference } from '../types';
import type { StoreState } from './types';
import { sanitizeReferenceUrls } from '../lib/outbound-links';
import type { RunEnvelope } from '../lib/context/contracts';
import type { PolicyBlock } from '../lib/context/policy';
import type { FrozenInputs, RunBlocked as RunBlockedError } from '../lib/context/prepare-run';

// Background summary generation — fire and forget. Display channel ONLY:
// the human reads the summary on the map, the model always reads the full
// text. Short answers fit on the card as-is and skip the call.
// The judge sees the MAP itself as context: the takeaway lines already on
// the ancestor path (with their tags). That keeps terminology aligned
// across plaques and classifications aware of what the thinking already
// ruled out or decided — the lines read as one progression, not islands.
export const SUMMARY_MIN_CHARS = 400;
export function generateSummary(nodeId: string, question: string, response: string, setSummary: (id: string, summary: string, forResponse: string, type?: string, topic?: string, confidence?: number, conclusive?: number) => void, mapLines?: string[], ladder?: { model?: string; set: (id: string, forResponse: string, ladder: Ladder | null) => void } & LadderOptions) {
  if (response.length < SUMMARY_MIN_CHARS) return;
  // One rule for who summarises: the model that answered when it is an API model,
  // the default background model for agent answers (an agent id would otherwise
  // be sent to the plain chat route).
  const who = ladderModelFor(ladder?.model);
  // With a judge, the MOVE (rule-out, decision, pivot, open, plain step) is a
  // typed decision with a probability; the model's own tag stands in when
  // no judge answers. The takeaway line is still the model's — a judge
  // does not write.
  const judged: Promise<{ kind: string; p: number; conclusive: number } | null> = judgeAvailable()
    ? decideTakeaway(question, response).then((d) => ({ kind: d.kind, p: d.p, conclusive: d.conclusive })).catch(() => null)
    : Promise.resolve(null);
  // target the version this summary was computed FOR, not whichever version the user has navigated to since
  const settle = (text: string, topic: string | undefined, modelType: string) => judged.then((j) => {
    if (j) setSummary(nodeId, text, response, j.kind, topic, j.p, j.conclusive);
    else setSummary(nodeId, text, response, modelType, topic);
  });
  // The plain line on its own: the route from before the ladder, still used when no
  // ladder is wanted, and as the fallback when the ladder call came back unusable.
  const mapBlock = mapLines && mapLines.length > 0
    ? `Takeaway lines already on the map, along this node's ancestor path (oldest first):\n${mapLines.join('\n')}\n\nUse those lines ONLY to align terminology and avoid repeating them. Classify this exchange's epistemic move on its own merits, independent of the lines above.\n\n`
    : '';
  const viaLine = (m: string | undefined) => llmCall([
    { role: 'user', content: question },
    { role: 'assistant', content: response },
    { role: 'user', content: `${mapBlock}Compress the above exchange for a map plaque. Output exactly ONE line in the format: TAG | topic | takeaway\n\nTAG classifies the epistemic move: INSIGHT (learned or confirmed something), RULEOUT (killed a hypothesis or option), DECISION (chose among options), PIVOT (reframed the question or direction), OPEN (raised a new unresolved question). Most exchanges are INSIGHT.\n\ntopic: the subject as a bare noun phrase. Hard limit: 6 characters for CJK languages, 14 characters otherwise.\n\ntakeaway: the conclusion, stated first and plainly, as one clause. Hard limit: 18 characters for CJK languages, 40 characters otherwise — it must fit whole on a small plaque, never truncated. A reader scanning many such lines should see how the thinking progressed.\n\nBoth in the same language as the question. Never use dash characters (—, –, -) inside topic or takeaway; use commas or colons instead. Output only that one line.` },
  ], undefined, m, { fast: true }).then((raw) => {
    // "TAG | topic | takeaway" — older models or drift may still answer
    // "TAG: text"; unknown/missing tags degrade to the unmarked default
    const line = raw.trim().split('\n')[0].trim();
    const three = line.match(/^(INSIGHT|RULEOUT|DECISION|PIVOT|OPEN)\s*[|｜:：]\s*([^|｜]+?)\s*[|｜]\s*(.+)$/is);
    const two = three ? null : line.match(/^(INSIGHT|RULEOUT|DECISION|PIVOT|OPEN)[:：|｜]\s*(.+)$/is);
    const modelType = (three?.[1] ?? two?.[1])?.toLowerCase() ?? 'insight';
    const topic = three ? three[2].trim() : undefined;
    const text = three ? three[3].trim() : (two ? two[2].trim() : line);
    return settle(text, topic, modelType);
  });
  if (!ladder) { void who.then(viaLine).catch(() => {}); return; }
  // The zoom ladder (lib/ladder.ts): ONE call writes topic, takeaway and brief with
  // the thread in view and points at the evidence sentences. Its takeaway IS the
  // plaque's line, so no second line is written; when it lands, setLadder also
  // rewrites the plain summary and topic so the plaque and the ladder never
  // disagree. No API model at all (agent-only setups): no call, the plaque keeps
  // its local ladder.
  inFlight.add(nodeId);
  void who.then(async (m) => {
    if (!m) return;
    const l = await buildLadder(question, response, m, { context: ladder.context, thread: ladder.thread, parentAnswer: ladder.parentAnswer }).catch(() => null);
    ladder.set(nodeId, response, l);
    if (l) await settle(levelText(l, 1), levelText(l, 0), l.move ?? 'insight');
    else await viaLine(m);
  }).catch(() => {}).finally(() => inFlight.delete(nodeId));
}

/** The map lines a fresh takeaway should align with: the ancestor path's
    tagged takeaways (nearest 8), prefixed by the map's opening question. */
export function collectMapLines(nodeId: string, nodes: StoreState['nodes'], edges: StoreState['edges']): string[] {
  const { ordered } = walkUpAncestors(nodeId, nodes, edges);
  const TAG: Record<string, string> = { ruleout: 'RULEOUT', decision: 'DECISION', pivot: 'PIVOT', open: 'OPEN' };
  const lines = ordered
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      const s = activeSummary(n.data);
      if (!s) return null;
      const type = n.data.summaryTypes?.[n.data.responseIndex];
      return `- ${type && TAG[type] ? `${TAG[type]}: ` : ''}${s}`;
    })
    .filter((l): l is string => !!l)
    .slice(-8);
  const root = ordered.find((n) => n.data.isRoot && n.id !== nodeId);
  if (root?.data.question) lines.unshift(`Opening question of the map: ${root.data.question.slice(0, 200)}`);
  return lines;
}

// Track active AbortControllers per node
export const activeAbortControllers = new Map<string, AbortController>();

// Generation sequence per node: a new generation SUPERSEDES any in-flight
// one (its stream is aborted and every late write it still attempts is
// dropped). Without this, edit-question + rerun raced two streams into the
// same node — alternating reasoning, clobbered answers.
const generationSeq = new Map<string, number>();

// Auto-chain budget: how many times each autoRerun node has fired since the
// last MANUAL action. A fresh user action resets all counters, so budgets
// mean "auto rounds per user action" — and loops (writer->critic->writer)
// terminate deterministically when every node exhausts its rounds.
export const autoRunCounts = new Map<string, number>();

type Set = StoreApi<StoreState>['setState'];
type Get = StoreApi<StoreState>['getState'];

// ── runs, frozen before they are sent (lib/context/prepare-run, plan §7) ──

/** What a run's entry froze before it built the context, kept for the run to be prepared from. */
const frozenFor = new Map<string, FrozenInputs>();

/** What leaving was stopped for: the request about to leave was not the one prepared. */
class DispatchRefused extends Error {
  readonly part: 'messages' | 'images' | 'model' | 'tools';
  constructor(part: 'messages' | 'images' | 'model' | 'tools') { super(`the request about to leave is not the one prepared (${part})`); this.part = part; }
}

/** A run that was not sent: the task says why, and nothing is recorded as asked or answered. */
function markNotSent(set: Set, get: Get, nodeId: string, message: string): void {
  activeAbortControllers.delete(nodeId);
  toast('error', message, 9000);
  set((state) => ({
    nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, response: message, isLoading: false, restreaming: undefined, reasoning: undefined, generationFailed: true } } : n)),
  }));
  get().pushHistory();
}

/** Why a run set to research was not sent: what it cannot be held to, in the person's words. */
function policyText(blocked: readonly PolicyBlock[]): string {
  const parts = [...new Set(blocked.map((b) => t(`run.policyPart.${b}`)))];
  return fmt(t('run.policyBlocked'), { what: parts.join(t('run.policyJoin')) });
}

/** Why a run could not be prepared, in the person's words, naming the file. */
function blockedText(get: Get, e: RunBlockedError): string {
  const name = (e.nodeId ? get().nodes.find((n) => n.id === e.nodeId)?.data.resourceHint?.name : undefined) ?? '';
  return fmt(t(`run.blocked.${e.reason}`), { name, why: e.message });
}

/**
 * Freeze the files a run of `nodeId` reads, before its context is built:
 * typing not yet saved is saved, each file is frozen into a snapshot, and
 * the canvas's copies are set to what was frozen. Resolves false, with the
 * task saying why, when the run cannot be given its files as they are.
 */
export async function freezeForRun(set: Set, get: Get, nodeId: string): Promise<boolean> {
  const { freezeInputs, RunBlocked } = await import('../lib/context/prepare-run');
  try {
    frozenFor.set(nodeId, await freezeInputs(nodeId, { apply: true }));
    return true;
  } catch (e) {
    markNotSent(set, get, nodeId, e instanceof RunBlocked ? blockedText(get, e) : fmt(t('run.notPrepared'), { why: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

/**
 * The one streaming pipeline for filling a node's response:
 * register an AbortController (Stop button) → stream chunks into
 * `data.response` → on completion write response/versions/tokenCount and
 * collapse → pushHistory → kick off the background summary.
 * On abort or error, whatever streamed so far is kept.
 */
export async function runNodeGeneration(
  set: Set,
  get: Get,
  nodeId: string,
  opts: {
    question: string;
    messages: ContextMessage[];
    images?: ImageAttachment[];
    /** append = keep earlier responses as versions (evaluator critique history). */
    versionMode?: 'replace' | 'append';
    /** True when fired by the auto-refresh chain; manual generations reset all budgets. */
    autoChain?: boolean;
    /** Extra work after the final state write, before pushHistory (e.g. re-layout). */
    onSuccess?: (response: string) => void;
    /** where each context message came from — the members of this request */
    sources?: MessageSource[];
    /** where each image came from, parallel to `images` */
    imageSources?: { nodeId: string; attachmentId: string }[];
  },
): Promise<void> {
  // Read-only viewer: no generation whatsoever — belt-and-braces behind the
  // hidden UI (a missed button must still be inert).
  if (isViewerMode) return;
  const { question, images, onSuccess, versionMode = 'replace' } = opts;
  let { messages } = opts;
  // where each message came from, kept in step with the messages as memory and recall are put in
  const sources: (MessageSource | undefined)[] = [...(opts.sources ?? [])];
  // the run as prepared (below), and whether its images were left out for a model that cannot see them
  let envelope: RunEnvelope | null = null;
  let imagesDropped = false;
  // its record (lib/context/run-records): written once it is prepared, and again once it has ended
  let runRecords: typeof import('../lib/context/run-records') | null = null;
  let preparedAt = '';
  const endRecord = (state: 'completed' | 'failed' | 'cancelled', output: { versionIndex: number; chars: number } | null = null) => {
    if (!envelope || !runRecords) return;
    const session = get().nodes.find((n) => n.id === nodeId)?.data.agentSession;
    void runRecords.persistRun(envelope, runRecords.recordRun(envelope, {
      state, output, preparedAt, endedAt: new Date().toISOString(),
      nativeBinding: session ? { runtime: session.runtime, sessionId: session.sessionId ?? null } : null,
    }));
  };
  if (!opts.autoChain) autoRunCounts.clear(); // a fresh user action starts a new wave
  // Supersede: abort any generation already running on this node; its late
  // callbacks are dropped via the sequence check below.
  activeAbortControllers.get(nodeId)?.abort();
  const myGen = (generationSeq.get(nodeId) ?? 0) + 1;
  generationSeq.set(nodeId, myGen);
  const isCurrent = () => generationSeq.get(nodeId) === myGen;
  const abortController = new AbortController();
  activeAbortControllers.set(nodeId, abortController);
  // which answer each feedback line into this run holds: what the context was built with, kept with the answer
  const feedbackRead: Record<string, { source: string; version: number | null }> = {};
  for (const ref of partitionContext(nodeId, get().nodes, get().edges).references) {
    if (ref.edge.data?.feedback) feedbackRead[ref.edge.id] = { source: ref.edge.source, version: ref.edge.data.feedback.version };
  }

  // A retry is starting — clear any previous failure flag and reasoning
  // buffer, and mark the old response as awaiting replacement (the canvas
  // shows the live thinking instead of the stale text while it streams).
  set((state) => ({
    nodes: state.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, generationFailed: undefined, reasoning: undefined, restreaming: n.data.response ? true : undefined } }
        : n
    ),
  }));

  let references: Reference[] | undefined;

  // Model provenance: pinned override, else the global pick, else the
  // server default. A pin that isn't reachable here (imported canvas,
  // revoked key) reconciles to the same family locally, or falls back to
  // the global pick — SAID OUT LOUD and recorded as what actually ran,
  // never silently mismatched between execution and provenance.
  //
  // A task that is BOUND to an AI (data.target, lib/agents/targets.ts) is
  // different from a bare pin: it runs on that AI or not at all. Its model
  // is never remapped to another provider's and never dropped for the
  // global pick; when it cannot be reached the run stops and says so.
  const boundTarget = get().nodes.find((n) => n.id === nodeId)?.data.target;
  const pinnedRaw = boundTarget?.model ?? get().nodes.find((n) => n.id === nodeId)?.data.model;
  let pinnedModel = pinnedRaw;
  const modelData = await getModelsOnce();
  const serverDefaultModel: string | null = modelData?.default ?? null;
  const boundCheck = boundTarget ? checkSend({ target: boundTarget }, { models: modelData?.models ?? [], serverDefault: serverDefaultModel }) : { ok: true as const };
  if (!boundCheck.ok) {
    if (!isCurrent()) return;
    activeAbortControllers.delete(nodeId);
    const model = boundTarget!.model;
    toast('error', fmt(t('target.unavailable'), { m: describeTarget(boundTarget!).label }), 9000);
    // nothing was asked and nothing answered: no version, no provenance, only why
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, response: fmt(t('target.unavailableAnswer'), { m: model }), isLoading: false, restreaming: undefined, reasoning: undefined, generationFailed: true } } : n)),
    }));
    get().pushHistory();
    return;
  }
  if (!boundTarget && pinnedRaw && modelData && modelData.models.length > 0) {
    const r = reconcileModelId(pinnedRaw, modelData.models);
    if (r !== pinnedRaw) {
      pinnedModel = r ?? undefined;
      toast('info', fmt(t(r ? 'node.pinnedModelRemapped' : 'node.pinnedModelUnavailable'), r ? { m: pinnedRaw, r } : { m: pinnedRaw }), 7000);
    }
  }

  // Vision reroute / image fallback report who actually answered — that is
  // what generatedBy must record (execution and provenance never diverge).
  let actualModel: string | undefined;
  let gatewaySearched = false;
  // Inside DeepSeek Harness a generation runs as a real dsh turn: the bridge
  // reports which session it ran in and the turn it created, so this node can
  // become that turn's mirror (and the live mirror not append it again).
  // Resolved ONCE, here: the picker may change while this node runs, and the
  // node must record what it was asked with, not what the picker says later
  const requestedModel = pinnedModel ?? useUiStore.getState().selectedModel ?? serverDefaultModel ?? undefined;
  // No model anywhere, and the list of models is known: nothing is sent (it would go out naming none, for the
  // server to pick one by itself), and nothing is recorded as asked or answered. Every way a run starts comes
  // through here: a question, a follow-up, a rerun in place or by itself, a sibling.
  if (!requestedModel && modelData) {
    if (!isCurrent()) return;
    activeAbortControllers.delete(nodeId);
    toast('error', t('target.noModelSent'), 9000);
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, response: t('target.noModelAnswer'), isLoading: false, restreaming: undefined, reasoning: undefined, generationFailed: true } } : n)),
    }));
    get().pushHistory();
    return;
  }
  // A task with no target yet is bound to what it runs on now, with the
  // global settings as they are now: the defaults are a template for new
  // targets, and whatever changes in them later is not this task's.
  let runTarget = boundTarget;
  if (requestedModel && !boundTarget) {
    const made = createTarget(templateFor(requestedModel));
    runTarget = made;
    set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, model: requestedModel, target: made } } : n)) }));
  }
  // The model and its effort are decided here, together, once: a change to the task's AI while the run is
  // still being prepared (its guard, its materials) is the next run's, and never half of this one's.
  const runEffort = runTarget && runTarget.model === requestedModel ? (runTarget.effort ?? null) : undefined;
  const harnessRoute = await harnessOutbound(nodeId, requestedModel);
  const agentRoute = harnessRoute ? undefined : await agentOutbound(requestedModel, nodeId);
  let harnessSession: string | undefined;
  let harnessTurn: { session: string; turn: number | null; userMessageId: string | null; seq: number | null } | null = null;
  // the turn is claimed the moment the bridge names it (mid-generation), so a
  // live sweep firing while the agent works does not append it a second time
  let harnessClaim: Promise<boolean> | null = null;

  const writeFinal = (response: string, failed = false, ended: 'completed' | 'failed' | 'cancelled' = failed ? 'failed' : 'completed') => {
    if (!isCurrent()) return; // superseded: a newer generation owns this node
    const tokenCount = countTokens(question + response);
    let versionWritten: number | null = null;
    const modelUsed = actualModel ?? requestedModel;
    get().logEvent('generate', nodeId, { chars: response.length, ...(modelUsed ? { model: modelUsed } : {}), ...(failed ? { failed: true } : {}) });
    // Provenance: fingerprint what this answer depended on, AT completion —
    // the staleness pass compares this against the live upstream fingerprint.
    const contextHash = upstreamFingerprint(nodeId, get().nodes, get().edges);
    const contextParts = recordParts(upstreamParts(nodeId, get().nodes, get().edges));
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        // keep (response, generatedBy, reasoning, generatedAt, editedAt) tuples aligned through the empty-filter.
        // A FAILED replace also keeps them: the failure placeholder must not
        // wipe real earlier versions (the failure banner offers switching
        // back). Stale placeholders from earlier failed rounds are dropped
        // so repeated retries don't stack failure entries.
        const failText = new Set([t('node.failedPlaceholder'), t('node.emptyResponse')]);
        const kept = versionMode === 'append' || failed
          ? n.data.responses.map((r, i) => ({ r, q: n.data.questions?.[i], by: n.data.generatedBy?.[i], rs: n.data.reasonings?.[i], at: n.data.generatedAts?.[i], ed: n.data.editedAts?.[i], gw: n.data.gatewaySearches?.[i], ef: n.data.generatedEfforts?.[i], rn: n.data.runs?.[i] })).filter(({ r }) => r && !(failed && failText.has(r)))
          : [];
        const now = new Date().toISOString();
        const responses = [...kept.map(({ r }) => r), response];
        // the (question, answer) pair rail: editQuestion pinned old wordings
        // already; anything still absent shared the current wording
        const questions = [...kept.map(({ q }) => q ?? n.data.question), n.data.question];
        const generatedBy = [...kept.map(({ by }) => by), modelUsed];
        const gatewaySearches = [...kept.map(({ gw }) => gw), gatewaySearched || undefined];
        // the effort this version ran at: only an agent turn has one, from the run's own record
        const generatedEfforts = [...kept.map(({ ef }) => ef), (isAgentModel(modelUsed) && n.data.agentSession?.effort) || undefined];
        const reasonings = [...kept.map(({ rs }) => rs), n.data.reasoning || undefined];
        const generatedAts = [...kept.map(({ at }) => at), now];
        const editedAts = [...kept.map(({ ed }) => ed), undefined];
        // the run each version came from: an earlier answer still finds what it was given (lib/context/run-records)
        const summary = envelope && runRecords ? runRecords.summaryOf(envelope, imagesDropped) : undefined;
        const runs = [...kept.map(({ rn }) => rn), summary];
        versionWritten = responses.length - 1;
        return { ...n, data: { ...n.data, response, responses, questions, generatedBy, gatewaySearches, generatedEfforts, reasonings, generatedAts, editedAts, runs: runs.some(Boolean) ? runs : undefined, reasoning: undefined, restreaming: undefined, pendingApprovals: undefined, agentTrace: undefined, responseIndex: responses.length - 1, isLoading: false, tokenCount, generationFailed: failed || undefined, references, highlights: pruneHighlights(n.data.highlights, response), lastContextHash: contextHash, lastContextParts: contextParts, lastFeedback: Object.keys(feedbackRead).length > 0 ? feedbackRead : undefined, lastGeneratedAt: now,
          // the run this answer came from: its digests and what it was given, frozen
          ...(summary ? { lastRun: summary } : {}) } };
      }),
    }));
    // a failure's placeholder is no answer: a failed run wrote none
    endRecord(ended, versionWritten === null || ended === 'failed' ? null : { versionIndex: versionWritten, chars: response.length });
  };

  // Ambient memory rides the system layer of ordinary generations only —
  // paradigm machine steps stay memory-free (experimental control), digests
  // must stay faithful to the material (no personalization), and
  // fingerprints never see this block (memory edits must not mark answers
  // stale; the block is assembled at generation time, after buildContext).
  const selfData = get().nodes.find((n) => n.id === nodeId)?.data;
  // A task set to research is given its inputs and its question, and nothing else: no memory, no recall,
  // no tools. Whether the AI it runs on can be held to that is checked once the run is prepared (below).
  const researching = runTarget?.policyId === RESEARCH_POLICY;
  const memBlock = !researching && !selfData?.stepKind && !selfData?.digestOf ? memoryContextBlock() : null;
  if (memBlock) {
    // Insert AFTER the last assistant turn: the material+chain prefix stays
    // byte-stable across turns, so provider prompt caches keep hitting.
    // Memory entries change often — at the front they would invalidate the
    // cached prefix on every write.
    let insertAt = messages.length - 1; // no upstream yet → before the question
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { insertAt = i + 1; break; }
    }
    messages = [...messages.slice(0, insertAt), memBlock, ...messages.slice(insertAt)];
    sources.splice(insertAt, 0, { layer: 'system' });
  }

  // Recall (the node's 回忆 switch): the why layer's exact-word hits for this
  // question ride in as listed, priced, removable items — never a hidden
  // injection. Items already on the node (a rerun, or some pruned by the
  // person) are used as they stand; a fresh ask searches. Same seat as the
  // memory block: after the last answer, before the question.
  const recallOn = !researching && !selfData?.stepKind && !selfData?.digestOf && (selfData?.recall ?? useUiStore.getState().recallEnabled);
  let recallGiven = false;
  if (recallOn && isCurrent()) {
    let items = selfData?.recallItems;
    if (!items) {
      const { useProjects } = await import('./projects');
      const onProgress = (done: number, total: number) => { if (isCurrent()) set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, recallProgress: { done, total } } } : n)) })); };
      const out = await fetchRecallItems(question, { excludeSession: useProjects.getState().activeId, model: requestedModel, onProgress, reach: selfData?.recallReach, scale: selfData?.recallScale });
      items = out.items;
      if (!isCurrent()) return;
      set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, recallItems: out.items, recallMeta: out.meta, recallProgress: null } } : n)) }));
      fillCards(nodeId, out.items);
    }
    const block = recallContextBlock(items);
    if (block) {
      let at = messages.length - 1;
      for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'assistant') { at = i + 1; break; } }
      messages = [...messages.slice(0, at), block, ...messages.slice(at)];
      recallGiven = true;
      sources.splice(at, 0, { layer: 'system' });
    }
  }

  // The run, frozen and digested before anything leaves: one list of everything it is given (the
  // envelope), which the request is checked against at the last moment. The files it reads were
  // frozen by its entry before the context was built (freezeForRun); a run that cannot be given
  // them as they are is not sent, and says why.
  const toolPrefs = (() => {
    // Search permissions live on the node (snapshotted at ask time);
    // legacy nodes without flags follow the current shared defaults
    const selfNow = get().nodes.find((n) => n.id === nodeId)?.data;
    if (researching) return { web: false, scholar: false, mcp: false };
    return {
      web: selfNow?.webSearch ?? useUiStore.getState().webSearchEnabled,
      scholar: selfNow?.scholarSearch ?? useUiStore.getState().scholarSearchEnabled,
      mcp: useUiStore.getState().mcpEnabled,
    };
  })();
  const prep = await import('../lib/context/prepare-run');
  const frozen = frozenFor.get(nodeId);
  frozenFor.delete(nodeId);
  try {
    const { useProjects } = await import('./projects');
    envelope = await prep.prepareRun({
      graphId: useProjects.getState().activeId ?? 'canvas',
      targetNodeId: nodeId,
      question,
      mode: researching ? 'research' : 'workspace',
      runtimeSelection: {
        kind: runTarget?.kind ?? (isAgentModel(requestedModel) ? 'agent' : 'provider'),
        runtime: runTarget?.runtime ?? null,
        connectionRef: runTarget?.connectionRef ?? 'default',
        model: pinnedModel ?? requestedModel ?? '',
        effort: runEffort ?? null,
        capabilityVersion: null,
      },
      tools: toolPrefs,
      recall: memBlock ? 'auto' : recallGiven ? 'explicit-only' : 'off',
      context: { messages, images: images ?? [], sources, imageSources: opts.imageSources ?? [] },
      ...(frozen ? { frozen } : {}),
    });
  } catch (e) {
    if (!isCurrent()) return;
    markNotSent(set, get, nodeId, e instanceof prep.RunBlocked ? blockedText(get, e) : fmt(t('run.notPrepared'), { why: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (!isCurrent()) return;
  // what the run is held to, against what its runtime is known to be able to hold it to: a promise that
  // cannot be kept is not made (research by an agent whose capabilities are not known is not sent)
  const { verifyPolicy, capabilitiesOf } = await import('../lib/context/policy');
  const verdict = verifyPolicy(envelope, capabilitiesOf(envelope.runtime.runtime));
  if (!verdict.ok) {
    markNotSent(set, get, nodeId, policyText(verdict.blocked));
    return;
  }
  const { materialsFor } = await import('../lib/context/materials');
  if (!isCurrent()) return;
  // recorded before anything is sent: the snapshots it was given are held from now on
  runRecords = await import('../lib/context/run-records');
  preparedAt = new Date().toISOString();
  await runRecords.persistRun(envelope, runRecords.recordRun(envelope, { state: 'prepared', preparedAt }));
  if (!isCurrent()) return;

  try {
    // Context budget: browser-configured models carry their probed window.
    // When the wired context alone clearly exceeds it, fail fast with the
    // reason (and no spend) instead of a guaranteed upstream 400. countTokens
    // errs high on CJK, and an input hugging the window leaves no room for
    // the answer anyway — so a plain >= is the honest cutoff.
    const effectiveModel = requestedModel;
    const windowLimit = effectiveModel ? contextLengthFor(effectiveModel) : undefined;
    if (windowLimit) {
      const est = countTokens(messages.map((m) => m.content).join('\n'));
      if (est >= windowLimit) {
        throw new Error(fmt(t('toast.contextOverWindow'), { est: est.toLocaleString(), model: effectiveModel!, limit: windowLimit.toLocaleString() }));
      }
    }
    // Stream frames arrive at 100+/s on the direct lane (DeepSeek flash
    // thinking most of all). Committing every frame re-renders the whole
    // canvas and locks the tab; buffer the latest text and commit at most
    // every ~100ms (leading + trailing), with a final flush after the await.
    let streamLatest: { response?: string; reasoning?: string } | null = null;
    let streamTimer: number | null = null;
    const commitStream = () => {
      if (!streamLatest || !isCurrent()) { streamLatest = null; return; }
      const patch = streamLatest;
      streamLatest = null;
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data,
                ...(patch.response !== undefined ? { response: patch.response, restreaming: undefined } : {}),
                ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}) } }
            : n
        ),
      }));
    };
    const pushStream = (patch: { response?: string; reasoning?: string }) => {
      streamLatest = { ...(streamLatest ?? {}), ...patch };
      if (streamTimer == null) {
        commitStream();
        streamTimer = window.setTimeout(() => { streamTimer = null; commitStream(); }, 100);
      }
    };
    const flushStream = () => {
      if (streamTimer != null) { clearTimeout(streamTimer); streamTimer = null; }
      commitStream();
    };

    // The alignment fact, written by the API layer at the moment the
    // request leaves — exactly what goes out, after any image substitution
    // or drop, on whichever lane: a SHA-256 over the messages (the
    // question is the last one), every image's type and bytes, the model
    // and every tool switch. Fires again on a retry. Light metadata only,
    // like every canvas event — never the text itself.
    const members = [...new Set((opts.sources ?? []).map((s) => s.nodeId).filter((id): id is string => !!id))];
    const commitDispatch = async (p: { messages: ContextMessage[]; images: ImageAttachment[]; model: string; toolPrefs: { web?: boolean; scholar?: boolean; mcp?: boolean }; lane: string }) => {
      const imageDigests = await Promise.all(p.images.map(async (img) => ({ type: img.mimeType, sha: await sha256Hex(img.data) })));
      const sha = await sha256Hex(canonicalStringify({ messages: p.messages, images: imageDigests, model: p.model, tools: { web: !!p.toolPrefs.web, scholar: !!p.toolPrefs.scholar, mcp: !!p.toolPrefs.mcp } }));
      const shown = members.slice(0, 200);
      get().logEvent('commit', nodeId, {
        kind: 'request', sha: `sha256:${sha}`, n: p.messages.length, images: p.images.length, lane: p.lane, ...(p.model ? { model: p.model } : {}),
        ...(shown.length ? { m: shown.join(',') } : {}), ...(members.length > shown.length ? { more: true } : {}),
      });
    };
    let toolsSettled = false;
    const response = await llmCallStream(messages, (_chunk, fullSoFar) => {
      pushStream({ response: fullSoFar });
      if (harnessRoute && !toolsSettled) {
        // the answer has begun: whatever step was still running is over
        toolsSettled = true;
        const now = new Date().toISOString();
        set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId && n.data.agentTrace?.some((e) => e.status === 'running')
          ? { ...n, data: { ...n.data, agentTrace: n.data.agentTrace.map((e) => (e.status === 'running' ? { ...e, status: 'ok' as const, endedAt: now } : e)) } }
          : n)) }));
      }
    }, abortController.signal, images, {
      // an agent's inputs on disk: written from the envelope, into a directory of the run's own
      materials: materialsFor(envelope),
      onDispatch: (p) => {
        // the last moment before it leaves: it must be the request prepared, nothing added on the way
        const check = prep.verifyDispatch(envelope!, p);
        if (!check.ok) throw new DispatchRefused(check.reason);
        imagesDropped = check.imagesDropped;
        void commitDispatch(p).catch(() => undefined);
      },
      onToolCall: (name, query) => {
        if (!isCurrent()) return;
        if (harnessRoute) {
          // a harness turn is a run: every tool is a step, listed on the node
          // as it happens (latest last), the thinking between steps beneath.
          // The host reports starts only; a step is done when the next one
          // begins or the answer starts.
          const now = new Date().toISOString();
          set((state) => ({
            nodes: state.nodes.map((n) => {
              if (n.id !== nodeId) return n;
              const trace = (n.data.agentTrace ?? []).map((e) => (e.status === 'running' ? { ...e, status: 'ok' as const, endedAt: now } : e));
              trace.push({ id: `${now}-${trace.length}`, name, query, status: 'running', startedAt: now });
              return { ...n, data: { ...n.data, agentTrace: trace } };
            }),
          }));
          return;
        }
        // Show what's being searched while the answer hasn't started streaming
        const icon = name === 'arxiv_search' ? '📚' : name === 'semantic_scholar' ? '🎓' : name.startsWith('mcp:') ? '🔧' : '🔍';
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === nodeId && !n.data.response
              ? { ...n, data: { ...n.data, response: `${icon} ${query}…` } }
              : n
          ),
        }));
      },
      onGatewaySearch: () => {
        if (!isCurrent()) return;
        gatewaySearched = true;
        // Same pattern as tool pings: a placeholder line while the answer
        // has not started streaming — the gateway searches in silence.
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === nodeId && !n.data.response
              ? { ...n, data: { ...n.data, response: `🌐 ${t('node.gatewaySearching')}` } }
              : n
          ),
        }));
      },
      onSources: (sources) => { references = sanitizeReferenceUrls(sources); },
      onHarnessSession: (session) => { harnessSession = session; },
      onAgentTool: (call) => {
        if (!isCurrent()) return;
        const now = new Date().toISOString();
        set((state) => ({
          nodes: state.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const trace = [...(n.data.agentTrace ?? [])];
            if (call.phase === 'start') trace.push({ id: call.id || `${trace.length}`, name: call.name, query: call.query, status: 'running', startedAt: now });
            else { const i = trace.findIndex((e) => e.id === call.id && e.status === 'running'); if (i >= 0) trace[i] = { ...trace[i], status: call.isError ? 'error' : 'ok', endedAt: now }; }
            return { ...n, data: { ...n.data, agentTrace: trace } };
          }),
        }));
      },
      onAgentSession: (session) => {
        if (!isCurrent()) return;
        const continued = !!agentRoute?.continue;
        // a later session event (the file found, the effort read) adds to the record, never wipes it
        set((state) => ({ nodes: state.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, agentSession: { ...n.data.agentSession, ...session, continued } } } : n) }));
        if (continued && session.sessionId) void claimAgentTurn(session.runtime, nodeId, session.sessionId, session.cwd);
      },
      onAgentChanges: (changes) => {
        if (!isCurrent()) return;
        set((state) => ({ nodes: state.nodes.map((n) => n.id === nodeId && n.data.agentSession ? { ...n, data: { ...n.data, agentSession: { ...n.data.agentSession, changes } } } : n) }));
      },
      onHarnessTurn: (turn) => {
        harnessTurn = turn;
        if (harnessRoute && !harnessClaim) harnessClaim = claimHarnessTurn(set, nodeId, harnessRoute, turn).catch(() => false);
      },
      onApproval: (request) => {
        if (!isCurrent()) return;
        const askedAt = new Date().toISOString();
        // append, never replace: a second parallel tool call must not evict the
        // first one's card (that stranded the first approval and hung the turn)
        set((state) => ({
          nodes: state.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const cur = n.data.pendingApprovals ?? [];
            if (cur.some((p) => p.id === request.id)) return n;
            return { ...n, data: { ...n.data, pendingApprovals: [...cur, { ...request, askedAt }] } };
          }),
        }));
        toast('info', t('approval.toast'), 8000);
      },
      onApprovalDecided: ({ id, outcome, value, auto, name, query, rule }) => {
        if (!isCurrent()) return;
        const decidedAt = new Date().toISOString();
        set((state) => ({
          nodes: state.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const cur = n.data.pendingApprovals ?? [];
            const pending = cur.find((p) => p.id === id);
            const rest = cur.filter((p) => p.id !== id);
            const nextPending = rest.length ? rest : undefined;
            // a decision made from a standing rule of this conversation: nobody was
            // asked, but the record shows it like any other
            if (!pending && auto) return { ...n, data: { ...n.data, pendingApprovals: nextPending, approvals: [...(n.data.approvals ?? []), { id, kind: 'confirm', toolName: n.data.agentSession?.runtime ?? 'agent', callId: null, reason: null, name: name ?? '', query: query ?? '', arguments: null, askedAt: decidedAt, decidedAt, outcome, auto: true, ...(rule ? { rule } : {}) }] } };
            if (!pending) return { ...n, data: { ...n.data, pendingApprovals: nextPending } };
            const asked = { ...pending };
            delete asked.answered;
            return { ...n, data: { ...n.data, pendingApprovals: nextPending, approvals: [...(n.data.approvals ?? []), { ...asked, outcome, decidedAt, ...(value ? { value } : {}) }] } };
          }),
        }));
      },
      onRerouted: (_from, to) => { actualModel = to; },
      onImageFallback: (model) => { actualModel = model; },
      onReasoning: (_chunk, fullSoFar) => {
        pushStream({ reasoning: fullSoFar });
      },
      // the tools are the ones the run was prepared with; the model is named in the request, also when it came from
      // the defaults: the task was just bound to it, and what answers must be what the task says it runs on
    }, toolPrefs, pinnedModel ?? requestedModel, harnessRoute ?? (agentRoute ? { ...agentRoute, nodeId, ...(runEffort !== undefined ? { effort: runEffort } : {}) } : undefined));
    flushStream();
    if (!isCurrent()) return; // superseded while finishing: drop everything
    activeAbortControllers.delete(nodeId);
    if (!response.trim()) {
      // The stream closed cleanly but the model sent nothing (upstream
      // hiccup, tool-only turn) — silent emptiness reads as a hang, so
      // surface it as a retryable failure instead.
      writeFinal(t('node.emptyResponse'), true);
      return;
    }
    // an agent turn is adopted from its session file BEFORE the node is marked
    // done: footprints, provenance and the ledger land in the same step as the
    // answer, so a follow-up asked right away already continues the session
    if (agentRoute) {
      const session = get().nodes.find((n) => n.id === nodeId)?.data.agentSession;
      if (session) await adoptAgentTurn(nodeId, session, question).catch(() => false);
    }
    writeFinal(response);
    // this node is the mirror of the dsh turn it just ran: stamp provenance,
    // and on a tail follow-up advance the mirror's ledger so the live sweep
    // does not append the same turn a second time
    if (harnessRoute) {
      const ledgerAdvanced = harnessClaim ? await harnessClaim : false;
      await stampHarnessTurn(set, get, nodeId, { question, response }, harnessRoute, harnessSession, harnessTurn, ledgerAdvanced);
    }
    onSuccess?.(response);
    get().pushHistory();
    // The ladder sees the thread as its own plaques (lib/ladder-context.ts), not the compiled conversation: in the
    // 09-27 comparison the two read alike, and resending the conversation cost several times the plaque lines. Every
    // route (API model, agent, harness) and every later update (right-click, lasso) thus writes from the same view.
    generateSummary(nodeId, question, response, get().setSummary, collectMapLines(nodeId, get().nodes, get().edges), { model: harnessRoute || agentRoute ? undefined : requestedModel, set: get().setLadder, ...ladderContextFor(nodeId, get().nodes, get().edges) });
    if (!selfData?.stepKind && !selfData?.digestOf) {
      // the memory judge counts its writes per canvas (#47); the project
      // store imports this module, so it is reached lazily here
      void import('./projects').then(({ useProjects }) => {
        const { projects, activeId } = useProjects.getState();
        const active = projects.find((p) => p.id === activeId);
        judgeMemory(question, response, active ? { id: active.id, name: active.name } : undefined);
      });
    }
    triggerAutoReruns(set, get, nodeId);
    triggerParadigmCascade(get, nodeId);
  } catch (err) {
    if (!isCurrent()) return; // superseded: the abort was ours to swallow
    if (err instanceof DispatchRefused) {
      // stopped before it left: nothing was asked, nothing is recorded as answered
      markNotSent(set, get, nodeId, fmt(t('run.dispatchRefused'), { what: t(`run.dispatchPart.${err.part}`) }));
      endRecord('failed');
      return;
    }
    if (err instanceof prep.RunBlocked) {
      // its inputs could not be written as they were frozen: nothing was written, nothing was sent
      markNotSent(set, get, nodeId, blockedText(get, err));
      endRecord('failed');
      return;
    }
    activeAbortControllers.delete(nodeId);
    const partial = get().nodes.find((n) => n.id === nodeId)?.data.response || '';
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort) {
      // User pressed Stop — keep whatever streamed, no error surfacing
      writeFinal(partial || t('node.stoppedPlaceholder'), false, 'cancelled');
    } else {
      // Real failure: details go to a toast, the node gets a Retry affordance
      const message = err instanceof Error ? err.message : t('toast.unknownError');
      if (/no model configured/i.test(message)) {
        // The one failure with an obvious remedy: summon the key dialog
        // right here, with a localized line instead of the raw server text.
        toast('info', t('toast.noModelYet'));
        useUiStore.getState().setApiKeyModalOpen(true);
      } else if (/429|too many requests|rate.?limit|quota/i.test(message)) {
        // Free tiers meter requests per minute — a pause fixes it, and the
        // raw provider text reads like a failure of the app rather than a
        // property of the free key. Say what it actually is.
        toast('info', t('toast.rateLimited'));
      } else {
        toast('error', fmt(t('toast.generationFailed'), { message }));
      }
      writeFinal(partial || t('node.failedPlaceholder'), true);
    }
    get().pushHistory();
  }
}

/**
 * Two generic primitives fire after any node finishes generating:
 *
 * 1. followsTip edges slide forward — an edge marked followsTip keeps
 *    pointing at the newest node of the thread it grew from, so whatever
 *    consumes it (a reviewer, a live summary) always sees the tip.
 * 2. autoRerun nodes regenerate — any node with autoRerun whose ancestor
 *    set (standard context walk, after edges slid) contains the completed
 *    node reruns itself in place. Chains of autoRerun nodes cascade
 *    naturally; the DAG has no cycles to worry about.
 */
/**
 * Paradigm cascade: an instantiated paradigm executes itself forward. When a
 * node completes, every STRUCTURAL child tagged stepKind 'prompt' that has
 * never produced a response starts automatically — but only once ALL of its
 * structural parents are complete (a human parent counts as complete when its
 * question is filled; failed parents block until retried). Human nodes are
 * never auto-run, so the run pauses wherever the paradigm put a person.
 * Each prompt node is filled at most once (only empty nodes fire) — no loops.
 * Ordinary canvases are untouched: nothing there carries stepKind 'prompt'.
 */
export function triggerParadigmCascade(get: Get, completedNodeId: string): void {
  if (useUiStore.getState().autoRefreshPaused) return; // same global brake
  const { nodes, edges } = get();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isComplete = (id: string): boolean => {
    const n = byId.get(id);
    if (!n || n.data.isLoading) return false;
    if (n.data.stepKind === 'human') return !!n.data.question.trim();
    // Content nodes: complete when they hold material. An EMPTY note/file/
    // link in a paradigm is a material slot — the cascade waits for the
    // human to fill it, same pause semantics as a human turn.
    if (n.data.stepKind === 'note' || n.data.stepKind === 'link') return !!n.data.question.trim();
    if (n.data.stepKind === 'file') return (n.data.attachments?.length ?? 0) > 0;
    return !!n.data.response && !n.data.generationFailed;
  };
  for (const edge of edges) {
    if (edge.source !== completedNodeId || edge.data?.isCrossLink) continue;
    const child = byId.get(edge.target);
    if (!child || child.data.stepKind !== 'prompt') continue;
    if (child.data.response || child.data.isLoading || child.data.generationFailed) continue;
    const parentIds = edges.filter((e) => e.target === child.id && !e.data?.isCrossLink).map((e) => e.source);
    if (!parentIds.every(isComplete)) continue; // fan-in: wait for all parents
    // rerunNode sets isLoading synchronously before awaiting, so a sibling
    // completion arriving next tick sees the child as busy — no double fire.
    void get().rerunNode(child.id, { auto: true });
  }
}

function triggerAutoReruns(set: Set, get: Get, completedNodeId: string): void {
  if (useUiStore.getState().autoRefreshPaused) return; // global kill switch
  // 1) slide followsTip edges whose source thread just grew: the completed
  //    node's STRUCTURAL ancestor chain reaching an edge's source means
  //    that edge's thread extended past its current anchor.
  const chain = new Set<string>([completedNodeId]);
  const queue = [completedNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of get().edges) {
      if (e.target === current && !e.data?.isCrossLink && !chain.has(e.source)) {
        chain.add(e.source);
        queue.push(e.source);
      }
    }
  }
  const needsSlide = get().edges.some(
    (e) => e.data?.followsTip && e.source !== completedNodeId && chain.has(e.source)
  );
  if (needsSlide) {
    set((state) => ({
      edges: state.edges.map((e) =>
        e.data?.followsTip && e.source !== completedNodeId && chain.has(e.source)
          ? { ...e, id: `watch-${completedNodeId}-${e.target}`, source: completedNodeId }
          : e
      ),
    }));
  }

  // 2) rerun any autoRerun node that (now) has the completed node upstream,
  //    within its per-wave budget (autoRerunRounds, default 1). A feedback
  //    line is not a way upstream: what it carries is the answer it holds,
  //    and the other end answering again runs nothing (lib/feedback).
  const { nodes } = get();
  const edges = get().edges.filter((e) => !isFeedback(e));
  for (const n of nodes) {
    const auto = n.data.autoRerun ?? n.data.evaluatorTrigger === 'auto'; // legacy graphs
    if (!auto || n.id === completedNodeId) continue;
    if (n.data.isLoading || activeAbortControllers.has(n.id)) continue;
    const spent = autoRunCounts.get(n.id) ?? 0;
    if (spent >= (n.data.autoRerunRounds ?? 1)) continue; // budget exhausted this wave
    const { ordered } = walkUpAncestors(n.id, nodes, edges);
    if (ordered.some((a) => a.id === completedNodeId)) {
      // an agent that may write files is not set off by a change upstream: the person runs it (lib/context/replay-plan)
      if (writesFiles(n.data)) {
        toast('info', fmt(t('replay.agentWaits'), { name: (n.data.question || '').slice(0, 40) }), 9000);
        continue;
      }
      autoRunCounts.set(n.id, spent + 1);
      void get().rerunNode(n.id, { auto: true });
    }
  }

  // 3) feedback lines set to go back and forth (lib/feedback): within the wave
  //    the person started, the two ends answer each other in turn. The line's
  //    source (the critic) answers again each time its target (the writer)
  //    finishes; the target starts its next round each time the source
  //    finishes, up to the rounds the line is set to. Every round of the
  //    target moves the line to the source's latest finished answer.
  const busy = (id: string) => !!get().nodes.find((n) => n.id === id)?.data.isLoading || activeAbortControllers.has(id);
  for (const line of get().edges) {
    const rounds = line.data?.feedback?.auto ?? 0;
    if (rounds <= 0) continue;
    if (line.source === completedNodeId) {
      const key = `feedback:${line.id}`;
      const spent = autoRunCounts.get(key) ?? 0;
      if (spent >= rounds || busy(line.target)) continue;
      autoRunCounts.set(key, spent + 1);
      void get().rerunNode(line.target, { auto: true });
    } else if (completedNodeId === line.target || walkUpAncestors(line.source, nodes, edges).ordered.some((a) => a.id === completedNodeId)) {
      // what the source reads has a new answer: it answers it, unless it is already doing so
      if (busy(line.source)) continue;
      void get().rerunNode(line.source, { auto: true });
    }
  }
}

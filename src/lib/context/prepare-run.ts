// A run, prepared: one list of everything it is given, frozen before it is
// sent (plan §7, T11). The files it reads are saved and frozen into
// snapshots; the context is built by the one context builder there is
// (buildContext), from the canvas with those frozen contents in place; and
// two digests are taken over the result:
//   - inputDigest: what the model is asked to read (the messages in their
//     order with their roles, every image's bytes, every input's content and
//     the part of it selected). The same for the same input whatever AI it
//     goes to; nothing about the canvas's look (where cards are, which are
//     folded) is in it.
//   - executionDigest: the input digest with how it is sent: the target and
//     its revision, the runtime and connection, the model and its effort,
//     the policy and tools, and the form the request takes.
// What is finally sent is checked against the envelope at the last moment
// (verifyDispatch): a system message or a tool added on the way stops it.

import { buildContext, type MessageSource } from '../../store/context-builder';
import { partitionContext } from '../graph';
import { graphSnapshotHash } from '../context-bundle';
import { generateId } from '../../utils';
import { useStore } from '../../store';
import { useUiStore } from '../ui-store';
import type { ContextMessage, ImageAttachment, ToolPrefs } from '../api';
import type { ThoughtEdge, ThoughtNode } from '../../types';
import { DEFAULT_RUN_GUARDS, RUN_SCHEMA_VERSION, type EnvelopeMessage, type ExclusionRecord, type ExecutionPolicy, type ResolvedInput, type RunEnvelope, type RuntimeSelection } from './contracts';
import { RunBlocked, resolveRef, type ResolvedResource } from './resource-resolver';
import { bytesOfBase64, digestOf, hashBytes, hashText } from './canonicalize';

export { RunBlocked } from './resource-resolver';
export type { BlockReason } from './resource-resolver';

/** The context as a run's entry built it: an edit blanks the node's own question and answer, a sibling reads its original's edges, and so on. */
export interface PreparedContext {
  messages: ContextMessage[];
  images: ImageAttachment[];
  /** parallel to `messages`; a message with none (the question asked) is the task's own */
  sources: (MessageSource | undefined)[];
  /** parallel to `images` */
  imageSources: { nodeId: string; attachmentId: string }[];
}

export interface PrepareRunRequest {
  graphId: string;
  targetNodeId: string;
  question: string;
  mode: 'research' | 'workspace';
  runtimeSelection: RuntimeSelection;
  tools?: ToolPrefs;
  /** what of memory and recall the run's entry put into the messages: ambient memory is `auto`, recall items listed on the task `explicit-only` */
  recall?: ExecutionPolicy['recall'];
  /** the context, when the run's entry built it (after freezeInputs put the frozen contents on the canvas); built here when absent */
  context?: PreparedContext;
  /** the inputs freezeInputs froze for this run, when it was called before the context was built */
  frozen?: FrozenInputs;
}

/** What freezing found: the frozen reference of each material node that holds one, by node id. */
export interface FrozenInputs {
  byNode: Map<string, ResolvedResource>;
}

/** The images of an envelope: they are not in the envelope (its inputs name them by hash), and the request is checked against them. */
const imagesOf = new WeakMap<RunEnvelope, ImageAttachment[]>();
export const envelopeImages = (envelope: RunEnvelope): ImageAttachment[] => imagesOf.get(envelope) ?? [];

/** What the canvas itself holds of an envelope's inputs, by input id, in base64: the bytes their hashes are over, for the shell to write. */
const heldOf = new WeakMap<RunEnvelope, Record<string, string>>();
export const envelopeHeld = (envelope: RunEnvelope): Record<string, string> => heldOf.get(envelope) ?? {};
const base64OfText = (text: string) => { let raw = ''; for (const b of new TextEncoder().encode(text)) raw += String.fromCharCode(b); return btoa(raw); };

const TEXT_COPY = (type: string) => !type.startsWith('image/') && type !== 'application/pdf' && type !== 'text/html';

/** The nodes a task reads material from: the ones whose content reaches its context. */
function materialNodes(taskNodeId: string, nodes: ThoughtNode[], edges = useStore.getState().edges): ThoughtNode[] {
  const { materials } = partitionContext(taskNodeId, nodes, edges);
  return materials;
}

/**
 * Freeze every file a task reads: each material node that references a file
 * has the file saved (if it is open with unsaved typing), frozen, and the
 * part it selects found again. With `apply`, the canvas's copies of text
 * files are set to what was frozen, so that a context built from the canvas
 * afterwards is built from it. Throws RunBlocked when a reference cannot be
 * given as it is.
 */
export async function freezeInputs(taskNodeId: string, { apply = false, only }: { apply?: boolean; only?: Set<string> } = {}): Promise<FrozenInputs> {
  const { nodes, edges } = useStore.getState();
  const byNode = new Map<string, ResolvedResource>();
  for (const material of materialNodes(taskNodeId, nodes, edges)) {
    const ref = material.data.resourceRef;
    if (!ref || (only && !only.has(material.id))) continue;
    const resolved = await resolveRef(ref, { nodeId: material.id, reason: 'wired', displayName: material.data.resourceHint?.name });
    const copy = material.data.attachments?.[0];
    // a copy the run cannot be given from what was frozen (a PDF, an image, a page) must be of the frozen content
    if (copy && !TEXT_COPY(copy.type) && material.data.resourceHint?.revision !== resolved.input.contentHash) {
      throw new RunBlocked('copy-out-of-date', material.id, ref.fileId, 'the copy of the file on the canvas is not of its content as frozen; it is being brought up to date');
    }
    byNode.set(material.id, resolved);
  }
  if (apply && byNode.size > 0) {
    useStore.setState((st) => ({ nodes: withFrozenCopies(st.nodes, byNode) }));
  }
  return { byNode };
}

/** The nodes with each frozen text in place of the copy the canvas held. */
function withFrozenCopies(nodes: ThoughtNode[], byNode: Map<string, ResolvedResource>): ThoughtNode[] {
  return nodes.map((n) => {
    const resolved = byNode.get(n.id);
    const copy = n.data.attachments?.[0];
    if (!resolved || resolved.text === null || !copy || !TEXT_COPY(copy.type) || copy.content === resolved.text) return n;
    return { ...n, data: { ...n.data, attachments: [{ ...copy, content: resolved.text, size: resolved.input.size.bytes }, ...n.data.attachments.slice(1)] } };
  });
}

/** The context of a task asked `question`, built the way a run in place builds it: its own question and answer left out, the question last. */
function buildTaskContext(taskNodeId: string, question: string, nodes: ThoughtNode[]): PreparedContext {
  const { edges } = useStore.getState();
  const task = nodes.find((n) => n.id === taskNodeId);
  const blanked = nodes.map((n) => (n.id === taskNodeId ? { ...n, data: { ...n.data, question: '', response: '' } } : n));
  const built = buildContext(taskNodeId, blanked, edges, undefined, task?.data.excludedAttachmentIds, task?.data.includedAttachmentIds);
  return {
    messages: [...built.messages, { role: 'user', content: question }],
    images: built.images,
    sources: [...built.sources, undefined],
    imageSources: built.imageSources,
  };
}

const TOOL_NAMES: Record<keyof ToolPrefs, string> = { web: 'web_search', scholar: 'scholar_search', mcp: 'mcp' };
const toolsOf = (prefs: ToolPrefs = {}) => (Object.keys(TOOL_NAMES) as (keyof ToolPrefs)[]).filter((k) => prefs[k]).map((k) => TOOL_NAMES[k]);

/**
 * What a run uses, as it is sent: the tools it is given, what of memory and recall is in its
 * messages, what it may read and write. Whether the runtime can be held to it is checked
 * against this (policy.ts, and runtime/execution/policy.cjs in the shell).
 */
function policyOf(mode: PrepareRunRequest['mode'], runtime: RuntimeSelection, inputs: ResolvedInput[], tools: ToolPrefs | undefined, recall: ExecutionPolicy['recall'] | undefined): ExecutionPolicy {
  const allow = toolsOf(tools);
  const ui = useUiStore.getState() as { recallEnabled?: boolean; memoryEnabled?: boolean };
  // an agent at work has tools of its own that can reach the network; one asked to research is asked not to
  const agentNetwork = runtime.kind === 'agent' && mode === 'workspace';
  return {
    read: { scope: mode === 'research' ? 'inputs-only' : 'workspace', inputIds: inputs.map((i) => i.inputId) },
    // an agent writes in the folder it runs in (behind its write guard); a model called through its API writes nothing
    write: { scope: runtime.kind === 'agent' && mode === 'workspace' ? 'workspace' : 'none' },
    tools: { allow, mcpServers: [] },
    network: agentNetwork || allow.includes('web_search') || allow.includes('scholar_search') ? 'on' : 'off',
    recall: recall ?? (ui.recallEnabled || ui.memoryEnabled ? 'auto' : 'off'),
    budget: { maxInputTokens: 200_000, reservedOutputTokens: 8_192, ...DEFAULT_RUN_GUARDS },
  };
}

/** What a task reads that the person left out: each attachment of its context that is excluded and not taken back in. */
function leftOut(task: ThoughtNode, nodes: ThoughtNode[], edges: ThoughtEdge[]): { nodeId: string; attachmentId: string; name: string }[] {
  const included = task.data.includedAttachmentIds ?? [];
  const { materials, mainline } = partitionContext(task.id, nodes, edges);
  const left = new Set<string>((task.data.excludedAttachmentIds ?? []).filter((id) => !included.includes(id)));
  for (const n of materials) for (const id of n.data.excludedAttachmentIds ?? []) if (!included.includes(id)) left.add(id);
  const out: { nodeId: string; attachmentId: string; name: string }[] = [];
  for (const n of [...materials, ...mainline]) for (const att of n.data.attachments ?? []) if (left.has(att.id)) out.push({ nodeId: n.id, attachmentId: att.id, name: n.data.resourceHint?.name ?? att.name });
  return out;
}

/** One line of a run preview: a node's material, by name, and whether the whole or a passage of it is read. */
export interface RunPreviewItem { nodeId: string; attachmentId: string; name: string; part: 'whole' | 'passage'; bytes: number }

/**
 * What a run of a task would be given, read from the canvas as it is now (nothing is saved or frozen):
 * its materials in the order its context reads them, and what the person left out. For the run
 * preview; a run itself is prepared by prepareRun, from what is frozen when it starts.
 */
export function previewRun(taskNodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): { inputs: RunPreviewItem[]; excluded: RunPreviewItem[] } {
  const task = nodes.find((n) => n.id === taskNodeId);
  if (!task) return { inputs: [], excluded: [] };
  const blanked = nodes.map((n) => (n.id === taskNodeId ? { ...n, data: { ...n.data, question: '', response: '' } } : n));
  const built = buildContext(taskNodeId, blanked, edges, undefined, task.data.excludedAttachmentIds, task.data.includedAttachmentIds);
  const seen = new Set<string>();
  const inputs: RunPreviewItem[] = [];
  const itemOf = (nodeId: string, attachmentId: string | undefined): RunPreviewItem | null => {
    const n = nodes.find((x) => x.id === nodeId);
    const att = attachmentId ? n?.data.attachments?.find((a) => a.id === attachmentId) : n?.data.attachments?.[0];
    if (!n || !att) return null;
    return { nodeId, attachmentId: att.id, name: n.data.resourceHint?.name ?? att.name, part: n.data.resourceRef?.selector.kind === 'text' ? 'passage' : 'whole', bytes: att.size ?? 0 };
  };
  const from = [...built.sources, ...built.imageSources.map((src) => ({ ...src, layer: 'material' as const }))];
  for (const src of from) {
    if (!src?.nodeId || !(src.layer === 'material' || ('part' in src && src.part === 'attachment'))) continue;
    const item = itemOf(src.nodeId, 'attachmentId' in src ? src.attachmentId : undefined);
    if (!item || seen.has(`${item.nodeId}:${item.attachmentId}`)) continue;
    seen.add(`${item.nodeId}:${item.attachmentId}`);
    inputs.push(item);
  }
  const excluded = leftOut(task, nodes, edges).map(({ nodeId, attachmentId }) => itemOf(nodeId, attachmentId)).filter((x): x is RunPreviewItem => x !== null);
  return { inputs, excluded };
}

/** Prepare a run: freeze, build, digest. Throws RunBlocked when it cannot be prepared as it is. */
export async function prepareRun(request: PrepareRunRequest): Promise<RunEnvelope> {
  const { nodes, edges } = useStore.getState();
  const task = nodes.find((n) => n.id === request.targetNodeId);
  if (!task) throw new RunBlocked('unavailable', request.targetNodeId, null, 'the task is not on the canvas');
  const graphRevision = await graphSnapshotHash(nodes, edges);
  // sources say which message came from where only when there is one per message (the question last may have none)
  const aligned = !request.context || request.context.sources.length === request.context.messages.length || request.context.sources.length === request.context.messages.length - 1;
  let frozen = request.frozen;
  if (!frozen) {
    // A context the entry built without freezing first was built from the canvas's copies: it is the frozen
    // content only if those copies already were. When one was not, the canvas is brought up to the frozen
    // content and this run is not sent (asked again, it is built from what was frozen). Only the files
    // whose content the context carries are frozen: a run that reads none of them is given none of them.
    const read = request.context
      ? new Set(aligned ? request.context.sources.filter((src) => src?.nodeId && (src.layer === 'material' || src.part === 'attachment')).map((src) => src!.nodeId!) : [])
      : undefined;
    frozen = await freezeInputs(request.targetNodeId, { apply: !!request.context, only: read });
    if (request.context) {
      for (const [nodeId, resolved] of frozen.byNode) {
        const copy = nodes.find((n) => n.id === nodeId)?.data.attachments?.[0];
        if (resolved.text !== null && copy && TEXT_COPY(copy.type) && copy.content !== resolved.text) {
          throw new RunBlocked('copy-out-of-date', nodeId, resolved.input.source.kind === 'resource' ? resolved.input.source.ref.fileId : null, 'the copy on the canvas was not of the file as it is; it has been brought up to date');
        }
      }
    }
  }
  const context = request.context ?? buildTaskContext(request.targetNodeId, request.question, withFrozenCopies(nodes, frozen.byNode));

  // the inputs, in the order the context first reads them
  const inputs: ResolvedInput[] = [];
  const byKey = new Map<string, ResolvedInput>();
  const held = new Map<string, string>();
  const add = (key: string, input: ResolvedInput) => { if (!byKey.has(key)) { byKey.set(key, input); inputs.push(input); } return byKey.get(key)!; };
  const nodeOf = (id: string) => nodes.find((n) => n.id === id);
  const attachmentInput = async (nodeId: string, attachmentId: string): Promise<ResolvedInput | null> => {
    const resolved = frozen.byNode.get(nodeId);
    if (resolved) return add(`resource:${nodeId}`, resolved.input);
    const att = nodeOf(nodeId)?.data.attachments?.find((a) => a.id === attachmentId);
    if (!att) return null;
    const image = att.type.startsWith('image/');
    const contentHash = image ? await hashBytes(bytesOfBase64(att.content)) : await hashText(att.extractedText ?? att.content ?? '');
    const size = image ? bytesOfBase64(att.content).byteLength : new TextEncoder().encode(att.extractedText ?? att.content ?? '').byteLength;
    const key = `attachment:${nodeId}:${attachmentId}`;
    if (!byKey.has(key)) held.set(key, image ? att.content : base64OfText(att.extractedText ?? att.content ?? ''));
    return add(key, {
      inputId: `in_${(await digestOf({ nodeId, attachmentId, contentHash })).slice(7, 23)}`,
      source: { kind: 'attachment', nodeId, attachmentId },
      // held on the canvas node itself: what the run was given is in the envelope's messages, and in the image digests
      snapshotId: `node:${contentHash.slice('sha256:'.length)}`,
      contentHash,
      payload: image ? 'image' : 'text',
      displayName: att.name || attachmentId,
      size: { bytes: size, ...(image ? {} : { textChars: (att.extractedText ?? att.content ?? '').length }) },
      reason: 'attached',
    });
  };

  const messages: EnvelopeMessage[] = [];
  for (const [i, m] of context.messages.entries()) {
    const raw = aligned ? context.sources[i] : undefined;
    const source: EnvelopeMessage['source'] = raw
      ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as MessageSource
      : i === context.messages.length - 1 && m.role === 'user' ? { layer: 'chain', part: 'question', nodeId: request.targetNodeId } : { layer: m.role === 'system' ? 'system' : 'chain' };
    if (raw?.nodeId && (raw.attachmentId || frozen.byNode.has(raw.nodeId)) && (raw.layer === 'material' || raw.part === 'attachment')) {
      const input = await attachmentInput(raw.nodeId, raw.attachmentId ?? nodeOf(raw.nodeId)?.data.attachments?.[0]?.id ?? '');
      if (input) source.inputId = input.inputId;
    }
    messages.push({ role: m.role, content: m.content, source });
  }
  const imageDigests: { mimeType: string; contentHash: string }[] = [];
  for (const [i, img] of context.images.entries()) {
    const from = context.imageSources[i];
    const input = from ? await attachmentInput(from.nodeId, from.attachmentId) : null;
    imageDigests.push({ mimeType: img.mimeType, contentHash: input?.payload === 'image' ? input.contentHash : await hashBytes(bytesOfBase64(img.data)) });
  }

  // what the task reads that the person left out: named, never carried
  const excluded: ExclusionRecord[] = leftOut(task, nodes, edges).map(({ nodeId, attachmentId }) => ({ source: { kind: 'attachment', nodeId, attachmentId }, reason: 'left out by the person' }));

  const runtime = request.runtimeSelection;
  const policy = policyOf(request.mode, runtime, inputs, request.tools, request.recall);
  const inputDigest = await digestOf({
    v: 1,
    messages: messages.map(({ role, content }) => ({ role, content })),
    images: imageDigests,
    // what each input is and which part of it is read: the content hash names the whole, the selector the part
    inputs: inputs.map((input) => ({ contentHash: input.contentHash, payload: input.payload, selector: input.source.kind === 'resource' ? input.source.ref.selector : null })),
  });
  const target = task.data.target;
  const targetId = target?.targetId ?? `unbound:${request.targetNodeId}`;
  const targetRevision = target?.revision ?? 'unbound';
  const executionDigest = await digestOf({
    v: 1,
    inputDigest,
    targetId,
    targetRevision,
    runtime,
    policy,
    // the form the request takes: an agent is handed one prompt compiled from the messages; an API model the messages themselves
    serialization: runtime.kind === 'agent' ? 'agent-prompt-v1' : 'chat-messages-v1',
  });
  const envelope: RunEnvelope = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: `run_${generateId()}`,
    targetId,
    targetRevision,
    taskNodeId: request.targetNodeId,
    graphId: request.graphId,
    graphRevision,
    mode: request.mode,
    messages,
    inputs,
    excluded,
    policy,
    runtime,
    inputDigest,
    executionDigest,
  };
  imagesOf.set(envelope, context.images);
  heldOf.set(envelope, Object.fromEntries([...held].map(([key, base64]) => [byKey.get(key)!.inputId, base64])));
  return envelope;
}

export interface DispatchPayload {
  messages: ContextMessage[];
  images: ImageAttachment[];
  model: string;
  toolPrefs: ToolPrefs;
  lane: string;
}

export type DispatchCheck = { ok: true; imagesDropped: boolean } | { ok: false; reason: 'messages' | 'images' | 'model' | 'tools' };

/**
 * Whether what is about to be sent is what was prepared. The messages must
 * be the envelope's, in order; the model its model; the tools within its
 * policy. Images may only all be left out, for a model that cannot see them,
 * when each has its text in the messages already.
 */
export function verifyDispatch(envelope: RunEnvelope, payload: DispatchPayload): DispatchCheck {
  const same = (a: ContextMessage[], b: { role: string; content: string }[]) => a.length === b.length && a.every((m, i) => m.role === b[i].role && m.content === b[i].content);
  if (!same(payload.messages, envelope.messages)) return { ok: false, reason: 'messages' };
  if ((payload.model || '') !== envelope.runtime.model) return { ok: false, reason: 'model' };
  if (toolsOf(payload.toolPrefs).some((tool) => !envelope.policy.tools.allow.includes(tool))) return { ok: false, reason: 'tools' };
  const expected = envelopeImages(envelope);
  if (payload.images.length === 0 && expected.length > 0) {
    return expected.every((img) => img.hasCompanion) ? { ok: true, imagesDropped: true } : { ok: false, reason: 'images' };
  }
  const sameImages = payload.images.length === expected.length && payload.images.every((img, i) => img.data === expected[i].data && img.mimeType === expected[i].mimeType);
  return sameImages ? { ok: true, imagesDropped: false } : { ok: false, reason: 'images' };
}

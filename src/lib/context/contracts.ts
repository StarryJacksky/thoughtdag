// Run contracts: one run on one AI target — the frozen input, the policy it
// runs under, the runtime it was sent to, and how it relates to a runtime's
// native session. The TypeScript reading of
// shared/schemas/run-envelope-v1.json.
//
// These build on the context compiler, not beside it: messages keep the
// per-item source buildContext reports, and digests use the sha256 form and
// canonical serialization of lib/context-bundle.

import type { AgentRuntime } from '../../types';
import type { MessageSource } from '../../store/context-builder';
import { validateDTO, type Capability, type ContentHash, type ResourceRef, type ValidationResult } from '../workspace/contracts';

/** The version a run envelope carries. */
export const RUN_SCHEMA_VERSION = '1.1';

/** A context message with where it came from. `inputId` ties a rendered
 *  material to its frozen input. */
export interface EnvelopeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  source: MessageSource & { inputId?: string };
}

/** What a frozen input was taken from. */
export type InputSource =
  | { kind: 'resource'; ref: ResourceRef }
  | { kind: 'attachment'; nodeId: string; attachmentId: string }
  | { kind: 'recall'; recallId: string };

/** One input, frozen. The snapshot is the evidence; the hash is over the
 *  exact bytes the run was given. */
export interface ResolvedInput {
  inputId: string;
  source: InputSource;
  snapshotId: string;
  contentHash: ContentHash;
  payload: 'text' | 'image' | 'metadata';
  /** a name safe to show and to write to disk; never used to tell inputs apart */
  displayName: string;
  size: { bytes: number; textChars?: number };
  /** why it is in: wired, attached, mentioned, recalled */
  reason: string;
}

/** Something wired in that this run leaves out, and why. It names the thing;
 *  it never carries its content. */
export interface ExclusionRecord {
  source: InputSource;
  reason: string;
}

/** Limits the application enforces around a run: guards, not estimates. */
export interface Budget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  maxToolCalls: number;
  maxWallTimeSeconds: number;
  /** enforced only when the provider reports usage that can be priced */
  maxCostUsd?: number;
}

/** The run guards a new target starts with; a person may change them. */
export const DEFAULT_RUN_GUARDS: Pick<Budget, 'maxToolCalls' | 'maxWallTimeSeconds'> = { maxToolCalls: 40, maxWallTimeSeconds: 900 };

export interface ExecutionPolicy {
  /** inputs-only: the run may read the listed inputs and nothing else.
   *  workspace: its tools may also read the workspace it runs in. */
  read: { scope: 'inputs-only' | 'workspace'; inputIds: string[] };
  write: { scope: 'none' | 'isolated-copy' | 'workspace' };
  tools: { allow: string[]; mcpServers: string[] };
  network: 'off' | 'on';
  recall: 'off' | 'explicit-only' | 'auto';
  budget: Budget;
}

/** What the run asked for. The model that actually answered is recorded
 *  after the run, beside this, never over it. */
export interface RuntimeSelection {
  kind: 'provider' | 'agent';
  runtime: AgentRuntime | null;
  connectionRef: string;
  model: string;
  effort: string | null;
  capabilityVersion: string | null;
}

/** The single list the preview, the request and the materialized files are
 *  all read from. Frozen when prepared: later edits to the canvas, the
 *  defaults or the files change the next run, not this one. */
export interface RunEnvelope {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: string;
  targetId: string;
  targetRevision: string;
  taskNodeId: string;
  graphId: string;
  /** the semantic snapshot hash of the canvas (graphSnapshotHash) */
  graphRevision: ContentHash;
  mode: 'research' | 'workspace';
  messages: EnvelopeMessage[];
  inputs: ResolvedInput[];
  excluded: ExclusionRecord[];
  policy: ExecutionPolicy;
  runtime: RuntimeSelection;
  /** over what the model is asked to read; the same for the same semantic
   *  input whatever the target */
  inputDigest: ContentHash;
  /** the input digest plus the target, the runtime, the policy and the
   *  serialization actually sent */
  executionDigest: ContentHash;
}

/** One AI a task node is bound to, with everything it runs under. Created
 *  from the global defaults once; changing the defaults later changes no
 *  existing target. */
export interface ExecutionTarget {
  targetId: string;
  revision: string;
  label: string;
  kind: 'provider' | 'agent';
  runtime: AgentRuntime | null;
  connectionRef: string;
  model: string;
  effort: string | null;
  roleRef: string | null;
  memoryPolicyId: string;
  policyId: string;
  workspaceId: string;
  budgetId: string;
}

export interface TargetBinding {
  graphId: string;
  taskNodeId: string;
  targetId: string;
}

export interface PreparedTargetRun {
  target: ExecutionTarget;
  envelope: RunEnvelope;
}

/** How a target relates to a runtime's own session. The thread id is what a
 *  write is addressed to; a session id is never assumed to be the same thing. */
export interface RuntimeBinding {
  bindingId: string;
  targetId: string;
  connectionRef: string;
  runtime: AgentRuntime;
  threadId: string | null;
  sessionId: string | null;
  sessionPath: string | null;
  lastCompletedTurnId: string | null;
  /** what was last seen of the native session, and how it was seen */
  nativeState: { status: 'idle' | 'busy' | 'locked' | 'unknown'; observedAt: string | null; evidence: 'app-server' | 'session-file' | 'none' };
  /** digest of the conversation prefix this application knows the session holds */
  prefixDigest: ContentHash | null;
  configDigest: ContentHash | null;
  /** owned: this application is the session's one accepted writer */
  ownership: 'owned' | 'external' | 'unknown';
}

/** What one installed runtime can do, as probed. */
export interface CapabilityReport {
  runtime: AgentRuntime;
  binaryVersion: string | null;
  probedAt: string;
  capabilities: {
    fresh: Capability; resume: Capability; forkAtCompletedTurn: Capability; observeState: Capability; cancel: Capability;
    approvals: Capability; readOnlyRoots: Capability; networkRestriction: Capability; autoContextControl: Capability;
  };
}

export type RouteDecision =
  | { action: 'fresh'; reason: string }
  | { action: 'resume'; bindingId: string; reason: string }
  | { action: 'fork-prefix'; bindingId: string; lastCompletedTurnId: string; reason: string }
  | { action: 'blocked'; reason: string };

/** `unknown` is a state of its own: a run whose submission could not be
 *  confirmed is looked up, never resent. */
export type RunState = 'prepared' | 'starting' | 'running' | 'awaiting-approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';

/** The run kinds that can be validated by name. */
export interface RunDTOs {
  EnvelopeMessage: EnvelopeMessage;
  InputSource: InputSource;
  ResolvedInput: ResolvedInput;
  ExclusionRecord: ExclusionRecord;
  Budget: Budget;
  ExecutionPolicy: ExecutionPolicy;
  RuntimeSelection: RuntimeSelection;
  RunEnvelope: RunEnvelope;
  ExecutionTarget: ExecutionTarget;
  TargetBinding: TargetBinding;
  RuntimeBinding: RuntimeBinding;
  CapabilityReport: CapabilityReport;
  RouteDecision: RouteDecision;
  RunState: RunState;
}

/** validateDTO for the run kinds, typed. */
export function validateRunDTO<K extends keyof RunDTOs>(kind: K, value: unknown): ValidationResult<RunDTOs[K]> {
  return validateDTO(kind, value) as ValidationResult<RunDTOs[K]>;
}

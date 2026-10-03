import type { AgentRuntime, ApprovalOutcome, ThoughtEdge, ThoughtNode } from '../../../src/types';

// Research fixtures are small synthetic canvases. Every text marker in them
// is made up (EXCLUDED_SECRET_K7 and the like); nothing comes from a real
// session, project or home directory.

export interface FixtureAttachment {
  id: string;
  name: string;
  /** MIME type; text/markdown when absent */
  type?: string;
  content: string;
  /** where the file is said to come from, for scenarios about identity */
  origin?: string;
}

/** A node as a fixture file writes it: only what the scenario is about. */
export interface FixtureNode {
  id: string;
  question?: string;
  response?: string;
  stepKind?: 'note' | 'file' | 'link';
  attachments?: FixtureAttachment[];
  excludedAttachmentIds?: string[];
  includedAttachmentIds?: string[];
  archived?: boolean;
  rolePrompt?: string;
  /** the model this node's line is pinned to (a picker id); children asked from it inherit the pin */
  model?: string;
  /** approvals decided on this node's turn; `rule` names what a standing allowance covers */
  approvals?: { id: string; outcome: ApprovalOutcome; rule: string }[];
  importSource?: { runner: string; sessionId: string; itemIds: string[]; cwd?: string };
  agentSession?: { runtime: AgentRuntime; sessionId: string | null; sessionFile: string | null; cwd: string };
  source?: { question: string; response: string };
}

export interface FixtureEdge {
  source: string;
  target: string;
  isCrossLink?: boolean;
  contextDepth?: 'full';
}

/** One change applied to `graph` to produce the scenario's second state.
 *  A fixture lists exactly the variable it studies, nothing else. */
export interface FixtureEdit {
  nodeId: string;
  field: 'question' | 'response';
  value: string;
}

/** What the native session the canvas subscribes to already holds. */
export interface FixtureNativeHistory {
  runner: AgentRuntime;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  /** the canvas node mirroring the session's last turn */
  tailNodeId: string;
  importedCount: number;
}

export interface FixturePolicy {
  mode: 'research' | 'workspace';
  /** a picker id, e.g. codex/<model>; for multi-task fixtures, the toolbar's pick when the scenario starts */
  model: string;
  cwd: string;
  /** the global agent effort when the scenario starts */
  effort?: string;
}

/** One question a scenario asks, and what its run must and must not be handed. */
export interface FixtureTask {
  name: string;
  /** the node the question is asked from */
  parentNodeId: string;
  question: string;
  promptContains?: string[];
  promptExcludes?: string[];
  readableContains?: string[];
  readableExcludes?: string[];
}

export interface FixtureExpectation {
  /** the node about to generate; in a multi-task fixture, the node the first task asks from */
  targetNodeId: string;
  route?: 'fresh' | 'resume';
  promptContains?: string[];
  promptExcludes?: string[];
  /** over everything the agent could read from disk */
  readableContains?: string[];
  readableExcludes?: string[];
}

/** The JSON on disk. */
export interface ResearchFixtureFile {
  description: string;
  graph: { nodes: FixtureNode[]; edges: FixtureEdge[] };
  edits?: FixtureEdit[];
  files?: Record<string, string>;
  nativeHistory?: FixtureNativeHistory | null;
  policy: FixturePolicy;
  expected: FixtureExpectation;
  /** several questions asked on one canvas (the multi-target scenarios) */
  tasks?: FixtureTask[];
  // Routing fixtures (T14) and mind-map fixtures (T18) add these; their
  // types arrive with the contracts those tasks define.
  envelope?: unknown;
  binding?: unknown;
  capabilities?: unknown;
  before?: unknown;
  after?: unknown;
  wholeSelection?: unknown;
  budget?: unknown;
}

export interface FixtureGraph {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
}

/** A fixture as tests use it: the canvas expanded to store shapes. */
export interface ResearchFixture extends Omit<ResearchFixtureFile, 'graph' | 'files' | 'nativeHistory'> {
  name: string;
  graph: FixtureGraph;
  /** `graph` with `edits` applied; the same object as `graph` when there are none */
  edited: FixtureGraph;
  files: Record<string, string>;
  nativeHistory: FixtureNativeHistory | null;
}

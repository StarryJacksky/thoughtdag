// Whether a run can be held to the policy its envelope states, on the
// runtime it is to run on: the page's copy of the shell's rule
// (runtime/execution/policy.cjs), applied before anything is sent. The two
// are held to one table by tests/unit/policy-parity.test.ts.
//
// Research is a promise: the run reads its inputs and nothing else,
// offline, with no memory of its own and no tool the person did not give
// it. A model called through its API is given its messages and nothing
// else, so the promise is kept by what the envelope asks for. An agent has
// tools of its own: the promise is kept only when the runtime is known to
// be able to hold it to its inputs, keep it offline and keep its own memory
// out. What is not known to be supported is not promised. Working mode
// runs; an agent's tools there can read more than its inputs, and the run
// says so.

import type { CapabilityReport, RunEnvelope } from './contracts';

/** What an agent runtime must be known to support for research. */
export const ISOLATION = ['readOnlyRoots', 'networkRestriction', 'autoContextControl'] as const;

export type PolicyBlock = (typeof ISOLATION)[number] | 'read' | 'write' | 'tools' | 'network' | 'recall' | 'mode';
export interface PolicyResult {
  ok: boolean;
  /** what the run cannot be held to: a capability not known to be supported, or a part of the policy research does not allow */
  blocked: PolicyBlock[];
  /** what the person is told about a run that runs */
  notice: 'workspace-readable' | null;
}

export function verifyPolicy(envelope: Pick<RunEnvelope, 'mode' | 'runtime' | 'policy'>, capabilities: CapabilityReport | null): PolicyResult {
  const { mode, runtime, policy } = envelope;
  const blocked: PolicyBlock[] = [];
  if (mode === 'research') {
    if (runtime.kind === 'agent') {
      const known: Partial<Record<string, string>> = capabilities && capabilities.runtime === runtime.runtime ? capabilities.capabilities : {};
      for (const c of ISOLATION) if (known[c] !== 'supported') blocked.push(c);
    }
    if (policy.read?.scope !== 'inputs-only') blocked.push('read');
    if (policy.write?.scope === 'workspace') blocked.push('write');
    if ((policy.tools?.allow ?? []).length > 0 || (policy.tools?.mcpServers ?? []).length > 0) blocked.push('tools');
    if (policy.network !== 'off') blocked.push('network');
    if (policy.recall === 'auto') blocked.push('recall');
  } else if (mode !== 'workspace') {
    blocked.push('mode');
  }
  return { ok: blocked.length === 0, blocked, notice: mode === 'workspace' && runtime.kind === 'agent' ? 'workspace-readable' : null };
}

/**
 * What is known of a runtime's capabilities. Nothing yet: the probes that
 * find out what an installed Codex or Claude Code can enforce are T15 and
 * T16. Until then every capability is unknown, and research by an agent is
 * refused.
 */
export function capabilitiesOf(runtime: string | null): CapabilityReport | null {
  void runtime;
  return null;
}

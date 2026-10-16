import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { verifyPolicy } from '../../src/lib/context/policy';
import type { CapabilityReport, ExecutionPolicy, RunEnvelope } from '../../src/lib/context/contracts';

// The page checks a run's policy before it sends; the shell checks it again
// before it writes an agent's materials. The two must be one rule: every
// case of this table gets the same answer from both.

const require = createRequire(import.meta.url);
const shell = require('../../runtime/execution/policy.cjs') as { verifyPolicy: (e: unknown, c: unknown) => unknown };

const base: ExecutionPolicy = { read: { scope: 'inputs-only', inputIds: [] }, write: { scope: 'none' }, tools: { allow: [], mcpServers: [] }, network: 'off', recall: 'off', budget: { maxInputTokens: 1, reservedOutputTokens: 1, maxToolCalls: 1, maxWallTimeSeconds: 1 } };
const agent = { kind: 'agent' as const, runtime: 'codex' as const, connectionRef: 'c', model: 'codex/x', effort: null, capabilityVersion: null };
const api = { kind: 'provider' as const, runtime: null, connectionRef: 'p', model: 'p/m', effort: null, capabilityVersion: null };
const report = (state: 'supported' | 'unsupported' | 'unknown', runtime: 'codex' | 'claude-code' = 'codex'): CapabilityReport => ({
  runtime, binaryVersion: '1', probedAt: '2026-10-16T00:00:00Z',
  capabilities: { fresh: 'supported', resume: 'supported', forkAtCompletedTurn: state, observeState: state, cancel: state, approvals: state, readOnlyRoots: state, networkRestriction: state, autoContextControl: state },
});

const cases: [string, Pick<RunEnvelope, 'mode' | 'runtime' | 'policy'>, CapabilityReport | null][] = [];
for (const mode of ['research', 'workspace', 'other'] as const) {
  for (const runtime of [agent, api]) {
    for (const caps of [null, report('unknown'), report('supported'), report('unsupported'), report('supported', 'claude-code')]) {
      for (const policy of [
        base,
        { ...base, read: { scope: 'workspace' as const, inputIds: [] } },
        { ...base, write: { scope: 'workspace' as const } },
        { ...base, tools: { allow: ['web_search'], mcpServers: [] } },
        { ...base, tools: { allow: [], mcpServers: ['m'] } },
        { ...base, network: 'on' as const },
        { ...base, recall: 'auto' as const },
        { ...base, recall: 'explicit-only' as const },
      ]) cases.push([`${mode} · ${runtime.kind} · ${caps ? `${caps.runtime} ${caps.capabilities.readOnlyRoots}` : 'no report'} · ${JSON.stringify(policy).length}`, { mode: mode as RunEnvelope['mode'], runtime, policy }, caps]);
    }
  }
}

describe('the policy rule, on the page and in the shell', () => {
  it(`[T12] gives the same answer for each of ${cases.length} cases`, () => {
    for (const [name, envelope, caps] of cases) expect(verifyPolicy(envelope, caps), name).toEqual(shell.verifyPolicy(envelope, caps));
  });
  it('[T12] refuses research by an agent of whose capabilities nothing is known, and lets the same agent work', () => {
    expect(verifyPolicy({ mode: 'research', runtime: agent, policy: base }, null).ok).toBe(false);
    expect(verifyPolicy({ mode: 'workspace', runtime: agent, policy: { ...base, read: { scope: 'workspace', inputIds: [] }, network: 'on' } }, null)).toEqual({ ok: true, blocked: [], notice: 'workspace-readable' });
  });
});

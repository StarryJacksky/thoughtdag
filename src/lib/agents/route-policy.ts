// Whether a run goes on in a native session or starts a new one, and why.
// A run goes on in a session only when what it is to be given above its
// question is exactly what the session holds: the session's turns as they
// were, and nothing else. Anything more or different (an answer or a
// question rewritten on the canvas, a file or an answer wired in, a role,
// a memory or recall, a turn left out or added) starts a new session that
// is given the whole of it, so nothing the run should see is lost by going
// on where it was. What the session holds is not known is not gone on in.
// Research always starts anew, and is not run at all on an agent not known
// to keep to its inputs. Forking a session at an earlier turn is not done
// while it is not known to work.
//
// The reasons are codes, said to the person in their words (route.reason.*).

import type { CapabilityReport, RouteDecision, RunEnvelope } from '../context/contracts';
import { verifyPolicy } from '../context/policy';
import type { SessionBinding } from './runtime-binding';

export type PrefixComparison =
  | { result: 'equal' }
  | { result: 'changed'; reason: 'role' | 'memory' | 'materials' | 'conversation' | 'edited' }
  | { result: 'unknown'; reason: 'unknown-history' };

/**
 * What the run is to be given above its question, against what the session holds. The question is
 * the run's last message; everything before it must be the session's turns, as they were.
 */
export function inspectExpectedPrefix(envelope: Pick<RunEnvelope, 'messages'>, binding: Pick<SessionBinding, 'holds'>): PrefixComparison {
  if (!binding.holds) return { result: 'unknown', reason: 'unknown-history' };
  const above = envelope.messages.slice(0, -1);
  if (above.some((m) => m.source.layer === 'system' && m.source.part === 'role')) return { result: 'changed', reason: 'role' };
  if (above.some((m) => m.source.layer === 'system')) return { result: 'changed', reason: 'memory' };
  if (above.some((m) => m.source.layer !== 'chain' || m.source.part === 'attachment')) return { result: 'changed', reason: 'materials' };
  if (above.length !== binding.holds.length || above.some((m, i) => m.role !== binding.holds![i].role)) return { result: 'changed', reason: 'conversation' };
  if (above.some((m, i) => m.content !== binding.holds![i].content)) return { result: 'changed', reason: 'edited' };
  return { result: 'equal' };
}

/** How a run of `envelope` goes: on in the bound session, in a new one, or not at all. */
export function decideRoute(envelope: RunEnvelope, binding: SessionBinding | null, capabilities: CapabilityReport | null): RouteDecision {
  if (envelope.mode === 'research') {
    return verifyPolicy(envelope, capabilities).ok ? { action: 'fresh', reason: 'research' } : { action: 'blocked', reason: 'research-unverified' };
  }
  if (!binding) return { action: 'fresh', reason: 'no-session' };
  if (envelope.runtime.runtime !== binding.runtime) return { action: 'fresh', reason: 'other-runtime' };
  const known = capabilities && capabilities.runtime === binding.runtime ? capabilities.capabilities : null;
  if (known?.resume === 'unsupported') return { action: 'fresh', reason: 'resume-unsupported' };
  if (binding.nativeState.status === 'busy' || binding.nativeState.status === 'locked') return { action: 'blocked', reason: 'session-busy' };
  const prefix = inspectExpectedPrefix(envelope, binding);
  if (prefix.result !== 'equal') return { action: 'fresh', reason: prefix.reason };
  return { action: 'resume', bindingId: binding.bindingId, reason: 'same-conversation' };
}

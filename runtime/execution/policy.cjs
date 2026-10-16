// Whether a run can be held to the policy its envelope states, on the
// runtime it is to run on. Research is a promise: the run reads its inputs
// and nothing else, offline, with no memory of its own and no tool the
// person did not give it. A model called through its API is given its
// messages and nothing else, so the promise is kept by what the envelope
// asks for. An agent has tools of its own, and the promise is kept only
// when the runtime is known to be able to hold it to its inputs, keep it
// offline and keep its own memory out: a capability that is not known to
// be supported is not promised, and the run is refused rather than run as
// if it were. Working mode runs; an agent's tools there can read more than
// its inputs, and the run says so.
//
// The page applies the same rules before it sends (src/lib/context/policy.ts);
// tests/unit/policy-parity.test.ts holds the two to one table.
'use strict';

/** What an agent runtime must be known to support for research. */
const ISOLATION = ['readOnlyRoots', 'networkRestriction', 'autoContextControl'];

/**
 * `{ ok, blocked, notice }`: `blocked` names what the run cannot be held to
 * (a capability, or a part of the policy that research does not allow);
 * `notice` is what the person is told about a run that runs.
 */
function verifyPolicy(envelope, capabilities) {
  const mode = envelope && envelope.mode;
  const runtime = (envelope && envelope.runtime) || {};
  const policy = (envelope && envelope.policy) || {};
  const blocked = [];
  if (mode === 'research') {
    if (runtime.kind === 'agent') {
      const known = capabilities && capabilities.runtime === runtime.runtime ? capabilities.capabilities || {} : {};
      for (const c of ISOLATION) if (known[c] !== 'supported') blocked.push(c);
    }
    if (!policy.read || policy.read.scope !== 'inputs-only') blocked.push('read');
    if (policy.write && policy.write.scope === 'workspace') blocked.push('write');
    if (policy.tools && ((policy.tools.allow || []).length > 0 || (policy.tools.mcpServers || []).length > 0)) blocked.push('tools');
    if (policy.network !== 'off') blocked.push('network');
    if (policy.recall === 'auto') blocked.push('recall');
  } else if (mode !== 'workspace') {
    blocked.push('mode');
  }
  const notice = mode === 'workspace' && runtime.kind === 'agent' ? 'workspace-readable' : null;
  return { ok: blocked.length === 0, blocked, notice };
}

module.exports = { verifyPolicy, ISOLATION };

// A ChatGPT space as a workspace source, as far as it goes today: nowhere.
// There is no interface a standalone client may use to reach a space (see
// docs/research-workspace/space-capability-report.md), so this provider
// answers every call with what is known: capabilities from the probe (all
// unknown, both gates blocked) and a refusal that says why. It never
// returns an empty listing: "blocked" and "empty" are different answers.
//
// When a verified interface exists, a real provider takes this one's place
// in the registry. Nothing above the registry changes.
'use strict';

const { probeSpaceAccess } = require('./space-capabilities.cjs');
const { WorkspaceAccessError } = require('../path-policy.cjs');

function assertSpace(scope) {
  if (!scope || scope.kind !== 'chatgpt-space') throw new WorkspaceAccessError('wrong-source', 'this is not a space workspace');
}

function createBlockedSpaceProvider({ adapter = null, now } = {}) {
  const report = (scope) => probeSpaceAccess(scope.connectionRef, { adapter, ...(now ? { now } : {}) });
  const refuse = async (scope) => {
    assertSpace(scope);
    const { blockers } = await report(scope);
    throw new WorkspaceAccessError('blocked', blockers[0] ?? 'this space cannot be reached');
  };
  return {
    async capabilities(scope) {
      assertSpace(scope);
      return (await report(scope)).capabilities;
    },
    /** The full report behind the capabilities: gates, evidence, what blocks. */
    async diagnose(scope) {
      assertSpace(scope);
      return report(scope);
    },
    list: refuse,
    read: refuse,
    create: refuse,
    /** A write is answered, not thrown: the caller gets a result it can show. */
    async write(scope) {
      assertSpace(scope);
      const { blockers } = await report(scope);
      return { status: 'unsupported', reason: blockers[0] ?? 'this space cannot be written' };
    },
  };
}

module.exports = { createBlockedSpaceProvider };

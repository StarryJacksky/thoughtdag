// Which provider answers for a workspace. The one place that looks at a
// workspace's kind; everything else asks here and then speaks to whatever
// comes back through the same five calls.
'use strict';

const { WorkspaceAccessError } = require('../path-policy.cjs');
const { createLocalProvider } = require('./local.cjs');
const { createBlockedSpaceProvider } = require('./space-blocked.cjs');

/**
 * `service` is the local workspace service. `providers` replaces or adds a
 * provider by workspace kind; a kind nobody registered is refused, never
 * routed to the local disk.
 */
function createProviderRegistry({ service, providers = {} }) {
  const byKind = new Map(Object.entries({
    local: createLocalProvider(service),
    'chatgpt-space': createBlockedSpaceProvider(),
    ...providers,
  }));

  function providerOf(scope) {
    const provider = scope && typeof scope.kind === 'string' ? byKind.get(scope.kind) : undefined;
    if (!provider) throw new WorkspaceAccessError('unknown-source', 'no provider answers for that kind of workspace');
    return provider;
  }

  return {
    /** The provider for a workspace record. */
    providerOf,

    /** The record and the provider of an open local workspace, by its id. */
    async providerFor(workspaceId) {
      const scope = await service.workspaceRecord(workspaceId);
      return { scope, provider: providerOf(scope) };
    },

    kinds: () => [...byKind.keys()].sort(),
  };
}

module.exports = { createProviderRegistry };

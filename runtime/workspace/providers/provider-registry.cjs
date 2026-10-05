// Which provider answers for a workspace. The one place that looks at a
// workspace's kind; everything else asks here and then speaks to whatever
// comes back through the same calls.
'use strict';

const { WorkspaceAccessError } = require('../path-policy.cjs');
const { createLocalProvider } = require('./local.cjs');
const { createBlockedSpaceProvider } = require('./space-blocked.cjs');

/**
 * `service` is the local workspace service. `providers` replaces or adds a
 * provider by workspace kind; a kind nobody registered is refused, never
 * routed to the local disk. `remote` is what knows the open workspaces that
 * are not local folders: `workspaces()` lists their records and
 * `workspaceOfFile(fileId)` says which of them a file id belongs to. There
 * are none today; a real space connection supplies it.
 */
function createProviderRegistry({ service, providers = {}, remote = null }) {
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
  const found = (scope) => ({ scope, provider: providerOf(scope) });

  return {
    /** The provider for a workspace record. */
    providerOf,

    /** The record and the provider of an open workspace, by its id. */
    async providerFor(workspaceId) {
      let localError = null;
      try { return found(await service.workspaceRecord(workspaceId)); } catch (e) {
        if (!(e instanceof WorkspaceAccessError) || e.code !== 'no-grant') throw e;
        localError = e;
      }
      const scope = remote ? (await remote.workspaces()).find((w) => w.workspaceId === workspaceId) : null;
      if (!scope) throw localError;
      return found(scope);
    },

    /** The record and the provider of the open workspace a file belongs to, by the file's id. */
    async providerForFile(fileId) {
      const record = await service.resourceRecord(fileId);
      if (record) return found(await service.workspaceRecord(record.workspaceId));
      const scope = remote ? await remote.workspaceOfFile(fileId) : null;
      if (!scope) throw new WorkspaceAccessError('unknown-file', 'that file is not known to an open workspace');
      return found(scope);
    },

    /** Every open workspace, whatever kind of source it is. */
    async workspaces() {
      return [...(await service.listWorkspaces()), ...(remote ? await remote.workspaces() : [])];
    },

    kinds: () => [...byKind.keys()].sort(),
  };
}

module.exports = { createProviderRegistry };

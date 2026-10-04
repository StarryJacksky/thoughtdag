// What every caller of a workspace source does the same way, whichever kind
// of source it is: tell two resources apart, read a listing to its end, and
// decide whether an operation may be attempted at all. Shared by the host
// and the renderer, like the contract validator.
//
// A caller written against these never needs to know whether the source is
// a local folder or a remote space. The differences are in the capabilities
// a source reports, not in code that asks what kind it is.

/**
 * A key that is the same for the same resource and different for any other,
 * across sources. Built from the locator's own fields, never from a path
 * join: a remote object whose id happens to look like a path is not a file.
 */
export function locatorKey(locator) {
  if (locator?.kind === 'local') return JSON.stringify(['local', locator.rootGrantId, locator.relativePath]);
  if (locator?.kind === 'chatgpt-space') return JSON.stringify(['chatgpt-space', locator.connectionRef, locator.accountScope, locator.spaceId, locator.objectId]);
  throw new Error('that is not a resource locator');
}

/** Whether a capability report lets `operation` be attempted. Only `supported` does. */
export function canDo(capabilities, operation) {
  return !!capabilities && capabilities[operation] === 'supported';
}

/**
 * The revision a write must name to replace what `read` returned: the
 * source's own version where it has one, else the hash of the content.
 */
export function writeBaseOf(read) {
  return read.sourceRevision ?? read.contentHash;
}

/**
 * Read a listing to its end, following the source's own cursors.
 * Resolves with `{ entries, completeness }`. A listing is `partial` when any
 * page said so: an empty partial listing is "could not be listed", never
 * "the folder is empty". A source that hands back a cursor it already gave
 * would loop forever; that is an error, not a longer listing.
 */
export async function collectPages(provider, scope, parentId, { maxPages = 1000 } = {}) {
  const entries = [];
  const seen = new Set();
  let completeness = 'complete';
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const result = await provider.list(scope, parentId, cursor);
    entries.push(...result.entries);
    if (result.completeness !== 'complete') completeness = 'partial';
    if (result.nextCursor === null || result.nextCursor === undefined) return { entries, completeness };
    if (seen.has(result.nextCursor)) throw new Error('the source repeated a listing cursor');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  // more pages than anyone should need: what was read is kept, and it is not called complete
  return { entries, completeness: 'partial' };
}

/**
 * Write through a provider only when the source is known to support it.
 * Anything short of `supported` is answered here, and the provider's write
 * is never called.
 */
export async function writeThrough(provider, scope, request) {
  const capabilities = await provider.capabilities(scope, request.fileId);
  if (!canDo(capabilities, 'update')) return { status: 'unsupported', reason: `this source does not support updating (${capabilities?.update ?? 'unknown'})` };
  if (request.representation === 'blocks' && !canDo(capabilities, 'pagePatch')) return { status: 'unsupported', reason: `this source does not support editing pages in place (${capabilities?.pagePatch ?? 'unknown'})` };
  return provider.write(scope, request);
}

/** createFile through a provider, refused here unless the source is known to support creating. */
export async function createThrough(provider, scope, request) {
  const capabilities = await provider.capabilities(scope);
  if (!canDo(capabilities, 'create')) {
    const error = new Error(`this source does not support creating files (${capabilities?.create ?? 'unknown'})`);
    error.code = 'unsupported';
    throw error;
  }
  return provider.create(scope, request);
}

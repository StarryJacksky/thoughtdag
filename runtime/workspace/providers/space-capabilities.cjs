// What a connection to a ChatGPT space can do, decided from evidence only.
//
// No adapter ships with this file. As of the review recorded in
// docs/research-workspace/space-capability-report.md, the source documents no
// interface a standalone client may use to list, read or write a space, so
// with no adapter every capability is unknown and both gates are blocked. An
// adapter is whatever later talks to a verified interface; it reports what it
// tried and what happened, and this module turns that into capabilities.
//
// The rules, each of which a test holds:
//   - no authorization, an expired one, or a share link is not a connection
//   - a capability rests on its own evidence: reading proves nothing about
//     creating, and downloading a file proves nothing about patching a page
//   - a gate passes only on verified evidence
//   - a write is refused unless its capability is `supported`
//   - nothing an adapter returns beyond the named evidence fields is kept, so
//     a credential cannot ride into a report or a log
'use strict';

/** The source's own documentation that was reviewed, and when. */
const SPACE_DOCUMENTATION = Object.freeze([
  { title: 'Getting started with Space in ChatGPT', url: 'https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt', checkedAt: '2026-10-03' },
  { title: 'ChatGPT Space: sharing, data, and controls', url: 'https://help.openai.com/en/articles/20001544-chatgpt-space-sharing-data-and-controls', checkedAt: '2026-10-03' },
  { title: 'ChatGPT Space (product documentation)', url: 'https://learn.chatgpt.com/docs/space', checkedAt: '2026-10-03' },
  { title: 'ChatGPT developer documentation', url: 'https://developers.openai.com/chatgpt', checkedAt: '2026-10-03' },
  { title: 'Sign in with ChatGPT', url: 'https://developers.openai.com/siwc', checkedAt: '2026-10-03' },
  { title: 'Plugins', url: 'https://developers.openai.com/plugins', checkedAt: '2026-10-03' },
]);

const CAPABILITIES = ['list', 'read', 'create', 'update', 'move', 'trash', 'conditionalWrite', 'pagePatch', 'changes', 'uploadCustomType'];
const WRITES = new Set(['create', 'update', 'move', 'trash', 'pagePatch', 'uploadCustomType']);
const AUTH_METHODS = new Set(['official-api', 'host-bridge', 'source-connector']);
const NO_INTERFACE = 'no interface for a standalone client to reach a space is documented by the source (reviewed 2026-10-03)';

const allUnknown = () => Object.fromEntries(CAPABILITIES.map((c) => [c, 'unknown']));

/** One evidence entry, reduced to the fields a report may hold. */
function cleanEvidence(entry) {
  const outcome = ['verified', 'failed', 'untested'].includes(entry?.outcome) ? entry.outcome : 'untested';
  const clean = { operation: String(entry?.operation ?? ''), outcome, at: String(entry?.at ?? '') };
  if (typeof entry?.note === 'string') clean.note = entry.note;
  return clean;
}

/** verified → supported, failed → unsupported, anything else → unknown. */
function capabilityFrom(evidence, operation) {
  const tried = evidence.filter((e) => e.operation === operation);
  if (tried.some((e) => e.outcome === 'verified')) return 'supported';
  if (tried.some((e) => e.outcome === 'failed')) return 'unsupported';
  return 'unknown';
}

/**
 * Probe one connection. `adapter.probe(connectionRef)` resolves with
 * `{ authMethod, authStatus, scope: { accountScope, spaceId }, evidence: [...] }`;
 * with no adapter the report says so and blocks.
 */
async function probeSpaceAccess(connectionRef, { adapter = null, now = () => new Date().toISOString() } = {}) {
  const report = {
    connectionRef: typeof connectionRef === 'string' && connectionRef ? connectionRef : null,
    observedAt: now(),
    authMethod: 'none',
    authStatus: 'none',
    scope: { accountScope: null, spaceId: null },
    capabilities: allUnknown(),
    stableIds: 'unknown',
    gates: { read: 'blocked', write: 'blocked' },
    sourceDocumentation: SPACE_DOCUMENTATION.map((d) => ({ ...d })),
    probeEvidence: [],
    blockers: [],
  };
  if (!adapter) {
    report.blockers.push(NO_INTERFACE);
    return report;
  }

  let probed;
  try { probed = await adapter.probe(report.connectionRef); } catch (e) {
    report.blockers.push('the probe failed: ' + (e instanceof Error ? e.message : String(e)));
    return report;
  }
  const evidence = (Array.isArray(probed?.evidence) ? probed.evidence : []).map(cleanEvidence).filter((e) => e.operation);
  report.probeEvidence = evidence;
  report.authMethod = AUTH_METHODS.has(probed?.authMethod) ? probed.authMethod : 'none';
  report.authStatus = ['authorized', 'unauthorized', 'expired', 'share-link-only'].includes(probed?.authStatus) ? probed.authStatus : 'none';
  report.scope = {
    accountScope: typeof probed?.scope?.accountScope === 'string' ? probed.scope.accountScope : null,
    spaceId: typeof probed?.scope?.spaceId === 'string' ? probed.scope.spaceId : null,
  };

  // not connected: whatever was tried, nothing counts
  if (report.authMethod === 'none' || report.authStatus !== 'authorized') {
    report.blockers.push(report.authStatus === 'share-link-only'
      ? 'a share link is not an authorized connection to the space'
      : `the connection is not authorized (${report.authStatus})`);
    return report;
  }
  if (!report.scope.spaceId) report.blockers.push('the authorization names no space: it must be scoped to a chosen space, not the whole account');

  for (const c of CAPABILITIES) report.capabilities[c] = capabilityFrom(evidence, c);
  report.stableIds = capabilityFrom(evidence, 'stableIds');

  const { capabilities } = report;
  const readReady = !!report.scope.spaceId && capabilities.list === 'supported' && capabilities.read === 'supported' && report.stableIds === 'supported';
  if (!readReady) report.blockers.push('reading is not verified: listing, reading and stable object ids must each be shown on a real space');
  report.gates.read = readReady ? 'passed' : 'blocked';

  // writing back needs a write that cannot silently overwrite someone else's change
  const writeReady = readReady && capabilities.update === 'supported' && capabilities.conditionalWrite === 'supported';
  if (readReady && !writeReady) report.blockers.push('writing is not verified: an update and a version-conditional write must each be shown on a real space');
  report.gates.write = writeReady ? 'passed' : 'blocked';
  return report;
}

/**
 * Whether `operation` may run under this report: `{ allowed: true }` or
 * `{ allowed: false, reason }`. Anything short of `supported` is refused.
 */
function checkSpaceOperation(report, operation) {
  if (!CAPABILITIES.includes(operation)) return { allowed: false, reason: `unknown operation "${operation}"` };
  const gate = WRITES.has(operation) || operation === 'conditionalWrite' ? report?.gates?.write : report?.gates?.read;
  if (gate !== 'passed') return { allowed: false, reason: `the ${WRITES.has(operation) || operation === 'conditionalWrite' ? 'write' : 'read'} gate is blocked` };
  const capability = report.capabilities?.[operation];
  if (capability !== 'supported') return { allowed: false, reason: `${operation} is ${capability ?? 'unknown'} on this space` };
  return { allowed: true };
}

module.exports = { probeSpaceAccess, checkSpaceOperation, SPACE_DOCUMENTATION };

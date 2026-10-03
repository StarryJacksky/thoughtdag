// The space capability gate. No real space is contacted here: the adapters
// are fakes that report what a probe "tried", and the tests hold the rules by
// which that evidence does or does not open the read and write gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeSpaceAccess, checkSpaceOperation, SPACE_DOCUMENTATION } = require('../../runtime/workspace/providers/space-capabilities.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const NOW = '2026-10-03T00:00:00Z';
const at = NOW;
const verified = (...operations) => operations.map((operation) => ({ operation, outcome: 'verified', at }));
const adapter = (probed) => ({ probe: async () => probed });
const probe = (probed) => probeSpaceAccess('conn_space_1', { adapter: adapter(probed), now: () => NOW });
const authorized = (evidence) => ({ authMethod: 'official-api', authStatus: 'authorized', scope: { accountScope: 'acct_1', spaceId: 'space_1' }, evidence });
const WRITES = ['create', 'update', 'move', 'trash', 'pagePatch', 'uploadCustomType', 'conditionalWrite'];
const ALL = ['list', 'read', ...WRITES, 'changes'];

async function assertValid(report) {
  const { validateDTO } = await loadContracts();
  const result = validateDTO('SpaceCapabilityReport', report);
  assert.ok(result.ok, JSON.stringify(result.errors));
}

test('with no adapter the space is blocked, every capability unknown, and the report says why', async () => {
  const report = await probeSpaceAccess('conn_space_1', { now: () => NOW });
  await assertValid(report);
  assert.equal(report.authMethod, 'none');
  assert.deepEqual(report.gates, { read: 'blocked', write: 'blocked' });
  assert.deepEqual([...new Set(Object.values(report.capabilities))], ['unknown']);
  assert.equal(report.stableIds, 'unknown');
  assert.equal(report.blockers.length, 1);
  assert.match(report.blockers[0], /no interface/);
  assert.deepEqual(report.sourceDocumentation, SPACE_DOCUMENTATION);
  assert.deepEqual(report.probeEvidence, []);
});

test('a blocked report refuses every operation, reads included', async () => {
  const report = await probeSpaceAccess('conn_space_1', { now: () => NOW });
  for (const operation of ALL) assert.equal(checkSpaceOperation(report, operation).allowed, false, operation);
});

for (const authStatus of ['unauthorized', 'expired', 'share-link-only']) {
  test(`a connection that is ${authStatus} is not a connection, whatever the probe claims to have done`, async () => {
    const report = await probe({ ...authorized(verified('list', 'read', 'stableIds', 'update', 'conditionalWrite')), authStatus });
    await assertValid(report);
    assert.deepEqual(report.gates, { read: 'blocked', write: 'blocked' });
    assert.deepEqual([...new Set(Object.values(report.capabilities))], ['unknown']);
    for (const operation of ALL) assert.equal(checkSpaceOperation(report, operation).allowed, false, operation);
  });
}

test('an authorization that names no space is blocked: the whole account is not a scope', async () => {
  const report = await probe({ ...authorized(verified('list', 'read', 'stableIds')), scope: { accountScope: 'acct_1', spaceId: null } });
  await assertValid(report);
  assert.equal(report.gates.read, 'blocked');
  assert.ok(report.blockers.some((b) => /names no space/.test(b)));
});

test('verified listing, reading and stable ids open the read gate and nothing else', async () => {
  const report = await probe(authorized(verified('list', 'read', 'stableIds')));
  await assertValid(report);
  assert.deepEqual(report.gates, { read: 'passed', write: 'blocked' });
  assert.equal(checkSpaceOperation(report, 'list').allowed, true);
  assert.equal(checkSpaceOperation(report, 'read').allowed, true);
  // reading proves nothing about writing
  for (const operation of WRITES) {
    assert.equal(report.capabilities[operation], 'unknown', operation);
    assert.equal(checkSpaceOperation(report, operation).allowed, false, operation);
  }
});

test('reading without stable ids does not open the read gate', async () => {
  const report = await probe(authorized(verified('list', 'read')));
  assert.equal(report.gates.read, 'blocked');
  assert.equal(checkSpaceOperation(report, 'read').allowed, false);
});

test('a file that downloads does not make native pages editable', async () => {
  const report = await probe(authorized(verified('list', 'read', 'stableIds', 'update', 'conditionalWrite')));
  await assertValid(report);
  assert.deepEqual(report.gates, { read: 'passed', write: 'passed' });
  assert.equal(report.capabilities.pagePatch, 'unknown');
  assert.equal(checkSpaceOperation(report, 'update').allowed, true);
  assert.deepEqual(checkSpaceOperation(report, 'pagePatch'), { allowed: false, reason: 'pagePatch is unknown on this space' });
  assert.equal(checkSpaceOperation(report, 'create').allowed, false);
});

test('an update with no version-conditional write does not open the write gate', async () => {
  const report = await probe(authorized(verified('list', 'read', 'stableIds', 'update')));
  assert.deepEqual(report.gates, { read: 'passed', write: 'blocked' });
  assert.equal(checkSpaceOperation(report, 'update').allowed, false);
  assert.ok(report.blockers.some((b) => /version-conditional/.test(b)));
});

test('an operation that was tried and failed is unsupported, not unknown', async () => {
  const report = await probe(authorized([...verified('list', 'read', 'stableIds'), { operation: 'create', outcome: 'failed', at, note: 'the source refused' }]));
  await assertValid(report);
  assert.equal(report.capabilities.create, 'unsupported');
  assert.equal(report.capabilities.update, 'unknown');
});

test('nothing beyond the named evidence fields is kept: a credential cannot ride into the report', async () => {
  const report = await probe({
    ...authorized([{ operation: 'list', outcome: 'verified', at, note: 'two pages', token: 'SYNTHETIC_TOKEN_X9', headers: { authorization: 'Bearer SYNTHETIC_TOKEN_X9' } }]),
    accessToken: 'SYNTHETIC_TOKEN_X9',
    scope: { accountScope: 'acct_1', spaceId: 'space_1', refreshToken: 'SYNTHETIC_TOKEN_X9' },
  });
  await assertValid(report);
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_TOKEN_X9'));
  assert.deepEqual(report.probeEvidence, [{ operation: 'list', outcome: 'verified', at, note: 'two pages' }]);
});

test('a probe that throws leaves the space blocked and names the failure', async () => {
  const report = await probeSpaceAccess('conn_space_1', { adapter: { probe: async () => { throw new Error('timed out'); } }, now: () => NOW });
  await assertValid(report);
  assert.deepEqual(report.gates, { read: 'blocked', write: 'blocked' });
  assert.deepEqual(report.blockers, ['the probe failed: timed out']);
});

test('an operation nobody defined is refused', async () => {
  const report = await probe(authorized(verified(...ALL, 'stableIds')));
  assert.deepEqual(checkSpaceOperation(report, 'deleteSpace'), { allowed: false, reason: 'unknown operation "deleteSpace"' });
});

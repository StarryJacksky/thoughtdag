// The contracts as the host loads them (CommonJS, no bundler), on the samples
// the renderer-side test runs. Both sides must reach the verdict and the
// error each sample states: one contract, read the same way in both worlds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContracts } = require('../../shared/schemas/host.cjs');
const { samples } = require('../fixtures/contracts/samples.json');

test('the host loads the same version and kinds', async () => {
  const contracts = await loadContracts();
  assert.equal(contracts.SCHEMA_VERSION, '1.1');
  for (const kind of ['CreateFileRequest', 'ResourceRef', 'SaveResult', 'RunEnvelope', 'RouteDecision']) {
    assert.ok(contracts.kinds().includes(kind), kind + ' is missing');
  }
  assert.equal(await loadContracts(), contracts, 'the contracts are built once');
});

for (const sample of samples) {
  test(`${sample.kind}: ${sample.name}`, async () => {
    const { validateDTO } = await loadContracts();
    const before = JSON.stringify(sample.value);
    const result = validateDTO(sample.kind, sample.value);
    assert.equal(result.ok, sample.valid);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.path === sample.error.path && e.keyword === sample.error.keyword),
        `expected ${sample.error.keyword} at "${sample.error.path}", got ${JSON.stringify(result.errors)}`);
    }
    assert.equal(JSON.stringify(sample.value), before, 'validation changed the value');
  });
}

test('a request of an unknown kind is refused, not passed', async () => {
  const { validateDTO } = await loadContracts();
  assert.equal(validateDTO('DeleteEverythingRequest', {}).ok, false);
});

test('a stored document of a newer version is read-only; an unknown one is unsupported', async () => {
  const { versionAccess, SCHEMA_VERSION } = await loadContracts();
  assert.equal(versionAccess('1.1', SCHEMA_VERSION), 'read-write');
  assert.equal(versionAccess('1.2', SCHEMA_VERSION), 'read-only');
  assert.equal(versionAccess('2.0', SCHEMA_VERSION), 'read-only');
  assert.equal(versionAccess('0.9', SCHEMA_VERSION), 'migrate');
  assert.equal(versionAccess('latest', SCHEMA_VERSION), 'unsupported');
});

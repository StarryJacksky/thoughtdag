// The contracts as the host (CommonJS) loads them: the same schema files and
// the same validator the renderer uses. The validator is an ES module, so it
// arrives through import(); callers await it once and keep the result.
'use strict';

const workspace = require('./workspace-v1.json');
const runEnvelope = require('./run-envelope-v1.json');

let loaded = null;

/** `{ validateDTO, versionAccess, kinds, SCHEMA_VERSION }`, built once. */
function loadContracts() {
  if (!loaded) {
    loaded = import('./validate.mjs').then(({ createValidator, versionAccess }) => {
      const validator = createValidator([workspace, runEnvelope]);
      return {
        validateDTO: (kind, value) => validator.validate(kind, value),
        versionAccess,
        kinds: () => validator.kinds(),
        SCHEMA_VERSION: workspace.$defs.SchemaVersion.const,
      };
    });
  }
  return loaded;
}

module.exports = { loadContracts };

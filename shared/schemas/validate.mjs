// The contract validator, shared by the renderer and the host. One file, no
// dependencies, no code generation: it runs the same under a browser content
// policy that forbids eval and under plain Node.
//
// It implements the part of JSON Schema (draft 2020-12) the contracts in this
// directory use, and refuses any schema that uses more: a keyword it does not
// know is an error when the validator is built, never a check silently
// skipped. tests/unit/contracts.test.ts holds it to a full implementation's
// verdict on every sample.
//
// It never changes the value it is given. A field the schema does not allow
// is reported, not dropped.

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'default', 'examples']);
const KEYWORDS = new Set([
  '$ref', 'type', 'const', 'enum',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'uniqueItems', 'items',
  'required', 'properties', 'additionalProperties',
  'oneOf', 'anyOf', 'allOf',
]);
// keywords whose value is a schema, a list of schemas, or a map of schemas
const SUBSCHEMA = new Set(['items', 'additionalProperties']);
const SUBSCHEMA_LIST = new Set(['oneOf', 'anyOf', 'allOf']);
const SUBSCHEMA_MAP = new Set(['properties', '$defs']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return false;
  }
}

/** Refuse a schema that asks for a check this validator cannot make. */
function assertSupported(schema, where) {
  if (typeof schema === 'boolean') return;
  if (!isObject(schema)) throw new Error(`${where}: a schema must be an object or a boolean`);
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key) && !SUBSCHEMA_MAP.has(key)) continue;
    if (!KEYWORDS.has(key) && !SUBSCHEMA_MAP.has(key)) throw new Error(`${where}: unsupported keyword "${key}"`);
    if (SUBSCHEMA.has(key)) assertSupported(value, `${where}/${key}`);
    else if (SUBSCHEMA_LIST.has(key)) value.forEach((s, i) => assertSupported(s, `${where}/${key}/${i}`));
    else if (SUBSCHEMA_MAP.has(key)) for (const [name, s] of Object.entries(value)) assertSupported(s, `${where}/${key}/${name}`);
  }
}

/**
 * A validator over a set of schema documents. Each document names itself
 * with `$id`; every entry of its `$defs` is a kind that can be validated by
 * name. `$ref` reaches `#/$defs/X` in the same document or `<$id>#/$defs/X`
 * in another.
 */
export function createValidator(schemas) {
  const byId = new Map();
  const kinds = new Map();
  for (const doc of schemas) {
    if (!isObject(doc) || typeof doc.$id !== 'string' || !doc.$id) throw new Error('every schema document needs an $id');
    if (byId.has(doc.$id)) throw new Error(`two schema documents share the $id ${doc.$id}`);
    assertSupported(doc, doc.$id);
    byId.set(doc.$id, doc);
    for (const [name, schema] of Object.entries(doc.$defs ?? {})) {
      if (kinds.has(name)) throw new Error(`the kind "${name}" is defined twice`);
      kinds.set(name, { schema, root: doc });
    }
  }

  const patterns = new Map();
  const regexOf = (source) => {
    let re = patterns.get(source);
    if (!re) { re = new RegExp(source, 'u'); patterns.set(source, re); }
    return re;
  };

  function resolve(ref, root) {
    const hash = ref.indexOf('#');
    const id = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    const doc = id ? byId.get(id) : root;
    if (!doc) throw new Error(`unresolved $ref ${ref}`);
    let node = doc;
    for (const part of pointer.split('/').filter(Boolean)) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
    return { schema: node, root: doc };
  }
  // a broken reference is a defect in the contract: find it now, not on some request
  const checkRefs = (schema, root) => {
    if (!isObject(schema)) return;
    if (typeof schema.$ref === 'string') resolve(schema.$ref, root);
    for (const [key, value] of Object.entries(schema)) {
      if (SUBSCHEMA.has(key)) checkRefs(value, root);
      else if (SUBSCHEMA_LIST.has(key)) value.forEach((s) => checkRefs(s, root));
      else if (SUBSCHEMA_MAP.has(key)) Object.values(value).forEach((s) => checkRefs(s, root));
    }
  };
  for (const doc of byId.values()) checkRefs(doc, doc);

  function check(value, schema, root, path, errors) {
    if (schema === true) return;
    if (schema === false) { errors.push({ path, keyword: 'false', message: 'is not allowed' }); return; }
    const fail = (keyword, message) => errors.push({ path, keyword, message });

    if (schema.$ref !== undefined) {
      const target = resolve(schema.$ref, root);
      check(value, target.schema, target.root, path, errors);
    }
    if ('const' in schema && !same(value, schema.const)) fail('const', `must be ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some((option) => same(value, option))) fail('enum', `must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      // the checks below assume the type; a value of the wrong type has one error, not several
      if (!types.some((t) => matchesType(value, t))) { fail('type', `must be ${types.join(' or ')}`); return; }
    }

    if (typeof value === 'string') {
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) fail('minLength', `must have at least ${schema.minLength} character(s)`);
      if (schema.maxLength !== undefined && length > schema.maxLength) fail('maxLength', `must have at most ${schema.maxLength} character(s)`);
      if (schema.pattern !== undefined && !regexOf(schema.pattern).test(value)) fail('pattern', `must match ${schema.pattern}`);
    }

    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) fail('minimum', `must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail('maximum', `must be <= ${schema.maximum}`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('exclusiveMinimum', `must be > ${schema.exclusiveMinimum}`);
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail('exclusiveMaximum', `must be < ${schema.exclusiveMaximum}`);
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems', `must have at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', `must have at most ${schema.maxItems} item(s)`);
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) fail('uniqueItems', 'must not repeat an item');
      if (schema.items !== undefined) value.forEach((item, i) => check(item, schema.items, root, `${path}/${i}`, errors));
    }

    if (isObject(value)) {
      for (const key of schema.required ?? []) if (!(key in value)) errors.push({ path: `${path}/${key}`, keyword: 'required', message: 'is required' });
      const properties = schema.properties ?? {};
      for (const [key, v] of Object.entries(value)) {
        if (key in properties) check(v, properties[key], root, `${path}/${key}`, errors);
        else if (schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) errors.push({ path: `${path}/${key}`, keyword: 'additionalProperties', message: 'is not an allowed field' });
          else check(v, schema.additionalProperties, root, `${path}/${key}`, errors);
        }
      }
    }

    for (const sub of schema.allOf ?? []) check(value, sub, root, path, errors);

    for (const keyword of ['oneOf', 'anyOf']) {
      const variants = schema[keyword];
      if (!variants) continue;
      const attempts = variants.map((sub) => { const found = []; check(value, sub, root, path, found); return found; });
      const passing = attempts.filter((found) => found.length === 0).length;
      if (keyword === 'oneOf' && passing > 1) { fail('oneOf', 'matches more than one allowed variant'); continue; }
      if (passing >= 1) continue;
      fail(keyword, 'matches none of the allowed variants');
      // say why for the variant the value was most likely meant to be: one whose
      // discriminator (a const or enum on a field of its own) it satisfied,
      // else the nearest miss
      const ownField = (e) => e.path.startsWith(`${path}/`) && !e.path.slice(path.length + 1).includes('/');
      const missesDiscriminator = (found) => found.some((e) => (e.keyword === 'const' || e.keyword === 'enum') && ownField(e));
      const meant = attempts.filter((found) => !missesDiscriminator(found));
      const closest = (meant.length ? meant : attempts).reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...closest);
    }
  }

  return {
    kinds: () => [...kinds.keys()].sort(),
    validate(kind, value) {
      const entry = kinds.get(kind);
      if (!entry) return { ok: false, errors: [{ path: '', keyword: 'kind', message: `unknown kind "${kind}"` }] };
      const errors = [];
      check(value, entry.schema, entry.root, '', errors);
      return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
    },
  };
}

/**
 * What this build may do with a stored document of version `found`, when it
 * was written for `supported` ("major.minor"):
 *   read-write   same major, minor not newer
 *   read-only    a newer minor or a newer major: it may hold fields this
 *                build does not know, so it is never rewritten
 *   migrate      an older major: readable through a migration, not as it is
 *   unsupported  not a version this scheme recognizes
 */
export function versionAccess(found, supported) {
  const parse = (v) => {
    const m = typeof v === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v) : null;
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  };
  const have = parse(supported);
  if (!have) throw new Error(`"${supported}" is not a major.minor version`);
  const got = parse(found);
  if (!got) return 'unsupported';
  if (got.major < have.major) return 'migrate';
  if (got.major > have.major || got.minor > have.minor) return 'read-only';
  return 'read-write';
}

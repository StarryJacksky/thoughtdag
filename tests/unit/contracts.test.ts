import { describe, expect, it } from 'vitest';
import Ajv2020Import from 'ajv/dist/2020';
import workspaceSchema from '../../shared/schemas/workspace-v1.json';
import runEnvelopeSchema from '../../shared/schemas/run-envelope-v1.json';
import { createValidator } from '../../shared/schemas/validate.mjs';
import { SCHEMA_VERSION, contractKinds, validateDTO, versionAccess, type CreateFileRequest, type ResourceRef, type WorkspaceDTOs } from '../../src/lib/workspace/contracts';
import { RUN_SCHEMA_VERSION, validateRunDTO, type RouteDecision, type RunDTOs } from '../../src/lib/context/contracts';
import sampleFile from '../fixtures/contracts/samples.json';

// The contracts as the renderer loads them. tests/host/contracts.test.cjs
// runs the same samples through the host's loader; both must reach the
// verdicts written in the sample file.

interface Sample { name: string; kind: string; valid: boolean; value: unknown; error?: { path: string; keyword: string } }
const samples = sampleFile.samples as Sample[];

// ajv is CommonJS: the class is the default export or sits under it
const Ajv2020 = (Ajv2020Import as unknown as { default?: typeof Ajv2020Import }).default ?? Ajv2020Import;

describe('contract samples', () => {
  it('cover a legal request and the illegal ones the plan names', () => {
    const create = samples.filter((s) => s.kind === 'CreateFileRequest');
    expect(create.filter((s) => s.valid).length).toBeGreaterThanOrEqual(1);
    expect(create.filter((s) => !s.valid).length).toBeGreaterThanOrEqual(3);
  });

  it.each(samples)('$kind: $name', (sample) => {
    const before = JSON.stringify(sample.value);
    const result = validateDTO(sample.kind, sample.value);
    expect(result.ok).toBe(sample.valid);
    if (!result.ok) {
      expect(sample.error, 'an invalid sample names the error it expects').toBeDefined();
      expect(result.errors).toContainEqual(expect.objectContaining(sample.error!));
    }
    // validation reports; it never repairs: no field is dropped or filled in
    expect(JSON.stringify(sample.value)).toBe(before);
    if (result.ok) expect(result.value).toBe(sample.value);
  });
});

describe('the validator against a full JSON Schema implementation', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(workspaceSchema);
  ajv.addSchema(runEnvelopeSchema);
  const reference = (kind: string) => {
    for (const doc of [workspaceSchema, runEnvelopeSchema]) {
      if (kind in doc.$defs) return ajv.getSchema(`${doc.$id}#/$defs/${kind}`)!;
    }
    throw new Error(`no schema defines ${kind}`);
  };

  it.each(samples)('agrees on $kind: $name', (sample) => {
    expect(validateDTO(sample.kind, sample.value).ok).toBe(reference(sample.kind)(sample.value) === true);
  });
});

describe('the TypeScript types and the schema', () => {
  // every key is checked by the compiler; a kind missing here does not build
  const workspaceKinds: Record<keyof WorkspaceDTOs, true> = {
    ResourceLocator: true, WorkspaceRecord: true, ResourceRecord: true, ImportProvenance: true, WorkspaceEvent: true, ResourceSelector: true, ResourceVersion: true, ResourceRef: true,
    CreateFileRequest: true, SourceCapabilities: true, FileEntry: true, ResourcePage: true, TextRevision: true, SaveResult: true,
    TrashReceipt: true, RecoveryItem: true, FileVersion: true, DocumentDraft: true, SourceRead: true, SourceWrite: true, SourceWriteResult: true, SurfaceState: true, SpaceCapabilityReport: true,
  };
  const runKinds: Record<keyof RunDTOs, true> = {
    EnvelopeMessage: true, InputSource: true, ResolvedInput: true, ExclusionRecord: true, Budget: true, ExecutionPolicy: true,
    RuntimeSelection: true, RunEnvelope: true, ExecutionTarget: true, TargetBinding: true, RuntimeBinding: true, CapabilityReport: true,
    RouteDecision: true, RunState: true,
  };
  // schema entries that are building blocks of the kinds above, not DTOs of their own
  const blocks = ['SchemaVersion', 'OpaqueId', 'ContentHash', 'Capability', 'RunSchemaVersion', 'AgentRuntime', 'MessageSource'];

  it('name the same kinds', () => {
    expect(contractKinds()).toEqual([...Object.keys(workspaceKinds), ...Object.keys(runKinds), ...blocks].sort());
  });

  it('accept values written against the types', () => {
    const request: CreateFileRequest = { workspaceId: 'ws_1', extension: 'tex', origin: 'workspace', idempotencyKey: 'op_3' };
    const ref: ResourceRef = { fileId: 'file_1', selector: { kind: 'pdf', pages: [1, 2], rect: [0, 0, 1, 1] }, version: { kind: 'live' }, payload: 'image' };
    const route: RouteDecision = { action: 'fork-prefix', bindingId: 'bind_1', lastCompletedTurnId: 'turn_2', reason: 'unchanged prefix' };
    expect(validateDTO('CreateFileRequest', request)).toEqual({ ok: true, value: request });
    expect(validateDTO('ResourceRef', ref)).toEqual({ ok: true, value: ref });
    expect(validateRunDTO('RouteDecision', route)).toEqual({ ok: true, value: route });
  });

  it('carry the version the schema documents state', () => {
    expect(SCHEMA_VERSION).toBe(workspaceSchema.$defs.SchemaVersion.const);
    expect(RUN_SCHEMA_VERSION).toBe(runEnvelopeSchema.$defs.RunSchemaVersion.const);
  });
});

describe('validateDTO', () => {
  it('refuses a kind nobody defined instead of passing it', () => {
    expect(validateDTO('DeleteEverythingRequest', {})).toEqual({ ok: false, errors: [{ path: '', keyword: 'kind', message: 'unknown kind "DeleteEverythingRequest"' }] });
  });
});

describe('building a validator', () => {
  const doc = (defs: Record<string, unknown>, id = 'urn:test:doc') => ({ $id: id, $defs: defs });

  it('refuses a schema that asks for a check it cannot make', () => {
    expect(() => createValidator([doc({ Stamp: { type: 'string', format: 'date-time' } })])).toThrow(/unsupported keyword "format"/);
    expect(() => createValidator([doc({ Odd: { not: { type: 'string' } } })])).toThrow(/unsupported keyword "not"/);
  });

  it('refuses a reference that leads nowhere', () => {
    expect(() => createValidator([doc({ A: { $ref: '#/$defs/Missing' } })])).toThrow(/unresolved \$ref #\/\$defs\/Missing/);
    expect(() => createValidator([doc({ A: { $ref: 'urn:test:other#/$defs/B' } })])).toThrow(/unresolved \$ref/);
  });

  it('refuses two documents that define the same kind or share an id', () => {
    expect(() => createValidator([doc({ A: {} }, 'urn:test:one'), doc({ A: {} }, 'urn:test:two')])).toThrow(/the kind "A" is defined twice/);
    expect(() => createValidator([doc({ A: {} }), doc({ B: {} })])).toThrow(/share the \$id/);
  });
});

describe('versionAccess', () => {
  it.each([
    ['1.1', 'read-write'],
    ['1.0', 'read-write'],
    ['1.2', 'read-only'], // a newer minor may hold fields this build does not know
    ['2.0', 'read-only'],
    ['0.9', 'migrate'],
    ['1', 'unsupported'],
    ['v1.1', 'unsupported'],
    [undefined, 'unsupported'],
    [1.1, 'unsupported'],
  ])('a stored %s document is %s to a 1.1 build', (found, access) => {
    expect(versionAccess(found, SCHEMA_VERSION)).toBe(access);
  });
});

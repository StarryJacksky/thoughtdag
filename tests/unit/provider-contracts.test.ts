import { describe, expect, it } from 'vitest';
import { canDo, collectPages, locatorKey, writeBaseOf, writeThrough, type ResourceLocator, type SourceCapabilities, type WorkspaceRecord } from '../../src/lib/workspace/provider-contracts';
import { validateDTO } from '../../src/lib/workspace/contracts';

// The source helpers as the renderer loads them: the same module the host
// tests exercise (tests/host/local-provider.test.cjs), here against the
// TypeScript types callers will write to.

const local: WorkspaceRecord = { workspaceId: 'ws_1', displayName: 'research-project', readOnly: false, kind: 'local', rootGrantId: 'grant_1' };
const all = (level: SourceCapabilities['list']): SourceCapabilities => ({
  list: level, read: level, create: level, update: level, move: level, trash: level, conditionalWrite: level, pagePatch: level, changes: level, uploadCustomType: level,
});

describe('source helpers in the renderer', () => {
  it('only a supported capability may be attempted', () => {
    expect(canDo(all('supported'), 'update')).toBe(true);
    expect(canDo(all('unknown'), 'update')).toBe(false);
    expect(canDo(all('unsupported'), 'update')).toBe(false);
    expect(canDo(null, 'update')).toBe(false);
  });

  it('tells a local file from a remote object of the same name', () => {
    const file: ResourceLocator = { kind: 'local', rootGrantId: 'grant_1', relativePath: 'notes/a.md' };
    const object: ResourceLocator = { kind: 'chatgpt-space', connectionRef: 'conn_1', accountScope: 'acct_1', spaceId: 'space_1', objectId: 'notes/a.md', objectKind: 'file' };
    expect(locatorKey(file)).not.toBe(locatorKey(object));
  });

  it('answers a write itself when the source is not known to support it, with a result the contract accepts', async () => {
    let writes = 0;
    const provider = { capabilities: async () => all('unknown'), write: async () => { writes++; return { status: 'saved' as const, sourceRevision: null, contentHash: 'sha256:' + '0'.repeat(64) }; } };
    const result = await writeThrough(provider, local, { fileId: 'file_1', baseSourceRevision: 'r1', representation: 'text', payload: 'x', opId: 'op-1' });
    expect(result.status).toBe('unsupported');
    expect(validateDTO('SourceWriteResult', result).ok).toBe(true);
    expect(writes).toBe(0);
  });

  it('keeps a partial listing partial', async () => {
    const provider = { list: async () => ({ entries: [], nextCursor: null, completeness: 'partial' as const }) };
    expect(await collectPages(provider, local)).toEqual({ entries: [], completeness: 'partial' });
  });

  it('names the content hash as the base of a write when the source has no version of its own', () => {
    expect(writeBaseOf({ sourceRevision: null, contentHash: 'sha256:' + 'a'.repeat(64) })).toBe('sha256:' + 'a'.repeat(64));
  });
});

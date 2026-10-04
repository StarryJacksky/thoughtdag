import type { CreateFileRequest, FileEntry, ResourceLocator, ResourceRecord, SourceCapabilities, SourceRead, SourceWrite, SourceWriteResult, WorkspaceProvider, WorkspaceRecord } from '../../src/lib/workspace/contracts';

/** The revision a write must name to replace what `read` returned. */
export function writeBaseOf(read: Pick<SourceRead, 'sourceRevision' | 'contentHash'>): string;

/** A key that is the same for the same resource and different for any other, across sources. */
export function locatorKey(locator: ResourceLocator): string;

/** Whether a capability report lets `operation` be attempted. Only `supported` does. */
export function canDo(capabilities: SourceCapabilities | null | undefined, operation: keyof SourceCapabilities): boolean;

/** Read a listing to its end. `partial` when any page said so; never "empty" for a listing that could not be read. */
export function collectPages(
  provider: Pick<WorkspaceProvider, 'list'>,
  scope: WorkspaceRecord,
  parentId?: string,
  options?: { maxPages?: number },
): Promise<{ entries: FileEntry[]; completeness: 'complete' | 'partial' }>;

/** Write through a provider only when the source is known to support it. */
export function writeThrough(provider: Pick<WorkspaceProvider, 'capabilities' | 'write'>, scope: WorkspaceRecord, request: SourceWrite): Promise<SourceWriteResult>;

/** Create through a provider; rejects with `code: 'unsupported'` unless the source is known to support creating. */
export function createThrough(provider: Pick<WorkspaceProvider, 'capabilities' | 'create'>, scope: WorkspaceRecord, request: CreateFileRequest): Promise<ResourceRecord>;

// Workspace contracts: what the renderer and the host say to each other about
// workspace sources, files and editing surfaces. The shapes here are the
// TypeScript reading of shared/schemas/workspace-v1.json; the schema is what
// both sides validate against, and tests/unit/contracts.test.ts keeps the
// two in step.
//
// Every id is an opaque string. Nothing parses one, and no two kinds of id
// are interchangeable.

import workspaceSchema from '../../../shared/schemas/workspace-v1.json';
import runEnvelopeSchema from '../../../shared/schemas/run-envelope-v1.json';
import { createValidator, versionAccess, type ValidationError, type ValidationResult, type VersionAccess } from '../../../shared/schemas/validate.mjs';

export type { ValidationError, ValidationResult, VersionAccess };
export { versionAccess };

/** The version stored documents of these contracts carry. */
export const SCHEMA_VERSION = '1.1';

/** SHA-256 of content bytes: `sha256:` and 64 lowercase hex digits. */
export type ContentHash = string;

/** Whether a source or a runtime can do something. `unknown` is never treated as `supported`. */
export type Capability = 'supported' | 'unsupported' | 'unknown';

export type ResourceLocator =
  | { kind: 'local'; rootGrantId: string; relativePath: string }
  | {
      kind: 'chatgpt-space'; connectionRef: string; accountScope: string; spaceId: string; objectId: string;
      objectKind: 'page' | 'file' | 'folder' | 'external-link';
    };

export type WorkspaceRecord = { workspaceId: string; displayName: string; readOnly: boolean } & (
  | { kind: 'local'; rootGrantId: string }
  | { kind: 'chatgpt-space'; connectionRef: string; accountScope: string; spaceId: string; rootObjectId: string }
);

export interface ResourceRecord {
  fileId: string;
  workspaceId: string;
  /** local files only: where the file is now; a hint for display, never the identity */
  relativePath?: string;
  locator: ResourceLocator;
  /** a remote source's opaque version; null for local files. Never a content hash. */
  sourceRevision: string | null;
  mediaType: string;
  origin: 'workspace' | 'graph' | 'import';
  status: 'ready' | 'missing' | 'ambiguous' | 'readonly';
  /** the content hash once the content has been read; null for an entry known by metadata only */
  revision: ContentHash | null;
  /** set on a copy taken from somewhere else */
  importedFrom?: ImportProvenance;
}

/** One registered file changed on disk: by this application (then `opId`
 *  names the operation) or by another program (then it is null). `record`
 *  is the file as it stands after the change. */
export interface WorkspaceEvent {
  workspaceId: string;
  fileId: string;
  /** content: edited · moved: renamed or moved · missing: gone · ambiguous:
   *  several files could be it · restored: found again after being lost */
  change: 'content' | 'moved' | 'missing' | 'ambiguous' | 'restored';
  observedRevision: ContentHash | null;
  opId: string | null;
  record: ResourceRecord;
}

/** Where a copy was taken from, as the person stated it. The file is an
 *  ordinary local file from then on: nothing keeps it in step with that
 *  place and nothing is written back there. */
export interface ImportProvenance {
  source: 'chatgpt-space' | 'other';
  importedAt: string;
  /** the person's own words for the place: a page title, a link */
  note?: string;
}

export type ResourceSelector =
  | { kind: 'document' }
  /** A passage, anchored by its own text and the text around it. `lines` help a
   *  reader find it; relocating always verifies the quote, never the line number. */
  | { kind: 'text'; quote: string; prefix: string; suffix: string; baseRevision?: ContentHash; lines?: [number, number] }
  /** Pages count from 1; `rect` is [x0, y0, x1, y1] in page-normalized coordinates. */
  | { kind: 'pdf'; pages: number[]; rect?: [number, number, number, number] }
  | { kind: 'mindmap'; nodeIds: string[]; descendants: boolean };

export type ResourceVersion = { kind: 'live' } | { kind: 'snapshot'; snapshotId: string };

export interface ResourceRef {
  fileId: string;
  selector: ResourceSelector;
  version: ResourceVersion;
  payload: 'text' | 'image' | 'metadata';
}

/** The renderer names a workspace and a parent entry, never a path. */
export interface CreateFileRequest {
  workspaceId: string;
  parentId?: string;
  extension: string;
  origin: 'workspace' | 'graph';
  idempotencyKey: string;
}

export interface SourceCapabilities {
  list: Capability; read: Capability; create: Capability; update: Capability; move: Capability; trash: Capability;
  conditionalWrite: Capability; pagePatch: Capability; changes: Capability; uploadCustomType: Capability;
}

export interface FileEntry {
  entryId: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder' | 'page' | 'external-link' | 'unknown';
  fileId?: string;
  locator?: ResourceLocator;
  sourceRevision?: string | null;
  capabilities?: SourceCapabilities;
}

/** One page of a listing. A partial page is not an empty source. */
export interface ResourcePage {
  entries: FileEntry[];
  nextCursor: string | null;
  completeness: 'complete' | 'partial';
}

export interface TextRevision {
  text: string;
  revision: ContentHash;
  encoding: string;
  newline: 'lf' | 'crlf' | 'mixed';
}

/** Saved only on a confirmed write. A draft waiting to sync and a write whose
 *  acknowledgement was lost are their own states, never reported as saved. */
export type SaveResult =
  | { status: 'saved'; revision: ContentHash; sourceRevision: string | null }
  | { status: 'conflict'; currentRevision: ContentHash | null; currentSourceRevision?: string | null }
  | { status: 'readonly' | 'error' | 'pending-sync'; reason: string }
  | { status: 'unknown-ack'; reason: string; opId: string };

export interface TrashReceipt {
  receiptId: string;
  fileId: string;
  opId: string;
  location: 'system-trash' | 'project-recovery' | 'remote-trash';
  restorable: boolean;
}

/** Text typed into a file and not yet written to it, kept so it is not lost.
 *  `baseRevision` is the content it was typed over. Never model input by default. */
export interface DocumentDraft {
  fileId: string;
  text: string;
  baseRevision: ContentHash;
  savedAt: string;
}

/** Something kept in a workspace's recovery area after it was trashed there. */
export interface RecoveryItem {
  receiptId: string;
  kind: 'file' | 'folder';
  name: string;
  /** where it was: for display and for putting it back, never an identity */
  relativePath: string;
  trashedAt: string;
  /** a file's identity, when it had one */
  fileId?: string;
}

/** Content a file held before a save replaced it, kept whole in the recovery area. */
export interface FileVersion {
  fileId: string;
  revision: ContentHash;
  keptAt: string;
  size: number;
}

/** Content as a source returned it. `derived` content is for reading; it is
 *  never written back as the original. */
export interface SourceRead {
  fileId: string;
  sourceRevision: string | null;
  contentHash: ContentHash;
  representation: 'bytes' | 'text' | 'blocks';
  payload: Uint8Array | string | unknown[];
  fidelity: 'original' | 'derived';
}

export interface SourceWrite {
  fileId: string;
  baseSourceRevision: string;
  representation: SourceRead['representation'];
  payload: SourceRead['payload'];
  opId: string;
}

export type SourceWriteResult =
  /** `sourceRevision` is null for a source with no version of its own (a local file) */
  | { status: 'saved'; sourceRevision: string | null; contentHash: ContentHash }
  /** the source's revision now; null when the target is gone */
  | { status: 'conflict'; currentRevision: string | null }
  /** unknown-ack: the write may or may not have landed. error: it is known not to have. */
  | { status: 'readonly' | 'unsupported' | 'unknown-ack' | 'error'; reason: string };

/** What one connection to a ChatGPT space can do, as probed. Each capability
 *  rests on its own evidence: reading proves nothing about writing, and a file
 *  download proves nothing about editing a native page. A gate passes only on
 *  verified evidence; without it the space stays blocked. */
export interface SpaceCapabilityReport {
  connectionRef: string | null;
  observedAt: string;
  authMethod: 'none' | 'official-api' | 'host-bridge' | 'source-connector';
  authStatus: 'none' | 'authorized' | 'unauthorized' | 'expired' | 'share-link-only';
  scope: { accountScope: string | null; spaceId: string | null };
  capabilities: SourceCapabilities;
  /** whether objects keep one id across renames and moves */
  stableIds: Capability;
  gates: { read: 'passed' | 'blocked'; write: 'passed' | 'blocked' };
  sourceDocumentation: { title: string; url: string; checkedAt: string }[];
  probeEvidence: { operation: string; outcome: 'verified' | 'failed' | 'untested'; at: string; note?: string }[];
  blockers: string[];
}

/** The narrow door the renderer has into files. It never passes a path. */
export interface WorkspaceAPI {
  chooseRoot(): Promise<WorkspaceRecord>;
  listChildren(workspaceId: string, parentId?: string): Promise<FileEntry[]>;
  createFile(req: CreateFileRequest): Promise<ResourceRecord>;
  readText(fileId: string): Promise<TextRevision>;
  saveText(fileId: string, baseRevision: ContentHash, text: string, opId: string): Promise<SaveResult>;
  moveFile(fileId: string, targetParentId: string, newName: string, opId: string): Promise<ResourceRecord>;
  copyFile(fileId: string, targetParentId: string, newName: string, opId: string): Promise<ResourceRecord>;
  trashFile(fileId: string, opId: string): Promise<TrashReceipt>;
}

/** One source of files behind the workspace door: a local folder or a remote
 *  space. Callers branch on capabilities, never on the kind of source. */
export interface WorkspaceProvider {
  capabilities(scope: WorkspaceRecord, fileId?: string): Promise<SourceCapabilities>;
  list(scope: WorkspaceRecord, parentId?: string, cursor?: string): Promise<ResourcePage>;
  read(scope: WorkspaceRecord, fileId: string): Promise<SourceRead>;
  write(scope: WorkspaceRecord, req: SourceWrite): Promise<SourceWriteResult>;
  create(scope: WorkspaceRecord, req: CreateFileRequest): Promise<ResourceRecord>;
}

/** The one editing buffer of a file. Views share it; none keeps a copy. */
export interface DocumentModel {
  documentId: string;
  fileId: string;
  text: string;
  /** hash of the content last read from or written to the source */
  sourceContentHash: ContentHash;
  sourceRevision: string | null;
  bufferRevision: number;
  state: 'clean' | 'dirty' | 'saving' | 'conflict' | 'readonly' | 'error' | 'pending-sync' | 'unknown-ack';
}

export interface DocumentEdit {
  baseBufferRevision: number;
  changes: { from: number; to: number; insert: string }[];
  originSurfaceId: string;
}

/** Where a surface sits. It holds no document text. */
export interface SurfaceState {
  surfaceId: string;
  documentId: string;
  kind: 'text' | 'markdown' | 'pdf' | 'image' | 'html' | 'mindmap';
  placement: 'floating' | 'left' | 'right' | 'maximized' | 'minimized';
  rect: { x: number; y: number; width: number; height: number };
}

/** The workspace kinds that can be validated by name. */
export interface WorkspaceDTOs {
  ResourceLocator: ResourceLocator;
  WorkspaceRecord: WorkspaceRecord;
  ResourceRecord: ResourceRecord;
  ImportProvenance: ImportProvenance;
  WorkspaceEvent: WorkspaceEvent;
  ResourceSelector: ResourceSelector;
  ResourceVersion: ResourceVersion;
  ResourceRef: ResourceRef;
  CreateFileRequest: CreateFileRequest;
  SourceCapabilities: SourceCapabilities;
  FileEntry: FileEntry;
  ResourcePage: ResourcePage;
  TextRevision: TextRevision;
  SaveResult: SaveResult;
  TrashReceipt: TrashReceipt;
  RecoveryItem: RecoveryItem;
  FileVersion: FileVersion;
  DocumentDraft: DocumentDraft;
  SourceRead: SourceRead;
  SourceWrite: SourceWrite;
  SourceWriteResult: SourceWriteResult;
  SurfaceState: SurfaceState;
  SpaceCapabilityReport: SpaceCapabilityReport;
}

const validator = createValidator([workspaceSchema, runEnvelopeSchema]);

/** Every kind either contract document defines, sorted. */
export const contractKinds = (): string[] => validator.kinds();

/**
 * Check a value against the contract of that name. The value is returned as
 * given: a field the contract does not allow is an error, never dropped.
 */
export function validateDTO<K extends keyof WorkspaceDTOs>(kind: K, value: unknown): ValidationResult<WorkspaceDTOs[K]>;
export function validateDTO(kind: string, value: unknown): ValidationResult;
export function validateDTO(kind: string, value: unknown): ValidationResult {
  return validator.validate(kind, value);
}

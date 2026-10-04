// Workspace sources as the renderer sees them. A source is whatever answers
// the five WorkspaceProvider calls: a local folder today, a remote space
// when one can be reached. Code here and above is written against those
// calls and the capabilities a source reports, never against the kind of
// source: no path, no URL, no "if local".
//
// The helpers are the same ones the host uses (shared/workspace), so both
// sides decide the same way what may be attempted.

export { canDo, collectPages, createThrough, locatorKey, writeBaseOf, writeThrough } from '../../../shared/workspace/provider-helpers.mjs';
export type { Capability, FileEntry, ResourceLocator, ResourcePage, SourceCapabilities, SourceRead, SourceWrite, SourceWriteResult, WorkspaceProvider, WorkspaceRecord } from './contracts';

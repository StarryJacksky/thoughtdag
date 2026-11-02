// Where what is attached to a question can come from. A file from this computer goes
// the way it always went (lib/attachments). A ChatGPT Space is listed and blocked, with
// the reason: no interface reaches one from outside its product yet
// (docs/research-workspace/space-capability-report.md). Picking gives references: nothing
// is copied, read or sent here; what a reference holds is read when a run is prepared.

import { registerEntry } from './client';
import type { ResourceRef, ResourceSelector } from './contracts';

export interface SourceRoot {
  workspaceId: string | null;
  kind: 'local-file' | 'space';
  displayName: string;
  status: 'ready' | 'unauthorized' | 'blocked';
  blockedReason: string | null;
}

export interface SourceSelection {
  workspaceId: string;
  entryId: string;
  selector?: ResourceSelector;
}

/** The sources a question on this canvas can take attachments from. */
export async function listSourceRoots(projectId: string): Promise<SourceRoot[]> {
  void projectId; // every canvas has the same two until a Space can be reached
  return [
    { workspaceId: null, kind: 'local-file', displayName: 'source.local', status: 'ready', blockedReason: null },
    { workspaceId: null, kind: 'space', displayName: 'source.space', status: 'blocked', blockedReason: 'source.spaceBlocked' },
  ];
}

/** References to what was picked in a workspace. */
export async function pickSources(selections: SourceSelection[]): Promise<ResourceRef[]> {
  return Promise.all(selections.map(async ({ workspaceId, entryId, selector }) => {
    const record = await registerEntry(workspaceId, entryId);
    return { fileId: record.fileId, selector: selector ?? { kind: 'document' }, version: { kind: 'live' }, payload: 'text' };
  }));
}

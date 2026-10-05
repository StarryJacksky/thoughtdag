// Creating a file, from either place it can be asked for. From the
// workspace tree: the file lands in the folder that was selected and the
// canvas is not touched. From the graph: the file lands in the workspace's
// Graph Files folder and one node referencing it appears where the person
// pointed. Neither wires anything: an edge is only ever added by hand.
//
// The file comes first. If the node cannot be made, the file stays, and the
// result says so, so the node can be added again without creating twice.
// No model is involved at any point.

import { createFile, newOperationId, WorkspaceError } from './client';
import type { CreateFileRequest, ResourceRecord } from './contracts';
import { attachResource } from './graph-resource';
import { rememberFileType } from './file-types';

/** A request to create a file, with where its node goes when it is asked for from the graph. */
export interface CreateDocumentRequest extends Omit<CreateFileRequest, 'idempotencyKey'> {
  /** the open canvas; required when origin is `graph` */
  graphId?: string;
  /** where the node goes on the canvas; required when origin is `graph` */
  position?: { x: number; y: number };
  /** one per creation; made here when absent */
  idempotencyKey?: string;
}

export interface CreatedDocument {
  record: ResourceRecord;
  /** the node referencing the file, when one was asked for and made */
  nodeId: string | null;
  /** why the node was not made, when it was asked for and was not; the file exists either way */
  nodeError?: string;
}

/** Put a node for an existing file on the canvas: what a graph creation does second, and what repairs one whose node failed. */
export function addNodeFor(record: ResourceRecord, graphId: string, position: { x: number; y: number }): Promise<string> {
  return attachResource(graphId, { fileId: record.fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }, position, record);
}

export async function createDocument(req: CreateDocumentRequest): Promise<CreatedDocument> {
  const { graphId, position, idempotencyKey, ...file } = req;
  if (file.origin === 'graph' && (!graphId || !position)) throw new WorkspaceError('invalid-request', 'a file created from the graph needs the canvas and a place on it');
  const record = await createFile({ ...file, idempotencyKey: idempotencyKey ?? newOperationId() });
  rememberFileType(file.extension);
  if (file.origin !== 'graph') return { record, nodeId: null };
  try {
    return { record, nodeId: await addNodeFor(record, graphId!, position!) };
  } catch (e) {
    return { record, nodeId: null, nodeError: e instanceof Error ? e.message : String(e) };
  }
}

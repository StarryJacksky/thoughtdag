// What the canvas does with workspace files in answer to a gesture: create
// one from the graph, take one that was dropped on it. Each reports its own
// outcome to the person; none of them throws.

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import { reconcileFile, revealFile } from '../../lib/workspace/client';
import { addNodeFor, createDocument } from '../../lib/workspace/create-command';
import { attachEntry, attachResource, type DragPayload } from '../../lib/workspace/graph-resource';
import { ensureWorkspace, reloadTree } from '../../lib/workspace/session';
import { openFileSurface } from '../../lib/documents/surface-store';
import { toast } from '../../lib/ui-store';
import { t as say, fmt } from '../../i18n';

type Point = { x: number; y: number };

const CARD = { width: 400, height: 240 };
const GAP = 40;

/**
 * A place for a new card at or near the one wanted where it covers no node
 * that is already there: a card put on top of another hides it, and what is
 * hidden cannot be clicked. Looks to the right first, then a row down.
 */
export function freeSpot(wanted: Point): Point {
  const nodes = useStore.getState().nodes;
  const covers = (p: Point) => nodes.some((n) => {
    const width = n.measured?.width ?? n.width ?? CARD.width;
    const height = n.measured?.height ?? n.height ?? CARD.height;
    return p.x < n.position.x + width + GAP && p.x + CARD.width + GAP > n.position.x
      && p.y < n.position.y + height + GAP && p.y + CARD.height + GAP > n.position.y;
  });
  let p = wanted;
  for (let tries = 1; tries <= 60 && covers(p); tries++) {
    p = tries % 4 === 0 ? { x: wanted.x, y: p.y + CARD.height + GAP * 2 } : { x: p.x + CARD.width + GAP, y: p.y };
  }
  return p;
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Create a file from the graph: it lands in the Graph Files folder of the
 * canvas's workspace (the canvas's own folder when it has none yet) and one
 * node referencing it goes where the person pointed. When the node cannot
 * be made the file stays, and the message offers to add the node again.
 */
export async function createInGraph(extension: string, at: Point): Promise<void> {
  try {
    // the canvas is fixed now: whatever is opened while the folder is looked up, the file is this canvas's
    const canvasId = useProjects.getState().activeId;
    if (!canvasId) return;
    const workspace = await ensureWorkspace(canvasId);
    const made = await createDocument({ workspaceId: workspace.workspaceId, extension, origin: 'graph', graphId: canvasId, position: at });
    reloadTree();
    const name = made.record.relativePath ?? '';
    // made to be typed into: it opens at once, node or no node
    void openFileSurface(made.record.fileId).catch(() => {});
    if (made.nodeId) {
      toast('success', fmt(say('workspace.created'), { name }), 5000, { label: say('workspace.reveal'), run: () => void revealFile(made.record.fileId).catch(() => {}) });
    } else {
      toast('error', fmt(say('workspace.createdNoNode'), { name, why: made.nodeError ?? '' }), 0, {
        label: say('workspace.addNodeAgain'),
        run: () => void addNodeFor(made.record, useProjects.getState().activeId ?? '', at).catch((e) => toast('error', fmt(say('workspace.failed'), { why: why(e) }))),
      });
    }
  } catch (e) {
    toast('error', fmt(say('workspace.failed'), { why: why(e) }));
  }
}

/**
 * A file or a selection dragged onto the canvas becomes a node referencing
 * it, at the point it was dropped. A graph node dropped on the canvas is
 * nothing new: it is already there.
 */
export async function dropOnCanvas(payload: DragPayload, at: Point): Promise<void> {
  try {
    const canvasId = useProjects.getState().activeId;
    // a node is already on the canvas, and a folder is not something a node references
    if (!canvasId || payload.kind === 'graph-node' || payload.kind === 'folder-ref') return;
    if (payload.kind === 'file-ref') await attachEntry(canvasId, payload.workspaceId, payload.entryId, at);
    else await attachResource(canvasId, payload.ref, at, await reconcileFile(payload.ref.fileId));
  } catch (e) {
    toast('error', fmt(say('workspace.failed'), { why: why(e) }));
  }
}

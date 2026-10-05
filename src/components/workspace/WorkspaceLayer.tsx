import { FolderTree } from 'lucide-react';
import { workspaceAvailable } from '../../lib/workspace/client';
import { useWorkspacePanel } from '../../lib/workspace/session';
import { isViewerMode } from '../../lib/viewer';
import { useT } from '../../i18n';
import { createInGraph, freeSpot } from './actions';
import CreateFileMenu from './CreateFileMenu';
import WorkspaceExplorer from './WorkspaceExplorer';
import { useWorkspaceSync } from './useWorkspaceSync';

// Everything the canvas shows for its files apart from the nodes: the
// button that opens the file panel, the panel, and the type menu for a file
// created from the graph. Nothing of it shows outside the desktop app.

type Point = { x: number; y: number };

interface Props {
  /** canvas coordinates for a point on screen; the middle of the view for none */
  flowPosAt: (screen?: Point | null) => Point;
}

export default function WorkspaceLayer({ flowPosAt }: Props) {
  const t = useT();
  const open = useWorkspacePanel((s) => s.open);
  const createAt = useWorkspacePanel((s) => s.createAt);
  const workspaceId = useWorkspacePanel((s) => s.workspace?.workspaceId ?? 'none');
  useWorkspaceSync();
  if (isViewerMode || !workspaceAvailable()) return null;

  // a file added from the panel goes to the middle of the view, or beside whatever is already there
  const placeAt = (): Point => freeSpot(flowPosAt(null));

  return (
    <>
      {open ? <WorkspaceExplorer key={workspaceId} placeAt={placeAt} /> : (
        <button
          onClick={() => useWorkspacePanel.setState({ open: true })}
          title={t('workspace.toggleTitle')}
          data-workspace-toggle
          className="absolute top-[64px] left-4 z-10 w-9 h-9 rounded-xl flex items-center justify-center bg-card/90 backdrop-blur border border-line shadow-sm text-ink-muted hover:bg-wash transition-colors"
        >
          <FolderTree size={16} strokeWidth={1.75} />
        </button>
      )}
      {createAt && (
        <CreateFileMenu
          title={t('workspace.newFile')}
          style={{ left: createAt.screen.x, top: createAt.screen.y }}
          onPick={(extension) => { useWorkspacePanel.setState({ createAt: null }); void createInGraph(extension, createAt.at); }}
          onClose={() => useWorkspacePanel.setState({ createAt: null })}
        />
      )}
    </>
  );
}

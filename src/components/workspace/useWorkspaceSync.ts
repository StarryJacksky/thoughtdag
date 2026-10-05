import { useEffect } from 'react';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import { workspaceAvailable } from '../../lib/workspace/client';
import { keepCopiesOutOfHistory } from '../../lib/workspace/graph-resource';
import { restoreWorkspace, useWorkspacePanel, watchWorkspaces } from '../../lib/workspace/session';

/**
 * Keeps the open canvas in step with its files: when a canvas is opened its
 * workspace is picked up again and its file nodes are brought up to date,
 * and for as long as it is open, changes in every workspace it draws on are
 * heard. Does nothing outside the desktop app.
 */
export function useWorkspaceSync(): void {
  const canvasId = useProjects((s) => s.activeId);
  const switching = useProjects((s) => s.switching);
  const bound = useWorkspacePanel((s) => s.workspace?.workspaceId ?? '');
  const referenced = useStore((s) => {
    const ids = new Set<string>();
    for (const n of s.nodes) if (n.data.resourceHint) ids.add(n.data.resourceHint.workspaceId);
    return [...ids].sort().join('\n');
  });

  useEffect(() => {
    if (!canvasId || switching || !workspaceAvailable()) return;
    void restoreWorkspace();
  }, [canvasId, switching]);

  // an undo or a redo brings back a picture of the canvas, not of the files
  useEffect(() => (workspaceAvailable() ? keepCopiesOutOfHistory() : undefined), []);

  useEffect(() => {
    if (!workspaceAvailable()) return;
    const ids = [...new Set([bound, ...referenced.split('\n')].filter(Boolean))];
    if (ids.length === 0) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void watchWorkspaces(ids).then((s) => { if (gone) s(); else stop = s; });
    return () => { gone = true; stop?.(); };
  }, [bound, referenced]);
}

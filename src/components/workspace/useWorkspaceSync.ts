import { useEffect } from 'react';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import { documents } from '../../lib/documents/document-service';
import { closeAllSurfaces, restoreLayout, saveLayout, useSurfaces } from '../../lib/documents/surface-store';
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

  // the documents this canvas had open: put back where they were, remembered as they are moved, closed when the canvas is left
  useEffect(() => {
    if (!canvasId || switching || !workspaceAvailable()) return;
    let here = true;
    let stopRemembering = () => {};
    void restoreLayout(canvasId).then(() => {
      if (here) stopRemembering = useSurfaces.subscribe(() => saveLayout(canvasId));
    });
    return () => {
      here = false;
      stopRemembering();
      // their unsaved typing is saved or kept as drafts by the document service
      closeAllSurfaces();
    };
  }, [canvasId, switching]);

  // an undo or a redo brings back a picture of the canvas, not of the files
  useEffect(() => (workspaceAvailable() ? keepCopiesOutOfHistory() : undefined), []);

  // the window going away: what is typed and not saved goes into drafts on the way out
  useEffect(() => {
    if (!workspaceAvailable()) return;
    const leaving = () => { void documents.keepDrafts(); };
    window.addEventListener('pagehide', leaving);
    return () => window.removeEventListener('pagehide', leaving);
  }, []);

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

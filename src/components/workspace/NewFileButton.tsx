import type { PointerEvent as ReactPointerEvent } from 'react';
import { FilePlus } from 'lucide-react';
import { workspaceAvailable } from '../../lib/workspace/client';
import { useWorkspacePanel } from '../../lib/workspace/session';
import { useT } from '../../i18n';
import { freeSpot } from './actions';

// The palette's "new file" button: a real file in the canvas's folder and a
// node for it where the person points. A click puts the node in the middle
// of the view (beside whatever is there); a drag puts it where it is
// dropped. It is on the canvas whether or not the canvas has anything on
// it yet: a new canvas can start from a file.

type Point = { x: number; y: number };

interface Props {
  /** the palette's own press-or-drag: calls back with where the drag ended, or null for a click */
  arm: (e: ReactPointerEvent, create: (screen: Point | null) => void) => void;
  /** canvas coordinates for a point on screen; the middle of the view for none */
  flowPosAt: (screen?: Point | null) => Point;
}

export default function NewFileButton({ arm, flowPosAt }: Props) {
  const t = useT();
  if (!workspaceAvailable()) return null;
  return (
    <button
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        arm(e, (screen) => useWorkspacePanel.setState({ createAt: { screen: screen ?? { x: rect.right + 10, y: rect.top }, at: screen ? flowPosAt(screen) : freeSpot(flowPosAt(null)) } }));
      }}
      title={t('palette.newFileTitle')}
      data-palette-new-file
      className="w-9 h-9 rounded-lg flex items-center justify-center text-ink-muted hover:bg-wash transition-colors"
    >
      <FilePlus size={17} strokeWidth={1.75} />
    </button>
  );
}

import { PanelRightOpen } from 'lucide-react';
import { useStore } from '../../store';
import { isTask } from '../../lib/agents/targets';
import { openTaskSurface } from '../../lib/documents/surface-store';
import { useT } from '../../i18n';
import { useZoomTier } from '../../lib/use-map-mode';
import TargetContextDropzone from './TargetContextDropzone';
import TargetPicker from './TargetPicker';

/**
 * What a task carries above its card: the AI it is bound to and the way to
 * give it another (while choosing per task is on), the way to open its
 * panel in a surface, and the place material is dropped to be wired to it. It stands outside the card, so
 * the card itself is the conversation node it always was. Far out, where
 * cards are icons, it is not drawn.
 */
export default function TaskBar({ nodeId }: { nodeId: string }) {
  const t = useT();
  const task = useStore((s) => isTask(s.nodes.find((n) => n.id === nodeId)));
  const question = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.question ?? '');
  const far = useZoomTier() === 'glyph';
  if (!task || far) return null;
  return (
    <div className="absolute left-0 bottom-full mb-1.5 flex items-center gap-1.5" data-task-bar={nodeId}>
      <TargetPicker nodeId={nodeId} />
      <button onClick={() => openTaskSurface(nodeId, question.trim().slice(0, 48) || t('target.panelUntitled'))} data-task-open-panel title={t('target.openPanel')}
        className="nodrag nopan w-6 h-6 rounded-full border border-line bg-card text-ink-faint hover:text-accent hover:border-accent flex items-center justify-center shadow-sm transition-colors">
        <PanelRightOpen size={12} strokeWidth={1.75} />
      </button>
      <TargetContextDropzone nodeId={nodeId} />
    </div>
  );
}

import { useStore } from '../../store';
import { isTask } from '../../lib/agents/targets';
import { useZoomTier } from '../../lib/use-map-mode';
import TargetContextDropzone from './TargetContextDropzone';
import TargetPicker from './TargetPicker';

/**
 * What a task carries above its card: the AI it is bound to (and the way
 * to give it another, or to open its panel in a surface) and the place
 * material is dropped to be wired to it. It stands outside the card, so
 * the card itself is the conversation node it always was. Far out, where
 * cards are icons, it is not drawn.
 */
export default function TaskBar({ nodeId }: { nodeId: string }) {
  const task = useStore((s) => isTask(s.nodes.find((n) => n.id === nodeId)));
  const far = useZoomTier() === 'glyph';
  if (!task || far) return null;
  return (
    <div className="absolute left-0 bottom-full mb-1.5 flex items-center gap-1.5" data-task-bar={nodeId}>
      <TargetPicker nodeId={nodeId} />
      <TargetContextDropzone nodeId={nodeId} />
    </div>
  );
}

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { useStore } from '../../store';
import { toast } from '../../lib/ui-store';
import { registerEntry } from '../../lib/workspace/client';
import { RESOURCE_DRAG_TYPE, parseDragPayload } from '../../lib/workspace/graph-resource';
import { connectNode, connectRefs, type ConnectResult } from '../../lib/agents/targets';
import { useT, fmt } from '../../i18n';

// Where material is dropped to wire it to one task. A drop here makes a
// reference and nothing else: an edge from the material to this task. It
// does not send the task, does not copy the text into the question, and
// does nothing to the file. Dropping on the question box itself is the
// other gesture (text goes into the text); this strip says which one it is.
//
// It also says how many things are wired to the task now.

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function TargetContextDropzone({ nodeId }: { nodeId: string }) {
  const t = useT();
  const inputs = useStore((s) => s.edges.filter((e) => e.target === nodeId).length);
  const [over, setOver] = useState(false);

  const said = (results: ConnectResult[]) => {
    if (results.some((r) => !r.ok && r.reason === 'loop')) toast('error', t('target.loopRefused'));
    else if (results.some((r) => !r.ok)) toast('error', t('target.wireFailed'));
  };
  const drop = async (raw: string) => {
    const payload = parseDragPayload(raw);
    // a folder is not material for a question, and anything that is not a reference by id is not taken
    if (!payload || payload.kind === 'folder-ref') return;
    try {
      if (payload.kind === 'graph-node') said([connectNode(payload.nodeId, nodeId)]);
      else if (payload.kind === 'selection-ref') said(await connectRefs(nodeId, [payload.ref]));
      else {
        const record = await registerEntry(payload.workspaceId, payload.entryId);
        said(await connectRefs(nodeId, [{ fileId: record.fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }]));
      }
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    }
  };

  return (
    <div
      data-target-dropzone={over ? 'over' : 'idle'}
      onDragOver={(e) => { if (!e.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'link'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(RESOURCE_DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void drop(raw);
      }}
      title={t('target.dropTitle')}
      className={`nodrag nopan flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs shadow-sm transition-colors ${over ? 'border-accent bg-accent/10 text-accent' : 'border-dashed border-line bg-card text-ink-muted'}`}
    >
      <Link2 size={12} strokeWidth={1.75} className="shrink-0" />
      <span data-target-inputs={inputs}>{over ? t('target.dropHere') : fmt(t('target.inputs'), { n: inputs })}</span>
    </div>
  );
}

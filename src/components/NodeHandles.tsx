import { Handle, Position } from '@xyflow/react';

/**
 * The four places a material's lines leave from. A line can be drawn from any of
 * them; nothing is wired into a material, so none takes a line's end.
 */
export function MaterialHandles({ className, glyph = false }: { className: string; glyph?: boolean }) {
  const side = (offset: string) => (glyph ? { top: '50%', left: offset, right: 'auto' } : { top: '50%' });
  return (
    <>
      <Handle type="source" position={Position.Top} id="top" isConnectableEnd={false} className={className} style={glyph ? { left: '50%' } : undefined} />
      <Handle type="source" position={Position.Left} id="left" isConnectableEnd={false} className={className} style={side('calc(50% - 56px)')} />
      <Handle type="source" position={Position.Bottom} id="continue" isConnectableEnd={false} className={className} style={glyph ? { left: '50%' } : undefined} />
      {/* reader-grown branches leave through this one too: without it, React Flow drops those edges at glyph zoom */}
      <Handle type="source" position={Position.Right} id="branch" isConnectableEnd={false} className={className} style={side('calc(50% + 56px)')} />
    </>
  );
}

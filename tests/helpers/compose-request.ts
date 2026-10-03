import { buildContext } from '../../src/store/context-builder';
import type { ContextMessage, ImageAttachment } from '../../src/lib/api';
import type { ThoughtEdge, ThoughtNode } from '../../src/types';

/**
 * The messages a generation of `nodeId` sends, assembled the way the store's
 * addQuestion does (src/store/slices/llm.ts): the parent's context compiled
 * with the node's own exclusion lists, then the node's own attachments, then
 * its question. A mirror for tests that need the request without running the
 * whole generation; keep it in step with that function.
 */
export function composeRequest(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): { messages: ContextMessage[]; images: ImageAttachment[] } {
  const self = nodes.find((n) => n.id === nodeId);
  if (!self) throw new Error(`no node ${nodeId}`);
  const parentId = edges.find((e) => e.target === nodeId && !e.data?.isCrossLink)?.source;
  const ctx = parentId
    ? buildContext(parentId, nodes, edges, undefined, self.data.excludedAttachmentIds, self.data.includedAttachmentIds)
    : { messages: [] as ContextMessage[], images: [] as ImageAttachment[] };
  const messages = [...ctx.messages];
  const images = [...ctx.images];
  for (const att of self.data.attachments) {
    const alreadyInContext = messages.some((m) => m.content.includes(`[PDF: ${att.name}]`) || m.content.includes(`[File: ${att.name}]`));
    if (alreadyInContext) continue;
    if (att.type.startsWith('image/')) images.push({ data: att.content, mimeType: att.type });
    else if (att.type === 'application/pdf' || att.type === 'text/html') {
      if (att.extractedText?.trim()) messages.push({ role: 'user', content: `[${att.type === 'application/pdf' ? 'PDF' : 'File'}: ${att.name}]\n${att.extractedText}` });
    } else if (att.content) messages.push({ role: 'user', content: `[File: ${att.name}]\n${att.content}` });
  }
  messages.push({ role: 'user', content: self.data.question });
  return { messages, images };
}

import { afterEach, describe, expect, it } from 'vitest';
import { buildContext } from '../../src/store/context-builder';
import { useStore } from '../../src/store';
import type { Attachment, ThoughtNode } from '../../src/types';

// Two files are the same file only when they hold the same thing. Files that
// share a name, a length and an opening (a common header) and differ further
// on are two files: each is kept on a node, each reaches the context. The
// same file given twice (inherited down a conversation, or attached again)
// is given once.

const HEADER = '# Synthetic report\n' + 'x'.repeat(120) + '\n';
const file = (id: string, tail: string): Attachment => ({ id, name: 'report.md', type: 'text/markdown', size: (HEADER + tail).length, content: HEADER + tail });
const node = (id: string, attachments: Attachment[], extra: Partial<ThoughtNode['data']> = {}): ThoughtNode => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: { question: `q-${id}`, response: `a-${id}`, responses: [`a-${id}`], responseIndex: 0, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', roleMode: 'inherit', attachments, excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: true, isBranch: false, ...extra },
});

afterEach(() => useStore.setState({ nodes: [], edges: [] }));

describe('which attachments are the same file', () => {
  it('[T11] two files that differ only after a shared opening both reach the context; the same file twice reaches it once', () => {
    const one = file('a1', 'TAIL_ONE_V5\n');
    const two = file('a2', 'TAIL_TWO_W6\n');
    const again = { ...one, id: 'a3' };
    const nodes = [node('p', [one]), node('c', [two, again], { isRoot: false })];
    const { messages } = buildContext('c', nodes, [{ id: 'e', source: 'p', target: 'c' }]);
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toContain('TAIL_ONE_V5');
    expect(text).toContain('TAIL_TWO_W6');
    expect(text.split('TAIL_ONE_V5').length - 1).toBe(1);
  });

  it('[T11] a node keeps two files that differ only after a shared opening, and not the same file twice', () => {
    useStore.setState({ nodes: [node('n', [])], edges: [] });
    useStore.getState().addAttachment('n', file('a1', 'TAIL_ONE_V5\n'));
    useStore.getState().addAttachment('n', file('a2', 'TAIL_TWO_W6\n'));
    useStore.getState().addAttachment('n', file('a3', 'TAIL_ONE_V5\n'));
    expect(useStore.getState().nodes[0].data.attachments.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

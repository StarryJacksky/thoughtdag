import { beforeAll, describe, expect, it } from 'vitest';
import { isFreshNode, markNodeSeen } from '../../src/lib/fresh-nodes';
import { flushPendingWrites } from '../../src/lib/persistence';
import { useStore } from '../../src/store';
import { bootProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';

// Which nodes are new on the canvas, for the one thing that asks: whether a
// node waiting for its question may take the focus. The nodes a canvas is
// opened with are not new; a node made since is, until it has had the focus.

/** A node that waits for its question. */
const ask = (id: string) => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: { question: '', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', isRoot: false, isBranch: false },
}) as unknown as ThoughtNode;

beforeAll(() => bootProjects());

describe('new nodes on the canvas', () => {
  it('a node the canvas is opened with is not new; one made since is, until it has had the focus', async () => {
    useStore.setState({ nodes: [ask('ask-from-before')], edges: [] });
    await flushPendingWrites();
    // the canvas is opened again (the page loaded anew): its question is still waiting, but it was not made just now
    await useStore.persist.rehydrate();
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual(['ask-from-before']);
    expect(isFreshNode('ask-from-before')).toBe(false);

    useStore.setState({ nodes: [...useStore.getState().nodes, ask('ask-made-now')] });
    expect(isFreshNode('ask-made-now')).toBe(true);
    expect(isFreshNode('ask-made-now'), 'asking changes nothing').toBe(true);
    // it took the focus; mounted again later (it went out of view and came back), it does not take it again
    markNodeSeen('ask-made-now');
    expect(isFreshNode('ask-made-now')).toBe(false);
  });
});

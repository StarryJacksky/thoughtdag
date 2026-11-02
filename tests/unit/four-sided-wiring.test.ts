import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeNode } from '../../src/lib/import-chat';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';

// A line goes from where it was drawn from to where it was drawn to, and sits on the
// sides it was drawn on (T26c). What kind of line it is has nothing to do with the
// sides. A line nobody chose sides for is drawn by the old rule.

const add = (id: string, x: number, y: number, more: Partial<ThoughtNode['data']> = {}) => {
  const made = makeNode(`The question of ${id}?`, `The answer of ${id}`, true) as ThoughtNode;
  useStore.setState((st) => ({ nodes: [...st.nodes, { ...made, id, position: { x, y }, data: { ...made.data, ...more } }] }));
  return id;
};
const edge = (source: string, target: string) => useStore.getState().edges.find((e) => e.source === source && e.target === target)!;

beforeAll(() => bootProjects());
beforeEach(() => {
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'c', name: 'c', createdAt: 0, updatedAt: 0 }], activeId: 'c', switching: false });
});

describe('[T26c] a line drawn on chosen sides', () => {
  for (const [sourceHandle, targetHandle] of [['branch', 'left'], ['left', 'branch'], ['top', 'continue'], ['continue', 'top'], ['branch', 'top'], ['left', 'continue']]) {
    it(`[T26c] from ${sourceHandle} to ${targetHandle}: it sits there, and goes the way it was drawn`, () => {
      const a = add('a', 0, 0);
      const b = add('b', 900, 0);
      useStore.getState().addCrossLink(a, b, { sourceHandle, targetHandle });
      const line = edge(a, b);
      expect(line.sourceHandle).toBe(sourceHandle);
      expect(line.targetHandle).toBe(targetHandle);
      expect(line.data?.isCrossLink).toBe(true);
      expect(line.data?.sidesChosen).toBe(true);
      expect(edge(b, a)).toBeUndefined();
    });
  }

  it('[T26c] a line that closes a loop is a feedback line, on the sides it was drawn on', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(a, b);
    useStore.getState().addCrossLink(b, a, { sourceHandle: 'top', targetHandle: 'continue' });
    const back = edge(b, a);
    expect(back.data?.feedback).toBeTruthy();
    expect(back.sourceHandle).toBe('top');
    expect(back.targetHandle).toBe('continue');
  });

  it('[T26c] from a material, solid as ever, on the sides it was drawn on', () => {
    const note = add('note', 0, 0, { stepKind: 'note' });
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(note, b, { sourceHandle: 'left', targetHandle: 'branch' });
    const line = edge(note, b);
    expect(line.data?.isCrossLink).toBeFalsy();
    expect(line.sourceHandle).toBe('left');
    expect(line.targetHandle).toBe('branch');
  });

  it('[T26c] made solid or dashed again, it stays on its sides', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(a, b, { sourceHandle: 'left', targetHandle: 'branch' });
    useStore.getState().setEdgeStructural(edge(a, b).id, true);
    expect(edge(a, b).data?.isCrossLink).toBeFalsy();
    expect([edge(a, b).sourceHandle, edge(a, b).targetHandle]).toEqual(['left', 'branch']);
    useStore.getState().setEdgeStructural(edge(a, b).id, false);
    expect([edge(a, b).sourceHandle, edge(a, b).targetHandle]).toEqual(['left', 'branch']);
  });

  it('[T26c] a line from a node to itself is not made', () => {
    const a = add('a', 0, 0);
    useStore.getState().addCrossLink(a, a, { sourceHandle: 'branch', targetHandle: 'left' });
    expect(useStore.getState().edges).toEqual([]);
  });
});

describe('[T26c] a line nobody chose sides for', () => {
  it('[T26c] into a node right below: bottom to top', () => {
    const a = add('a', 0, 0);
    const b = add('b', 100, 400);
    useStore.getState().addCrossLink(a, b);
    expect([edge(a, b).sourceHandle, edge(a, b).targetHandle]).toEqual(['continue', 'top']);
    expect(edge(a, b).data?.sidesChosen).toBeUndefined();
  });

  it('[T26c] anywhere else: out of the right, into the left', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(a, b);
    expect([edge(a, b).sourceHandle, edge(a, b).targetHandle]).toEqual(['branch', 'left']);
  });
});

describe('[T26c] a line moved to other sides', () => {
  it('[T26c] only its sides change: its kind, its ends and what it holds stay', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(a, b);
    const was = edge(a, b);
    expect(useStore.getState().setEdgeSides(was.id, { source: a, target: b, sourceHandle: 'top', targetHandle: 'branch' })).toBe(true);
    const now = edge(a, b);
    expect([now.sourceHandle, now.targetHandle]).toEqual(['top', 'branch']);
    expect(now.data?.isCrossLink).toBe(true);
    expect(now.data?.sidesChosen).toBe(true);
    expect(now.id).toBe(was.id);
  });

  it('[T26c] taken to another node, it is not moved: that would be another line', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    const c = add('c', 900, 900);
    useStore.getState().addCrossLink(a, b);
    const was = edge(a, b);
    expect(useStore.getState().setEdgeSides(was.id, { source: a, target: c, sourceHandle: 'top', targetHandle: 'branch' })).toBe(false);
    expect(edge(a, b)).toEqual(was);
    expect(edge(a, c)).toBeUndefined();
  });

  it('[T26c] it can be undone', () => {
    const a = add('a', 0, 0);
    const b = add('b', 900, 0);
    useStore.getState().addCrossLink(a, b);
    const was = edge(a, b);
    useStore.getState().setEdgeSides(was.id, { source: a, target: b, sourceHandle: 'top', targetHandle: 'branch' });
    useStore.getState().undo();
    expect([edge(a, b).sourceHandle, edge(a, b).targetHandle]).toEqual([was.sourceHandle, was.targetHandle]);
  });
});

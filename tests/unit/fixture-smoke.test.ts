import { describe, expect, it } from 'vitest';
import { fixture, fixtureNames } from '../fixtures/research';

// The test chain itself: fixtures load, expand to store shapes, and hold to
// the rules every later task relies on.

describe('research fixtures', () => {
  it('lists the baseline scenarios', () => {
    expect(fixtureNames()).toEqual(expect.arrayContaining([
      'excluded-attachment',
      'same-name-different-dirs',
      'same-name-same-prefix',
      'single-parent-edited-ancestor',
    ]));
  });

  it('names what it has when asked for a fixture it lacks', () => {
    expect(() => fixture('no-such-fixture')).toThrow(/no research fixture named "no-such-fixture"/);
  });

  it.each(fixtureNames())('%s expands to a canvas the store can hold', (name) => {
    const f = fixture(name);
    const ids = new Set(f.graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.graph.nodes.length);
    for (const n of f.graph.nodes) expect(n.type).toBe('thought');
    for (const e of f.graph.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    expect(ids.has(f.expected.targetNodeId)).toBe(true);
    if (f.nativeHistory) expect(ids.has(f.nativeHistory.tailNodeId)).toBe(true);
  });

  it('single-parent-edited-ancestor changes one variable: the ancestor answer', () => {
    const f = fixture('single-parent-edited-ancestor');
    expect(f.edited.edges).toEqual(f.graph.edges);
    const differing = f.graph.nodes.filter((n, i) => JSON.stringify(n) !== JSON.stringify(f.edited.nodes[i]));
    expect(differing.map((n) => n.id)).toEqual(['n1']);
    const before = f.graph.nodes[0].data;
    const after = f.edited.nodes[0].data;
    expect({ ...after, response: before.response, responses: before.responses }).toEqual(before);
    expect(after.response).toContain('EDITED_UPSTREAM_M3');
  });

  it('same-name-same-prefix holds two different files alike in name, size and first hundred characters', () => {
    const f = fixture('same-name-same-prefix');
    const [one, two] = f.graph.nodes.flatMap((n) => n.data.attachments);
    expect(one.name).toBe(two.name);
    expect(one.size).toBe(two.size);
    expect(one.content.slice(0, 100)).toBe(two.content.slice(0, 100));
    expect(one.content).not.toBe(two.content);
  });
});

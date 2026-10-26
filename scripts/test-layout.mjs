#!/usr/bin/env node
// Layout invariants. autoLayout is pure, but it lives in src/ where the module
// graph reaches import.meta.env, so it is bundled for node the same way the
// benchmark compiler bundles product code (benchmark/tools/build-bundle.sh).
//
// The rules being checked are the canvas grammar, not aesthetics:
//   - a node CONTINUES below every parent it continues from
//   - a node EXPLORED out of a parent stands beside it, never above its top
//   - no two thought cards overlap
//   - the same graph, handed over in a different order, lays out the same way
//   - adding a node moves no node already on the canvas
//
// Run: node scripts/test-layout.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-layout-'));
const bundle = join(tmp, 'layout.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/layout.ts'), '--bundle', '--format=esm', '--platform=node',
  `--outfile=${bundle}`, '--define:import.meta.env.VITE_API_BASE=""',
  '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { autoLayout, placeNewNodes, nodeHeight } = await import(pathToFileURL(bundle).href);
const framesBundle = join(tmp, 'frames.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/frames.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${framesBundle}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { frameMembers } = await import(pathToFileURL(framesBundle).href);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const NODE_W = 520;
const CONTENT = new Set(['note', 'file', 'link', 'frame']);
const th = (id, over = {}) => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: {
    question: 'q', response: 'r', responses: ['r'], responseIndex: 0,
    isCollapsed: true, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: 0, highlights: [], highlightMode: false, roleMode: 'assistant',
    attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
    isRoot: false, isBranch: false, ...over,
  },
});
const file = (id, x) => ({ ...th(id, { stepKind: 'file' }), position: { x, y: 0 }, measured: { width: 120, height: 120 } });
const frame = (id, x, y, width, height, frameCarry = true) => ({
  ...th(id, { stepKind: 'frame', frameCarry }), position: { x, y }, width, height, zIndex: -1,
});
const placed = (node, x, y, width = 520, height = 120) => ({
  ...node, position: { x, y }, measured: { width, height },
});
const ed = (s, t, data) => ({ id: `${s}->${t}`, source: s, target: t, ...(data ? { data } : {}) });
const xOf = (laid, id) => laid.find((n) => n.id === id).position.x;
const nodeOf = (laid, id) => laid.find((n) => n.id === id);

// Every arrow-order and overlap rule, checked per edge.
function violations(laid, edges) {
  const by = new Map(laid.map((n) => [n.id, n]));
  const out = [];
  for (const e of edges) {
    if (e.data?.isCrossLink) continue;
    const s = by.get(e.source), t = by.get(e.target);
    if (!s || !t || CONTENT.has(s.data?.stepKind) || CONTENT.has(t.data?.stepKind)) continue;
    if (e.data?.isBranchFromSelection) {
      if (t.position.y < s.position.y) out.push(`explore ${e.source}->${e.target} above parent top`);
    } else if (t.position.y < s.position.y + nodeHeight(s)) {
      out.push(`structural ${e.source}->${e.target} above parent bottom`);
    }
  }
  const solid = laid.filter((n) => !CONTENT.has(n.data?.stepKind));
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if (a.position.x < b.position.x + NODE_W && b.position.x < a.position.x + NODE_W &&
        a.position.y < b.position.y + nodeHeight(b) && b.position.y < a.position.y + nodeHeight(a))
      out.push(`overlap ${a.id}/${b.id}`);
  }
  return out;
}

console.log('layout invariants\n');

test('a merge sits under the parent it was continued from: the first edge in, not the median', () => {
  const nodes = ['root', 'p1', 'p2', 'p3', 'merge'].map((i) => th(i));
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p3', 'merge'), ed('p1', 'merge'), ed('p2', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'p3'),
    `merge at ${xOf(laid, 'merge')}, first parent p3 at ${xOf(laid, 'p3')}`);
});

test('the same graph in a different node order lays out the same way', () => {
  const ids = ['root', 'p1', 'p2', 'p3', 'merge'];
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p1', 'merge'), ed('p2', 'merge'), ed('p3', 'merge')];
  const byId = new Map(ids.map((i) => [i, th(i)]));
  const sig = (order) => autoLayout(order.map((i) => byId.get(i)), edges)
    .map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).sort().join('|');
  const a = sig(ids), b = sig([...ids].reverse()), c = sig(['root', 'p3', 'p1', 'p2', 'merge']);
  assert(a === b && b === c, 'layout changed when the node array was permuted');
});

test('an explore branch follows the merge that moves beneath its parents', () => {
  const nodes = ['rootA', 'rootB', 'B', 'merge', 'branch'].map((i) => th(i));
  const edges = [ed('rootB', 'B'), ed('rootA', 'merge'), ed('B', 'merge'),
                 ed('merge', 'branch', { isBranchFromSelection: true })];
  const laid = autoLayout(nodes, edges);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a merge continued from one parent and explored from another keeps the plain column', () => {
  const nodes = ['explore', 'a', 'b', 'plain', 'merge'].map((i) => th(i));
  const edges = [ed('a', 'b'), ed('b', 'plain'),
                 ed('explore', 'merge', { isBranchFromSelection: true }), ed('plain', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'plain'),
    `merge at ${xOf(laid, 'merge')}, plain parent at ${xOf(laid, 'plain')}`);
});

test('a merge of material-anchored chains follows its first parent, wherever that chain sits', () => {
  const nodes = [file('mLeft', 0), file('mMid', 1000), file('mRight', 2000),
                 th('qRight'), th('qLeft'), th('qMid'), th('merge')];
  const edges = [ed('mRight', 'qRight'), ed('mLeft', 'qLeft'), ed('mMid', 'qMid'),
                 ed('qRight', 'merge'), ed('qLeft', 'merge'), ed('qMid', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'qRight'),
    `merge at ${xOf(laid, 'merge')}, first parent qRight at ${xOf(laid, 'qRight')}`);
});

test('a chain reading several documents hangs from the lowest of them', () => {
  const nodes = [file('f0', 0), file('f1', 900), file('f2', 1800), file('f3', 2700), file('f4', 3600), th('synth')];
  nodes[3].position.y = 400; // f3 hangs lowest
  const edges = ['f0', 'f1', 'f2', 'f3', 'f4'].map((f) => ed(f, 'synth'));
  const x = xOf(autoLayout(nodes, edges), 'synth');
  assert(Math.abs(x - (2700 - 60)) < 1, `synthesis at ${x}, not under the lowest document f3`);
});

test('a linked frame with members is untouched by auto layout, its members still laid out (#64)', () => {
  const original = frame('frame', 0, 400, 700, 900);
  const laid = autoLayout([
    original,
    placed(th('root'), 100, 500, 520, 260),
    placed(th('child'), 100, 900, 520, 260),
  ], [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame'), root = nodeOf(laid, 'root'), child = nodeOf(laid, 'child');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'linked frame moved');
  assert(f.width === original.width && f.height === original.height, 'linked frame resized');
  assert(child.position.y > root.position.y && child.position.x === root.position.x, 'child not laid out under its parent');
});

test('an unlinked frame is untouched by auto layout', () => {
  const original = frame('frame', 0, 400, 700, 900, false);
  const laid = autoLayout([
    original,
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
  ], [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'unlinked frame moved');
  assert(f.width === original.width && f.height === original.height, 'unlinked frame resized');
});

test('a linked frame with no members is untouched by auto layout', () => {
  const original = frame('empty', 2000, 2000, 700, 900);
  const laid = autoLayout([original, placed(th('root'), 0, 0)], []);
  const f = nodeOf(laid, 'empty');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'empty frame moved');
  assert(f.width === original.width && f.height === original.height, 'empty frame resized');
});

test('nested and overlapping frames are untouched by auto layout (#64)', () => {
  const originals = [
    frame('outer', 0, 400, 760, 1050),
    frame('inner', 50, 450, 660, 950),
    frame('leftFrame', 2000, 400, 650, 700),
    frame('rightFrame', 2150, 400, 650, 700),
  ];
  const laid = autoLayout([
    ...originals,
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
    placed(th('shared'), 2100, 500, 520, 120),
  ], [ed('root', 'child')]);
  for (const o of originals) {
    const f = nodeOf(laid, o.id);
    assert(f.position.x === o.position.x && f.position.y === o.position.y, `${o.id} moved`);
    assert(f.width === o.width && f.height === o.height, `${o.id} resized`);
  }
});

// #40: two linked frames that merely overlap must never own each other
test('a partially overlapping frame is not a member, its own nodes stay with it', () => {
  const F1 = frame('F1', 0, 0, 1000, 800);
  const F2 = frame('F2', 700, 500, 600, 500); // centre (1000, 750) inside F1, but not contained
  const a = placed(th('a'), 540, 540);        // centre (800, 600): inside both
  const far = placed(th('far'), 1000, 880);   // centre (1260, 940): inside F2 only
  const all = [F1, F2, a, far];
  const ids = (f) => frameMembers(f, all).map((n) => n.id).sort();
  assert(JSON.stringify(ids(F1)) === JSON.stringify(['a']), `F1 owns ${ids(F1)} (expected only a)`);
  assert(JSON.stringify(ids(F2)) === JSON.stringify(['a', 'far']), `F2 owns ${ids(F2)} (expected a, far)`);
});

test('a fully contained frame is a member of the outer frame, never the reverse', () => {
  const outer = frame('outer', 0, 0, 1000, 800);
  const inner = frame('inner', 100, 100, 400, 300);
  const n = placed(th('n'), 120, 120);
  const all = [outer, inner, n];
  const ids = (f) => frameMembers(f, all).map((x) => x.id).sort();
  assert(JSON.stringify(ids(outer)) === JSON.stringify(['inner', 'n']), `outer owns ${ids(outer)}`);
  assert(JSON.stringify(ids(inner)) === JSON.stringify(['n']), `inner owns ${ids(inner)}`);
});

test('auto layout leaves partially overlapping frames where they are (#64)', () => {
  const F1 = frame('F1', 0, 0, 1000, 800);
  const F2 = frame('F2', 700, 500, 600, 500);
  const laid = autoLayout([F1, F2, placed(th('a'), 540, 540, 520, 120), placed(th('far'), 1000, 880, 520, 120)], []);
  for (const o of [F1, F2]) {
    const f = nodeOf(laid, o.id);
    assert(f.position.x === o.position.x && f.position.y === o.position.y && f.width === o.width && f.height === o.height, `${o.id} changed`);
  }
});

// Adding a node seats that node only: the user's arrangement survives a
// follow-up, an explore, a merge (the questions hanging from a document used
// to jump back under the lowest document on every ask).
const fresh = (id, over = {}) => th(id, { response: '', responses: [], responseIndex: -1, isCollapsed: false, isLoading: true, ...over });
const unmoved = (before, after) => before.filter((n) => {
  const m = nodeOf(after, n.id);
  return m.position.x !== n.position.x || m.position.y !== n.position.y;
}).map((n) => n.id);

test('a follow-up moves no node already on the canvas, the dragged ones included', () => {
  const nodes = [file('pdf', 0), placed(file('md', 0), 930, -41, 400, 183),
                 placed(th('q1'), 420, 381), placed(th('q2'), 1500, 900)];
  const edges = [ed('pdf', 'q1'), ed('md', 'q1'), ed('q1', 'q2')];
  const all = [...nodes, fresh('q3')];
  const laid = placeNewNodes(all, [...edges, ed('q2', 'q3')], ['q3']);
  assert(unmoved(nodes, laid).length === 0, `moved: ${unmoved(nodes, laid)}`);
  const q2 = nodeOf(laid, 'q2'), q3 = nodeOf(laid, 'q3');
  assert(q3.position.x === q2.position.x, `follow-up at x ${q3.position.x}, its parent at ${q2.position.x}`);
  assert(q3.position.y >= q2.position.y + nodeHeight(q2), 'follow-up above its parent bottom');
});

test('a parent folded by the ask is measured folded: the follow-up sits right under it', () => {
  const parent = { ...placed(th('p'), 0, 0, 520, 700), data: { ...th('p').data, isCollapsed: true } };
  const laid = placeNewNodes([parent, fresh('c')], [ed('p', 'c')], ['c']);
  const y = nodeOf(laid, 'c').position.y;
  assert(y < 700, `follow-up at y ${y}, below the parent's stale unfolded height`);
});

test('a second child stands one column right of the first, never on it', () => {
  const nodes = [placed(th('p'), 100, 100), placed(th('first'), 100, 400)];
  const laid = placeNewNodes([...nodes, fresh('second')], [ed('p', 'first'), ed('p', 'second')], ['second']);
  const s2 = nodeOf(laid, 'second');
  assert(s2.position.x > 100 + NODE_W, `second child at x ${s2.position.x}`);
  assert(violations(laid, [ed('p', 'first'), ed('p', 'second')]).length === 0, violations(laid, [ed('p', 'first'), ed('p', 'second')]).join('; '));
});

test('an explored branch stands beside its parent', () => {
  const edges = [ed('p', 'x', { isBranchFromSelection: true })];
  const laid = placeNewNodes([placed(th('p'), 0, 0), fresh('x')], edges, ['x']);
  const x = nodeOf(laid, 'x');
  assert(x.position.x >= NODE_W && x.position.y >= 0, `branch at ${x.position.x},${x.position.y}`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a question grown from documents hangs under the lowest one; a taken spot moves it right', () => {
  const docs = [file('f0', 0), { ...file('f1', 900), position: { x: 900, y: 400 } }];
  const blocker = placed(th('there'), 840, 640, 520, 300);
  const edges = [ed('f0', 'q'), ed('f1', 'q')];
  const free = placeNewNodes([...docs, fresh('q')], edges, ['q']);
  assert(xOf(free, 'q') === 900 - 60, `question at x ${xOf(free, 'q')}, not under the lowest document`);
  const taken = placeNewNodes([...docs, blocker, fresh('q')], edges, ['q']);
  assert(xOf(taken, 'q') > 840 + NODE_W, `question at x ${xOf(taken, 'q')}, on top of the card already there`);
  assert(unmoved([...docs, blocker], taken).length === 0, 'an existing node moved');
});

test('a fan-out seats its branches side by side without overlap', () => {
  const ids = ['b1', 'b2', 'b3', 'b4'];
  const edges = ids.map((i) => ed('p', i, { isBranchFromSelection: true }));
  const laid = placeNewNodes([placed(th('p'), 0, 0), ...ids.map((i) => fresh(i))], edges, ids);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a merge sits below the lowest parent it continues from, under the first', () => {
  const nodes = [placed(th('a'), 0, 0), placed(th('b'), 700, 600)];
  const edges = [ed('a', 'm'), ed('b', 'm')];
  const laid = placeNewNodes([...nodes, fresh('m')], edges, ['m']);
  assert(xOf(laid, 'm') === 0, `merge at x ${xOf(laid, 'm')}, not under its first parent`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a new root lands right of the canvas, level with its top', () => {
  const nodes = [placed(th('a'), 0, 200), placed(th('b'), 900, 500)];
  const laid = placeNewNodes([...nodes, fresh('r')], [], ['r']);
  const r = nodeOf(laid, 'r');
  assert(r.position.x >= 900 + NODE_W && r.position.y === 200, `new root at ${r.position.x},${r.position.y}`);
});

test('on every benchmark canvas a leaf re-added after layout keeps the arrow order and overlaps nothing', () => {
  const dir = join(ROOT, 'benchmark/canvases/inputs');
  let checked = 0; const bad = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.thoughtdag.json'))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const edges = c.edges ?? [];
    const laid = autoLayout(c.nodes ?? [], edges);
    const leaves = laid.filter((n) => !CONTENT.has(n.data?.stepKind) && !edges.some((e) => e.source === n.id)
      && edges.some((e) => e.target === n.id && !e.data?.isCrossLink));
    for (const leaf of leaves.slice(0, 6)) {
      const rest = laid.filter((n) => n.id !== leaf.id);
      const again = placeNewNodes([...rest, { ...leaf, position: { x: 0, y: 0 } }], edges, [leaf.id]);
      const v = violations(again, edges.filter((e) => e.target === leaf.id))
        .concat(violations(again, []).filter((m) => m.split(' ')[1].split('/').includes(leaf.id)));
      checked++;
      if (v.length) bad.push(`${f} ${leaf.id}: ${v[0]}`);
      if (unmoved(rest, again).length) bad.push(`${f} ${leaf.id}: moved ${unmoved(rest, again)[0]}`);
    }
  }
  assert(checked > 0, 'no leaves checked');
  assert(bad.length === 0, `${bad.length}/${checked} re-added leaves break a rule: ${bad[0]}`);
});

test('the benchmark canvases keep the arrow order', () => {
  const dir = join(ROOT, 'benchmark/canvases/inputs');
  let checked = 0, bad = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.thoughtdag.json'))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const v = violations(autoLayout(c.nodes ?? [], c.edges ?? []), c.edges ?? []);
    checked++;
    if (v.length) bad.push(`${f}: ${v[0]}`);
  }
  assert(checked > 0, 'no benchmark canvases found');
  assert(bad.length === 0, `${bad.length}/${checked} canvases violate: ${bad[0]}`);
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : '\nall passed');
process.exit(failures ? 1 : 0);

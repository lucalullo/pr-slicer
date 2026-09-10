import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../../dist/config/index.js';
import { collapseGraph } from '../../dist/graph/graph.js';
import { stronglyConnected } from '../../dist/graph/strongly-connected.js';
import { topologicalOrder } from '../../dist/graph/topological-order.js';
import { UnionFind } from '../../dist/graph/union-find.js';
import { planCandidates } from '../../dist/planner/index.js';

const config = (limits = {}) => normalizeConfig({ limits: { targetChangedLines: 20, hardMaxChangedLines: 100, targetFiles: 4, hardMaxFiles: 20, ...limits } });
const unit = (id, options = {}) => ({ id, fileId: `file_${id}`, changeKind: 'modify', syntaxKind: 'function', oldPath: `src/${id}.ts`, newPath: `src/${id}.ts`, hunkIds: [`h_${id}`], symbolIds: [id], packageId: null, area: null, addedLines: 20, deletedLines: 0, isTest: false, isGenerated: false, isAtomic: false, ...options });
const edge = (from, to, kind = 'before', options = {}) => ({ id: `${kind}_${from}_${to}`, from, to, kind, weight: 90, evidence: [{ type: kind, message: `${from} ${kind} ${to}` }], ...options });
function invariants(plan, units, edges, cfg) {
  for (const candidate of plan.candidates) {
    const flattened = candidate.groups.flatMap(group => group.unitIds);
    assert.deepEqual([...flattened].sort(), units.map(unit => unit.id).sort());
    assert.equal(new Set(flattened).size, units.length);
    const groupOf = new Map(candidate.groups.flatMap((group, i) => group.unitIds.map(id => [id, i])));
    for (const relation of edges) {
      if (relation.kind === 'must_with') assert.equal(groupOf.get(relation.from), groupOf.get(relation.to));
      if (relation.kind === 'before') assert.ok(groupOf.get(relation.from) <= groupOf.get(relation.to));
    }
    if (plan.status !== 'cannot-safely-split') for (const group of candidate.groups) {
      assert.ok(group.addedLines + group.deletedLines <= cfg.limits.hardMaxChangedLines);
      assert.ok(group.files.length <= cfg.limits.hardMaxFiles);
    }
    for (let i = 0; i < candidate.groups.length; i++) for (const dependency of candidate.groups[i].dependsOn) {
      assert.ok(candidate.groups.slice(0, i).some(group => group.id === dependency));
    }
  }
  assert.ok(plan.candidates.length <= 5);
  assert.equal(new Set(plan.candidates.map(candidate => candidate.id)).size, plan.candidates.length);
}

test('Union-Find picks a stable representative and rejects unknown units', () => {
  const uf = new UnionFind(['a', 'b', 'c']); uf.union('c', 'b'); uf.union('b', 'a');
  assert.equal(uf.find('c'), 'a'); assert.throws(() => uf.find('missing'));
});

test('Tarjan collapses cycles without losing isolated nodes', () => {
  assert.deepEqual(stronglyConnected(['d', 'c', 'b', 'a'], new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]])), [['a', 'b', 'c'], ['d']]);
});

test('Tarjan and topological ordering avoid call-stack overflow', () => {
  const nodes = Array.from({ length: 12000 }, (_, i) => String(i).padStart(5, '0'));
  const adjacency = new Map(nodes.slice(0, -1).map((node, i) => [node, [nodes[i + 1]]]));
  assert.equal(stronglyConnected(nodes, adjacency).length, nodes.length);
  assert.deepEqual(topologicalOrder(nodes.toReversed(), adjacency), nodes);
});

test('topological lexical ties are stable and cycles fail explicitly', () => {
  const adjacency = new Map([['a', ['d']], ['b', ['d']], ['c', []], ['d', []]]);
  assert.deepEqual(topologicalOrder(['d', 'c', 'b', 'a'], adjacency), ['a', 'b', 'c', 'd']);
  assert.throws(() => topologicalOrder(['a', 'b'], new Map([['a', ['b']], ['b', ['a']]])), /cyclic/);
});

test('must_with collapse preserves before arcs and cycle evidence', () => {
  const units = ['a', 'b', 'c', 'd'].map(id => unit(id)), edges = [edge('a', 'b', 'must_with'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd')];
  const graph = collapseGraph(units, edges);
  assert.equal(graph.components.length, 2);
  assert.equal(graph.componentOf.get('a'), graph.componentOf.get('c'));
  assert.deepEqual(graph.adjacency.get(graph.componentOf.get('a')), [graph.componentOf.get('d')]);
  assert.ok(graph.warnings.some(warning => warning.type === 'dependency-cycle'));
  const cfg = config({ hardMaxChangedLines: 70 }), plan = planCandidates(units, edges, cfg); invariants(plan, units, edges, cfg);
});

test('separate hunks of the same file may belong to distinct groups', () => {
  const units = [unit('a', { addedLines: 10, fileId: 'same', newPath: 'src/same.ts', oldPath: 'src/same.ts' }), unit('b', { addedLines: 10, fileId: 'same', newPath: 'src/same.ts', oldPath: 'src/same.ts' })];
  const cfg = config({ targetChangedLines: 10, hardMaxChangedLines: 15 }), plan = planCandidates(units, [edge('a', 'b')], cfg);
  assert.equal(plan.groups.length, 2); assert.notEqual(plan.groups[0].id, plan.groups[1].id);
  assert.deepEqual(plan.groups[1].dependsOn, [plan.groups[0].id]); invariants(plan, units, [edge('a', 'b')], cfg);
});

test('oversized indivisible units explain cannot-safely-split', () => {
  const units = [unit('a'), unit('b')], edges = [edge('a', 'b', 'must_with')], cfg = config({ hardMaxChangedLines: 25 });
  const plan = planCandidates(units, edges, cfg);
  assert.equal(plan.status, 'cannot-safely-split'); assert.equal(plan.groups.length, 1);
  assert.ok(plan.warnings.some(warning => warning.type === 'oversized-indivisible-group'));
  assert.equal(plan.metrics.verificationCoverage.passed, 0); invariants(plan, units, edges, cfg);
});

test('maxGroups and hard file count cannot be silently exceeded', () => {
  const units = ['a', 'b', 'c'].map(id => unit(id, { addedLines: 1 })), cfg = config({ maxGroups: 2, targetFiles: 1, hardMaxFiles: 1 });
  const plan = planCandidates(units, [], cfg);
  assert.equal(plan.status, 'cannot-safely-split'); assert.ok(plan.warnings.some(warning => warning.type === 'no-feasible-partition'));
});

test('unknown dependencies are explicit and concrete uncertainty is indivisible', () => {
  const units = [unit('a'), unit('b')], cfg = config();
  const edges = [edge('a', 'b', 'unknown', { evidence: [{ type: 'unresolved-change', message: 'Signature uncertain', details: { requiresTogether: true } }] })];
  const plan = planCandidates(units, edges, cfg);
  assert.equal(plan.groups.length, 1); assert.equal(plan.metrics.boundaryConfidence, 'low');
  assert.ok(plan.warnings.some(warning => warning.type === 'uncertain-boundary'));
});

test('test affinity discourages separating implementation and its test', () => {
  const units = [unit('implementation', { addedLines: 10 }), unit('test', { addedLines: 10, isTest: true })], cfg = config({ targetChangedLines: 10 });
  assert.equal(planCandidates(units, [], cfg).groups.length, 2);
  assert.equal(planCandidates(units, [edge('implementation', 'test', 'affinity', { weight: 100 })], cfg).groups.length, 1);
});

test('soft separation can separate small independent changes', () => {
  const units = [unit('a', { addedLines: 1 }), unit('b', { addedLines: 1 })];
  assert.equal(planCandidates(units, [edge('a', 'b', 'separate', { weight: 100 })], config()).groups.length, 2);
});

test('stable group IDs depend on membership, not presentation index', () => {
  const cfg = config({ targetChangedLines: 20, hardMaxChangedLines: 20 });
  const original = planCandidates([unit('b'), unit('c')], [], cfg), added = planCandidates([unit('a'), unit('b'), unit('c')], [], cfg);
  for (const group of original.groups) assert.equal(group.id, added.groups.find(other => other.unitIds[0] === group.unitIds[0]).id);
});

test('candidate cap retains an admissible single-group repair fallback', () => {
  const units = Array.from({ length: 9 }, (_, i) => unit(`u${i}`, { packageId: `p${i % 3}`, area: `area${(8 - i) % 4}`, addedLines: 15 })), cfg = config({ hardMaxChangedLines: 500 });
  const plan = planCandidates(units, [], cfg);
  assert.ok(plan.candidates.some(candidate => candidate.groups.length === 1)); invariants(plan, units, [], cfg);
});

test('deterministic generated graph corpus preserves hard constraints and membership', () => {
  for (let seed = 1; seed <= 24; seed++) {
    const units = Array.from({ length: 4 + seed % 9 }, (_, i) => unit(`u${i}`, { addedLines: 2 + (seed * (i + 1)) % 20, packageId: `p${i % 3}`, area: `area${(seed + i) % 2}` })), edges = [];
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      if ((i * 13 + j * 7 + seed) % 7 === 0) edges.push(edge(units[i].id, units[j].id));
      if ((i * 5 + j * 11 + seed) % 17 === 0) edges.push(edge(units[i].id, units[j].id, 'must_with'));
    }
    const cfg = config({ hardMaxChangedLines: 1000 }), plan = planCandidates(units, edges, cfg);
    invariants(plan, units, edges, cfg);
    assert.deepEqual(planCandidates(units.toReversed(), edges.toReversed(), cfg), plan);
  }
});

test('large graphs report sampled planning without dropping units', () => {
  const units = Array.from({ length: 805 }, (_, i) => unit(String(i).padStart(4, '0'), { addedLines: 1 })), cfg = config({ targetChangedLines: 250, hardMaxChangedLines: 500, targetFiles: 250, hardMaxFiles: 500 });
  const plan = planCandidates(units, [], cfg);
  assert.ok(plan.warnings.some(warning => warning.type === 'coarse-planning')); assert.equal(plan.metrics.boundaryConfidence, 'low');
  invariants(plan, units, [], cfg);
});

test('empty changes are a legitimate single-change plan', () => {
  const plan = planCandidates([], [], config()); assert.equal(plan.status, 'single-change'); assert.deepEqual(plan.groups, []);
});

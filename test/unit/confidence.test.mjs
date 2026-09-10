import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../../dist/planner/scoring.js';
import { normalizeConfig } from '../../dist/config/index.js';
const units = ['a','b','c','d'].map(id => ({ id, isGenerated: false, addedLines: 1, deletedLines: 0 }));
const groups = [{ unitIds: ['a','b'], files: ['a.ts','b.ts'] }, { unitIds: ['c','d'], files: ['c.ts','d.ts'] }];
const edges = [['a','c'],['b','d']].map(([from,to]) => ({ id: `${from}_${to}`, from, to, kind: 'before', weight: 95, evidence: [{ type: 'new-symbol-reference', message: 'Observed provider and changed consumer.', symbol: from, paths: [`${from}.ts`, `${to}.ts`] }] }));
const metrics = (relations = edges, coarse = false, selected = groups) => calculateMetrics(selected, units, relations, normalizeConfig({}), coarse);
test('high confidence requires two independent strong pairs across each real boundary', () => {
  assert.equal(metrics().boundaryConfidence, 'high');
  assert.equal(metrics(edges.toReversed()).boundaryConfidence, 'high');
  assert.equal(metrics([edges[0], { ...edges[0], id: 'duplicate-pair' }]).boundaryConfidence, 'medium');
  assert.equal(metrics(edges.map(edge => ({ ...edge, weight: 89 }))).boundaryConfidence, 'medium');
  assert.equal(metrics(edges.map(edge => ({ ...edge, evidence: [{ type: 'guess', message: 'Unproven claim' }] }))).boundaryConfidence, 'medium');
  assert.equal(metrics(edges, false, [{ unitIds: units.map(unit => unit.id), files: ['all.ts'] }]).boundaryConfidence, 'medium');
});
test('uncertainty, coarse planning, broken constraints or cut affinity prevent high', () => {
  assert.equal(metrics(edges, true).boundaryConfidence, 'low'); assert.equal(metrics([]).boundaryConfidence, 'low');
  assert.equal(metrics([...edges, { ...edges[0], id: 'unknown', kind: 'unknown' }]).boundaryConfidence, 'low');
  assert.notEqual(metrics([...edges, { ...edges[0], id: 'backward', from: 'd', to: 'a' }]).boundaryConfidence, 'high');
  assert.notEqual(metrics([...edges, { ...edges[0], id: 'cut', kind: 'affinity', weight: 100 }]).boundaryConfidence, 'high');
});

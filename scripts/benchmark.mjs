#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { posix } from 'node:path';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../dist/config/index.js';
import { planCandidates } from '../dist/planner/index.js';

// Curated synthetic graph benchmark. This is not a compilation or reconstruction benchmark.
const config = normalizeConfig({ limits: { targetChangedLines: 100, hardMaxChangedLines: 350, targetFiles: 5, hardMaxFiles: 20 } });
const unit = (id, path, lines, packageId, isTest = false) => ({ id, fileId: id, changeKind: 'modify', syntaxKind: isTest ? 'test' : 'function', oldPath: path, newPath: path, hunkIds: [id], symbolIds: [id], packageId, area: null, addedLines: lines, deletedLines: 0, isTest, isGenerated: false, isAtomic: false });
const edge = (from, to, kind) => ({ id: `${kind}:${from}:${to}`, from, to, kind, weight: 90, evidence: [{ type: kind, message: `${from} ${kind} ${to}` }] });
const scenarios = [
  { name: 'contract-backend-ui', units: [unit('types', 'packages/core/types.ts', 70, 'core'), unit('backend', 'packages/backend/service.ts', 80, 'backend'), unit('backend-test', 'test/backend.spec.ts', 30, 'backend', true), unit('ui', 'packages/ui/view.tsx', 80, 'ui'), unit('ui-test', 'test/ui.spec.tsx', 30, 'ui', true)], edges: [edge('types', 'backend', 'before'), edge('types', 'ui', 'before'), edge('backend', 'ui', 'before'), edge('backend', 'backend-test', 'must_with'), edge('ui', 'ui-test', 'must_with')] },
  { name: 'signature-cycle', units: [unit('api', 'src/api.ts', 90, 'core'), unit('consumer', 'src/consumer.ts', 80, 'app'), unit('cycle-test', 'test/api.test.ts', 25, 'core', true), unit('docs', 'docs/api.md', 40, 'docs')], edges: [edge('api', 'consumer', 'before'), edge('consumer', 'api', 'before'), edge('api', 'cycle-test', 'must_with'), edge('api', 'docs', 'before')] },
  { name: 'same-file-independent', units: [unit('first', 'src/utils.ts', 95, 'utils'), unit('second', 'src/utils.ts', 95, 'utils'), unit('first-test', 'test/first.test.ts', 15, 'utils', true), unit('second-test', 'test/second.test.ts', 15, 'utils', true)], edges: [edge('first', 'first-test', 'must_with'), edge('second', 'second-test', 'must_with'), edge('first', 'second', 'separate')] },
];
function grouped(units, key) {
  const buckets = new Map();
  for (const item of units) { const bucket = key(item); if (!buckets.has(bucket)) buckets.set(bucket, []); buckets.get(bucket).push(item.id); }
  return [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ids]) => ids);
}
function balanced(units) {
  const result = []; let current = [], lines = 0;
  for (const item of [...units].sort((a, b) => a.newPath < b.newPath ? -1 : a.newPath > b.newPath ? 1 : a.id < b.id ? -1 : 1)) {
    if (current.length && lines + item.addedLines > config.limits.targetChangedLines) { result.push(current); current = []; lines = 0; }
    current.push(item.id); lines += item.addedLines;
  }
  if (current.length) result.push(current); return result;
}
function measure(groups, scenario) {
  const groupOf = new Map(groups.flatMap((group, i) => group.map(id => [id, i]))), byId = new Map(scenario.units.map(unit => [unit.id, unit]));
  const hardCuts = scenario.edges.filter(edge => edge.kind === 'must_with' && groupOf.get(edge.from) !== groupOf.get(edge.to)).length;
  const orderViolations = scenario.edges.filter(edge => edge.kind === 'before' && groupOf.get(edge.from) > groupOf.get(edge.to)).length;
  const separatedTests = scenario.edges.filter(edge => byId.get(edge.from).isTest !== byId.get(edge.to).isTest && groupOf.get(edge.from) !== groupOf.get(edge.to) && ['must_with', 'affinity'].includes(edge.kind)).length;
  const complete = groups.flat().length === scenario.units.length && new Set(groups.flat()).size === scenario.units.length && scenario.units.every(unit => groupOf.has(unit.id));
  return { groups: groups.length, hardCuts, orderViolations, separatedTests, maxChangedLines: Math.max(0, ...groups.map(group => group.reduce((sum, id) => sum + byId.get(id).addedLines + byId.get(id).deletedLines, 0))), complete };
}
const rows = [];
for (const scenario of scenarios) {
  const started = performance.now(), plan = planCandidates(scenario.units, scenario.edges, config), elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const alternatives = { planner: plan.groups.map(group => group.unitIds), single: [scenario.units.map(unit => unit.id)], directory: grouped(scenario.units, unit => posix.dirname(unit.newPath)), package: grouped(scenario.units, unit => unit.packageId ?? '.'), balanced: balanced(scenario.units) };
  assert.deepEqual(planCandidates(scenario.units.toReversed(), scenario.edges.toReversed(), config), plan, 'planner determinism');
  for (const [strategy, groups] of Object.entries(alternatives)) {
    const metrics = measure(groups, scenario); rows.push({ scenario: scenario.name, strategy, ...metrics, ...(strategy === 'planner' ? { elapsedMs, stable: true } : {}) });
    if (strategy === 'planner') { assert.equal(metrics.hardCuts, 0); assert.equal(metrics.orderViolations, 0); assert.equal(metrics.complete, true); }
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ scope: 'curated synthetic graphs', rows, unavailable: { commitBaseline: 'Synthetic graphs contain no commit history.', compilingPrefixes: 'Not measured here; real Git fixtures are covered by npm test.', passingTests: 'Not measured here; no project commands run.', exactTreeReconstruction: 'Not measured here; covered by integration tests.' } }, null, 2));
else {
  console.log('Curated synthetic graphs — structural benchmark'); console.table(rows);
  console.log('Commit baseline: unavailable (no history). Compiling/test prefixes and exact Git trees: not measured here; see npm test integration fixtures. Timing is observational, scores and plans are deterministic.');
}

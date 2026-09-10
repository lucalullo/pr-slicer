import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, normalizeConfig, planDigest, validatePlan } from '../../dist/index.js';
import { calculateMetrics } from '../../dist/planner/scoring.js';

test('coverage counts only prefixes whose configured checks actually passed', async t => {
  const f = fixture(t, {}); f.write('a.js', 'export const a = 1;\n'); f.commit();
  for (const name of ['guard', 'semantic']) {
    const config = normalizeConfig({ checks: [{ name, command: process.execPath, args: ['-e', ''], timeoutMs: 5000 }] });
    const p = createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config });
    const skipped = await verifyPlan(p);
    assert.deepEqual(skipped.metrics.verificationCoverage, { passed: 0, total: 1 }); validatePlan(skipped);
    const passed = await verifyPlan(p, { runChecks: true });
    assert.deepEqual(passed.metrics.verificationCoverage, { passed: 1, total: 1 }); validatePlan(passed);
  }
});
test('repair invalidates alternatives and yields a deeply valid plan', async t => {
  const f = fixture(t, {}); for (const name of ['a','b','c']) f.write(`${name}.js`, `export const ${name} = 1;\n`); f.commit();
  const config = normalizeConfig({ limits: { targetChangedLines: 1, hardMaxChangedLines: 1000 }, checks: [{ name: 'coherent', command: process.execPath, args: ['-e', 'const f=require("node:fs");if(["a.js","b.js","c.js"].filter(x=>f.existsSync(x)).length!==3)process.exit(7)'], timeoutMs: 5000 }] });
  const p = createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config });
  p.groups = p.units.map((u, i) => ({ id: `explicit-${i}`, title: `Change ${i}`, unitIds: [u.id], dependsOn: [], files: [u.newPath], addedLines: u.addedLines, deletedLines: u.deletedLines, reasons: [] }));
  p.metrics = calculateMetrics(p.groups, p.units, p.edges, p.config); p.integrity.digest = planDigest(p);
  const result = await verifyPlan(p, { runChecks: true });
  assert.equal(result.verification.status, 'passed'); assert.equal(result.groups.length, 1);
  assert.deepEqual(result.candidates, []); validatePlan(result);
});

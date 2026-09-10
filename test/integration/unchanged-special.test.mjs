import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, tsconfig } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan, normalizeConfig, validatePlan } from '../../dist/index.js';
for (const kind of ['symlink', 'gitlink']) test(`unchanged ${kind} permits ordinary syntax without following its target`, async t => {
  const f = fixture(t, { 'a.ts': 'export const a=1;\n', 'tsconfig.json': tsconfig });
  f.git('checkout', 'main');
  if (kind === 'symlink') {
    try { fs.symlinkSync('/definitely/not/a/readable/target', path.join(f.root, 'opaque')); }
    catch (error) { if (['EPERM','EACCES','ENOSYS'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`); throw error; }
    f.commit('existing link');
  } else { f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},opaque`); f.git('commit', '-m', 'existing gitlink'); }
  f.git('checkout', 'feature'); f.git('merge', '--ff-only', 'main'); f.write('a.ts', 'export const a=2;\n'); f.git('add', 'a.ts'); f.git('commit', '-m', 'feature');
  const config = normalizeConfig({ checks: [{ name: 'never-with-incomplete-snapshot', command: process.execPath, args: ['-e', 'process.exit(99)'], timeoutMs: 1000 }] });
  const p = createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config });
  const result = await verifyPlan(p);
  assert.equal(result.verification.status, 'passed'); assert.equal(result.verification.level, 'syntax'); validatePlan(result);
  assert.ok(result.warnings.some(warning => warning.type === 'unchanged-special-entries'));
  const materialized = materializePlan(result, { prefix: `unchanged-${kind}`, dryRun: true });
  assert.equal(materialized.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
  const semantic = await verifyPlan(p, { semantic: true });
  assert.equal(semantic.verification.status, 'verification-unavailable');
  assert.equal(semantic.checks[semantic.groups[0].id][1].status, 'passed'); validatePlan(semantic);
  const project = await verifyPlan(p, { runChecks: true });
  assert.equal(project.verification.status, 'verification-unavailable'); assert.equal(project.verification.commandsExecuted, false); validatePlan(project);
});

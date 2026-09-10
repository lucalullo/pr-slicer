import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture, cli, tsconfig } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan, normalizeConfig, validatePlan, planDigest } from '../../dist/index.js';
const options = f => ({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({ limits: { targetChangedLines: 4, hardMaxChangedLines: 1000 } }) });
const cases = [
  ['new file', {}, f => f.write('a.ts', 'export const a = 1;\n')],
  ['deleted file', { 'old.ts': 'export const old = 1;\n' }, f => fs.unlinkSync(path.join(f.root, 'old.ts'))],
  ['rename with edit', { 'old.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' }, f => { fs.renameSync(path.join(f.root, 'old.ts'), path.join(f.root, 'new.ts')); f.write('new.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 4;\n'); }],
  ['binary content', { 'image.bin': Buffer.from([0, 1, 255]) }, f => f.write('image.bin', Buffer.from([0, 2, 254, 3]))],
  ['CRLF and missing final newline', { 'a.ts': 'export const a = 1;\r\nexport const b = 2;' }, f => f.write('a.ts', 'export const a = 3;\r\nexport const b = 4;')],
  ['Unicode and spaces', { 'caffè/hello world.ts': 'export const a = 1;\n' }, f => f.write('caffè/hello world.ts', 'export const a = 2;\n')],
  ['two packages', { 'packages/a/package.json': '{"name":"a"}', 'packages/b/package.json': '{"name":"b"}' }, f => { f.write('packages/a/src/a.ts', 'export const a = 1;\n'); f.write('packages/b/src/b.ts', 'export const b = 2;\n'); }],
  ['manifest and lockfile', { 'package.json': '{"name":"fixture","version":"1.0.0"}', 'package-lock.json': '{"lockfileVersion":3}' }, f => { f.write('package.json', '{"name":"fixture","version":"1.1.0"}'); f.write('package-lock.json', '{"lockfileVersion":3,"name":"fixture"}'); }],
  ['implementation and test', { 'add.ts': 'export const add = (x: number) => x;\n' }, f => { f.write('add.ts', 'export const add = (x: number) => x + 1;\n'); f.write('add.test.ts', 'import { add } from "./add.js";\nif (add(1) !== 2) throw Error("bad");\n'); }],
  ['separate declarations same file', { 'a.ts': 'export function first() { return 1; }\n\nexport function second() { return 2; }\n' }, f => f.write('a.ts', 'export function first() { return 3; }\n\nexport function second() { return 4; }\n')],
  ['symbol rename and consumer', { 'a.ts': 'export const before = 1;\n', 'b.ts': 'import { before } from "./a.js";\nexport const value = before;\n' }, f => { f.write('a.ts', 'export const after = 1;\n'); f.write('b.ts', 'import { after } from "./a.js";\nexport const value = after;\n'); }],
  ['empty diff', { 'a.ts': 'export const a = 1;\n' }, () => {}],
  ['delete consumer and API', { 'a.ts': 'export const old = 1;\nexport const stay = 2;\n', 'b.ts': 'import { old } from "./a.js";\nexport const use = old;\n' }, f => { f.write('a.ts', 'export const stay = 2;\n'); f.write('b.ts', 'export const use = 0;\n'); }]
];
for (const [name, base, mutate] of cases) test(`plan → verify → materialize: ${name}`, async t => {
  const f = fixture(t, base); mutate(f); f.commit();
  const original = { head: f.git('rev-parse', 'HEAD'), status: f.git('status', '--porcelain'), refs: f.git('show-ref') };
  const plan = createPlan(options(f));
  validatePlan(plan);
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
  assert.equal(new Set(plan.groups.flatMap(g => g.unitIds)).size, plan.units.length);
  assert.equal(f.git('show-ref'), original.refs); assert.equal(f.git('status', '--porcelain'), original.status);
  const verified = await verifyPlan(plan);
  assert.equal(verified.verification.status, 'passed', JSON.stringify(verified.checks));
  const preview = materializePlan(verified, { prefix: 'slice/demo', dryRun: true });
  assert.equal(f.git('show-ref'), original.refs);
  const result = materializePlan(verified, { prefix: 'slice/demo' });
  assert.deepEqual(result, preview);
  assert.equal(result.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
  if (result.branches.length) assert.equal(f.git('rev-parse', `${result.branches.at(-1).name}^{tree}`), f.git('rev-parse', 'feature^{tree}'));
  assert.equal(f.git('rev-parse', 'HEAD'), original.head); assert.equal(f.git('status', '--porcelain'), original.status);
});
test('deterministic plan, no source object/index changes, dirty plan allowed', t => {
  const f = fixture(t, { 'a.ts': 'export const a = 1;\n' }); f.write('a.ts', 'export const a = 2;\n'); f.commit();
  f.write('a.ts', 'uncommitted and invalid code'); f.write('untracked.txt', 'retain');
  const index = fs.readFileSync(path.join(f.root, '.git/index')); const objects = f.git('count-objects', '-v');
  const a = createPlan(options(f)), b = createPlan(options(f)); assert.deepEqual(a, b);
  assert.ok(index.equals(fs.readFileSync(path.join(f.root, '.git/index')))); assert.equal(f.git('count-objects', '-v'), objects);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.ts'), 'utf8'), 'uncommitted and invalid code');
});
test('semantic type error fails and remains unmaterializable', async t => {
  const f = fixture(t, { 'tsconfig.json': tsconfig, 'a.ts': 'export const a: number = 1;\n' }); f.write('a.ts', 'export const a: number = "wrong";\n'); f.commit();
  const p = await verifyPlan(createPlan(options(f)), { semantic: true }); assert.equal(p.verification.status, 'failed');
  assert.throws(() => materializePlan(p, { prefix: 'bad' }), /verification/i);
});
test('checks opt in, unavailable environment, and no secret inheritance', async t => {
  const f = fixture(t, { 'a.js': 'export const a=1;\n' }); f.write('a.js', 'export const a=2;\n'); f.commit();
  const config = normalizeConfig({ checks: [{ name: 'guard', command: process.execPath, args: ['-e', 'if(process.env.PR_SLICER_SECRET) process.exit(8)'], timeoutMs: 5000 }] });
  const p = createPlan({ ...options(f), config }); process.env.PR_SLICER_SECRET = 'sensitive';
  try {
    const skipped = await verifyPlan(p); assert.equal(skipped.verification.commandsExecuted, false); assert.equal(skipped.checks[p.groups[0].id].find(c => c.name === 'guard').status, 'skipped');
    const checked = await verifyPlan(p, { runChecks: true }); assert.equal(checked.verification.status, 'passed'); assert.equal(checked.verification.commandsExecuted, true);
  } finally { delete process.env.PR_SLICER_SECRET; }
  const semantic = await verifyPlan(p, { semantic: true }); assert.equal(semantic.verification.status, 'verification-unavailable');
});
test('reject tampered diff, duplicate units, dirty tree, moved refs and existing branches', async t => {
  const f = fixture(t, { 'a.ts': 'export const a=1;\n' }); f.write('a.ts', 'export const a=2;\n'); f.commit();
  const p = createPlan(options(f)); const tampered = structuredClone(p); tampered.files[0].newPath = '../outside'; tampered.integrity.digest = planDigest(tampered); assert.throws(() => validatePlan(tampered), /diff/);
  const dup = structuredClone(p); dup.groups[0].unitIds.push(dup.groups[0].unitIds[0]); dup.integrity.digest = planDigest(dup); assert.throws(() => validatePlan(dup), /duplicata/);
  const v = await verifyPlan(p); f.write('dirty', 'x'); assert.throws(() => materializePlan(v, { prefix: 'safe' }), /clean/); fs.unlinkSync(path.join(f.root, 'dirty'));
  f.git('branch', 'safe/01'); assert.throws(() => materializePlan(v, { prefix: 'safe' }), /exists/);
  f.write('a.ts', 'export const a=3;\n'); f.commit(); assert.throws(() => materializePlan(v, { prefix: 'safe2' }), /moved/);
});
test('CLI complete workflow and exit status', t => {
  const f = fixture(t, { 'a.ts': 'export const a=1;\n' }); f.write('a.ts', 'export const a=2;\n'); f.commit();
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const planFile = path.join(f.parent, 'plan.json'), verifiedFile = path.join(f.parent, 'verified.json');
  run('plan', '--repo', f.root, '--base', 'main', '--head', 'feature', '--fast', '--format', 'json', '--output', planFile);
  run('verify', planFile, '--output', verifiedFile);
  assert.equal(JSON.parse(run('materialize', verifiedFile, '--prefix', 'cli')).branches.length, 1);
  assert.match(run('doctor', '--repo', f.root), /OK Git/); assert.match(run('explain', planFile, '--group', 'slice-1'), /unitIds/);
  assert.equal(spawnSync(process.execPath, [cli, 'unknown'], { encoding: 'utf8' }).status, 1);
});
test('symlink/gitlink preserved, incomplete snapshot explicitly unavailable', async t => {
  if (process.platform === 'win32') return t.skip('POSIX symlink fixture');
  const f = fixture(t, { 'a.ts': 'export const a=1;\n' }); fs.symlinkSync('/etc/passwd', path.join(f.root, 'external')); f.commit();
  const p = createPlan(options(f)); assert.equal(p.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  const v = await verifyPlan(p); assert.equal(v.verification.status, 'verification-unavailable'); assert.throws(() => materializePlan(v, { prefix: 'link' }), /verification/);
});
test('executable mode and gitlink are atomic and exact', t => {
  const f = fixture(t, { 'script.sh': '#!/bin/sh\nexit 0\n' }); f.git('update-index', '--chmod=+x', 'script.sh'); f.git('commit', '-m', 'mode');
  let p = createPlan(options(f)); assert.equal(p.files[0].atomic, true); assert.equal(p.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},submodule`); f.git('commit', '-m', 'gitlink');
  p = createPlan(options(f)); assert.equal(p.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
});
test('intermediate project-check failure repairs a boundary deterministically', async t => {
  const f = fixture(t, {}); f.write('a.js', 'export const a=1;\n'); f.write('b.js', 'export const b=2;\n'); f.commit();
  const config = normalizeConfig({ limits: { targetChangedLines: 1, hardMaxChangedLines: 10 }, checks: [{ name: 'coherent', command: process.execPath, args: ['-e', 'if(require("node:fs").existsSync("a.js")!==require("node:fs").existsSync("b.js"))process.exit(7)'], timeoutMs: 5000 }] });
  const p = createPlan({ ...options(f), config });
  // Pin a deliberately unsafe candidate to test repair independently of its cost.
  p.groups = p.units.map((u, i) => ({ id: `explicit-${i}`, title: `Change ${i}`, unitIds: [u.id], dependsOn: [], files: [u.newPath], addedLines: u.addedLines, deletedLines: u.deletedLines, reasons: [] })); p.integrity.digest = planDigest(p);
  const bad = await verifyPlan(p, { runChecks: true, repair: false }); assert.equal(bad.verification.status, 'failed');
  const good = await verifyPlan(p, { runChecks: true }); assert.equal(good.verification.status, 'passed'); assert.equal(good.groups.length, 1); assert.ok(good.warnings.some(w => w.type === 'rejected-boundary'));
  const result = materializePlan(good, { prefix: 'repaired' }); assert.equal(result.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
});
test('annotated base tags and linked worktree are supported', async t => {
  const f = fixture(t, { 'a.js': 'export const a=1;\n' }); f.git('tag', '-a', 'v-base', 'main', '-m', 'base release'); f.write('a.js', 'export const a=2;\n'); f.commit();
  const linked = path.join(f.parent, 'linked'); f.git('worktree', 'add', '--detach', linked, 'feature');
  const p = createPlan({ ...options(f), repo: linked, base: 'v-base' }); const v = await verifyPlan(p); const r = materializePlan(v, { prefix: 'linked' });
  assert.equal(r.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
});
test('filters and hooks are not executed by plan/verify/materialize', async t => {
  const f = fixture(t, { 'a.js': 'export const a=1;\n', '.gitattributes': '*.js filter=probe\n' }); f.write('a.js', 'export const a=2;\n'); f.commit();
  f.git('config', 'filter.probe.clean', 'node -e "process.exit(99)"'); f.git('config', 'filter.probe.required', 'true');
  f.git('config', 'core.hooksPath', '/nonexistent-pr-slicer-hooks');
  const p = await verifyPlan(createPlan(options(f))); assert.equal(p.verification.status, 'passed');
  const result = materializePlan(p, { prefix: 'no-filter' }); assert.equal(result.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
});
test('POSIX newline filename survives exact reconstruction', t => {
  if (process.platform === 'win32') return t.skip('Windows filenames cannot contain newline');
  const f = fixture(t, { 'line\nname.ts': 'export const a=1;\n' }); f.write('line\nname.ts', 'export const a=2;\n'); f.commit();
  const p = createPlan(options(f)); assert.equal(p.files[0].newPath, 'line\nname.ts'); assert.equal(p.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
});
test('file to directory transition remains atomic and materializable', async t => {
  const f = fixture(t, { 'entry': 'old file\n' }); fs.unlinkSync(path.join(f.root, 'entry')); f.write('entry/a.js', 'export const a=1;\n'); f.commit();
  const p = createPlan(options(f)); assert.ok(p.edges.some(e => e.evidence.some(x => x.type === 'atomic-path-transition')));
  const v = await verifyPlan(p); assert.equal(v.verification.status, 'passed'); const r = materializePlan(v, { prefix: 'transition' }); assert.equal(r.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
});

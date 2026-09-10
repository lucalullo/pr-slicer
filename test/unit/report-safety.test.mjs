import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(process.env.SLICER_TEST_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));
const { terminalReport, markdownReport, formatPlan } = await import(pathToFileURL(path.join(root, 'dist/report/index.js')).href);
const fixture = () => JSON.parse(fs.readFileSync(path.join(root, 'test/golden/mixed-files.json'), 'utf8'));
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const payload = 'visible\x1b]8;;https://invalid.example\x07link\x1b]8;;\x07\x7f\x85\x9b31m\u202e\u2066hidden';

test('terminal reports neutralize C0, DEL, C1 and bidi without mutating plan data', () => {
  const plan = fixture();
  plan.groups[0].title = payload;
  const before = JSON.stringify(plan);
  assert.doesNotMatch(terminalReport(plan), controls);
  assert.equal(JSON.stringify(plan), before);
});

test('all terminal dynamic fields, not only titles and evidence, are sanitized', () => {
  for (const mutate of [
    p => { p.groups[0].id = payload; }, p => { p.groups[0].dependsOn = [payload]; },
    p => { p.status = payload; }, p => { p.verification.status = payload; },
    p => { p.verification.level = payload; }, p => { p.metrics.boundaryConfidence = payload; },
    p => { p.integrity.finalTreeOid = payload; }, p => { p.groups[0].addedLines = payload; },
    p => { p.groups[0].deletedLines = payload; }, p => { p.groups[0].reasons[0].message = payload; },
    p => { p.metrics.structuralCohesion = payload; }, p => { p.metrics.dependencyIntegrity = payload; },
    p => { p.warnings[0].message = payload; }
  ]) {
    const plan = fixture(); mutate(plan);
    assert.doesNotMatch(terminalReport(plan), controls);
  }
});

test('Markdown reports neutralize all controls in paths and dynamic cells', () => {
  for (const mutate of [
    p => { p.groups[0].files = [payload]; }, p => { p.groups[0].title = payload; },
    p => { p.checks[payload] = [{ name: payload, status: payload, message: payload }]; },
    p => { p.repository.mergeBaseOid = payload; }, p => { p.repository.headOid = payload; },
    p => { p.integrity.finalTreeOid = payload; }, p => { p.status = payload; },
    p => { p.analysisMode = payload; }, p => { p.groups[0].id = payload; },
    p => { p.groups[0].dependsOn = [payload]; }, p => { p.groups[0].addedLines = payload; },
    p => { p.groups[0].deletedLines = payload; }, p => { p.groups[0].reasons[0].message = payload; },
    p => { p.verification.status = payload; }, p => { p.verification.level = payload; },
    p => { p.metrics.reviewability = payload; }, p => { p.metrics.structuralCohesion = payload; },
    p => { p.metrics.dependencyIntegrity = payload; }, p => { p.metrics.boundaryConfidence = payload; },
    p => { p.candidates[0].id = payload; }, p => { p.candidates[0].cost = payload; },
    p => { p.warnings[0].message = payload; }
  ]) {
    const plan = fixture(); mutate(plan);
    assert.doesNotMatch(markdownReport(plan), controls);
  }
});

test('Markdown inline code cannot be escaped by repository and group IDs', () => {
  const plan = fixture();
  plan.groups[0].id = 'x` [click](https://invalid.example) `y';
  assert.ok(markdownReport(plan).includes('ID: ``x` [click](https://invalid.example) `y``'));
});

test('Markdown evidence cannot inject a heading or strikethrough', () => {
  const plan = fixture();
  plan.warnings = [{ message: '# heading ~~hidden~~' }];
  assert.ok(markdownReport(plan).includes('- \\# heading \\~\\~hidden\\~\\~'));
});

test('Markdown entities cannot reintroduce bidi controls after rendering', () => {
  const plan = fixture();
  plan.warnings = [{ message: '&#x202e;hidden' }];
  assert.ok(markdownReport(plan).includes('- &amp;#x202e;hidden') || markdownReport(plan).includes('- &amp;\\#x202e;hidden'));
});

test('JSON output preserves original Git paths and source bytes', () => {
  const plan = fixture(); plan.groups[0].files = [payload + '\nname.ts'];
  assert.deepEqual(JSON.parse(formatPlan(plan, 'json')), plan);
});

test('CLI sanitizes argument-parser failures without an uncontrolled stack', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/main.js'), '--bad-\x1b[2J\u202e'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^pr-slicer: /);
  assert.doesNotMatch(result.stderr, controls);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('CLI sanitizes ordinary unknown-command errors', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/main.js'), payload], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, controls);
});

test('doctor sanitizes repository and configuration failures', () => {
  const missing = path.join(os.tmpdir(), 'missing-pr-slicer-\u202e\u0085');
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/main.js'), 'doctor', '--repo', missing], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, controls);
});

test('materialize sanitizes the proposed branch prefix before displaying it', async t => {
  const { fixture: repositoryFixture } = await import(pathToFileURL(path.join(root, 'test/fixtures/repository.mjs')).href);
  const { createPlan } = await import(pathToFileURL(path.join(root, 'dist/core/create-plan.js')).href);
  const { normalizeConfig } = await import(pathToFileURL(path.join(root, 'dist/config/index.js')).href);
  const repository = repositoryFixture(t, { 'change.ts': 'export const value = 1;\n' });
  repository.write('change.ts', 'export const value = 2;\n'); repository.commit();
  const plan = createPlan({ repo: repository.root, base: 'main', head: 'feature', config: normalizeConfig(), mode: 'fast' });
  const planFile = path.join(repository.parent, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan));
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/main.js'), 'materialize', planFile, '--prefix', 'slice/' + payload, '--dry-run'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Branch previste:/);
  assert.doesNotMatch(result.stderr, controls);
  assert.equal(repository.git('for-each-ref', '--format=%(refname)', 'refs/heads/slice/'), '');
});

test('JSON plan output rejects the shared 100 MiB limit before a huge serialization allocation', () => {
  const reportUrl = pathToFileURL(path.join(root, 'dist/report/index.js')).href;
  const child = `import { formatPlan } from ${JSON.stringify(reportUrl)};
    const chunk = 'x'.repeat(1024 * 1024);
    const plan = { warnings: Array.from({ length: 110 }, () => ({ message: chunk })) };
    try { formatPlan(plan, 'json'); process.stderr.write('Oversized plan was serialized'); process.exitCode = 2; }
    catch (error) { if (error.code !== 'PLAN_TOO_LARGE') throw error; process.stdout.write('bounded before stringify'); }`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `Controlled plan-size rejection required; signal=${result.signal}; stderr=${result.stderr.slice(0, 1000)}`);
  assert.equal(result.stdout, 'bounded before stringify');
});

test('legal filenames with C1 and bidi controls keep raw paths but generate valid safe titles', async t => {
  const { fixture: repositoryFixture } = await import(pathToFileURL(path.join(root, 'test/fixtures/repository.mjs')).href);
  const { createPlan } = await import(pathToFileURL(path.join(root, 'dist/core/create-plan.js')).href);
  const { normalizeConfig } = await import(pathToFileURL(path.join(root, 'dist/config/index.js')).href);
  const { validatePlan } = await import(pathToFileURL(path.join(root, 'dist/core/plan.js')).href);
  const { verifyPlan } = await import(pathToFileURL(path.join(root, 'dist/verify/index.js')).href);
  const filename = 'control-\u0085-\u202e.ts';
  const repository = repositoryFixture(t, { [filename]: 'export const value = 1;\n' });
  repository.write(filename, 'export const value = 2;\n'); repository.commit();
  const plan = createPlan({ repo: repository.root, base: 'main', head: 'feature', config: normalizeConfig(), mode: 'fast' });
  for (const group of plan.groups) { assert.doesNotMatch(group.title, controls); assert.ok(group.title.length <= 160); }
  const restored = JSON.parse(formatPlan(plan, 'json'));
  assert.equal(restored.files[0].newPath, filename);
  assert.equal(restored.groups[0].files[0], filename);
  assert.equal(restored.units[0].newPath, filename);
  validatePlan(restored);
  const verified = await verifyPlan(restored);
  assert.equal(verified.verification.status, 'passed');
  assert.equal(verified.integrity.finalTreeOid, plan.repository.headTreeOid);
});

test('verified reports name the coverage denominator and every distinct check outcome', () => {
  const plan = fixture();
  plan.verification.status = 'verification-unavailable';
  plan.metrics.verificationCoverage = { passed: 0, total: plan.groups.length };
  plan.checks = { [plan.groups[0].id]: ['passed', 'failed', 'skipped', 'timeout', 'unavailable'].map(status => ({ name: status, status })) };
  for (const report of [terminalReport(plan), markdownReport(plan)]) {
    assert.match(report, /Prefissi con tutti i controlli richiesti superati: 0\/2/);
    assert.match(report, /Controlli di progetto: non configurati/);
    for (const status of ['passed', 'failed', 'skipped', 'timeout', 'unavailable']) assert.ok(report.includes(`${status} 1`));
    assert.doesNotMatch(report, /100%/);
  }
  plan.checks = { [plan.groups[0].id]: [{ name: 'reconstruction', status: 'passed' }, { name: 'syntax', status: 'passed' }, { name: 'semantic', status: 'skipped' }] };
  for (const report of [terminalReport(plan), markdownReport(plan)]) assert.match(report, /La semantica non richiesta non rientra nei controlli richiesti/);
});

test('ESC filename import evidence remains valid metadata while raw symbols and paths are preserved', async t => {
  if (process.platform === 'win32') return t.skip('Windows does not permit C0 characters in filenames.');
  const { fixture: repositoryFixture, tsconfig } = await import(pathToFileURL(path.join(root, 'test/fixtures/repository.mjs')).href);
  const { createPlan } = await import(pathToFileURL(path.join(root, 'dist/core/create-plan.js')).href);
  const { normalizeConfig } = await import(pathToFileURL(path.join(root, 'dist/config/index.js')).href);
  const { validatePlan } = await import(pathToFileURL(path.join(root, 'dist/core/plan.js')).href);
  const filename = 'module-\x1b[31m.ts';
  const moduleName = JSON.stringify('./' + filename.replace(/\.ts$/, '.js'));
  const repository = repositoryFixture(t, {
    [filename]: 'export function api(value: number) { return value; }\n',
    'consumer.ts': `import { api } from ${moduleName};\nexport const result = api(1);\n`,
    'tsconfig.json': tsconfig
  });
  repository.write(filename, 'export function api(value: string) { return value; }\n');
  repository.write('consumer.ts', `import { api } from ${moduleName};\nexport const result = api("yes");\n`);
  repository.commit();
  for (const mode of ['fast', 'deep']) {
    const plan = createPlan({ repo: repository.root, base: 'main', head: 'feature', config: normalizeConfig(), mode });
    const evidence = plan.edges.flatMap(edge => edge.evidence);
    assert.ok(evidence.some(item => item.symbol === `${filename}#api`), `${mode} must retain observed symbol evidence`);
    assert.ok(evidence.some(item => item.paths?.includes(filename)), `${mode} must retain exact raw evidence paths`);
    assert.ok(plan.units.some(unit => unit.symbolIds.includes(`${filename}#api`)), `${mode} must retain exact raw symbol IDs`);
    assert.doesNotThrow(() => validatePlan(plan));
    for (const item of evidence) assert.doesNotMatch(item.message, controls);
    for (const warning of plan.warnings) assert.doesNotMatch(warning.message, controls);
    assert.ok(plan.files.some(file => file.newPath === filename));
    assert.equal(plan.integrity.finalTreeOid, repository.git('rev-parse', 'feature^{tree}'));
  }
});

test('description finalization leaves paths, symbols, source hunks, config and logs untouched', async () => {
  const { sanitizePlanDescriptions } = await import(pathToFileURL(path.join(root, 'dist/core/sanitize.js')).href);
  const plan = fixture();
  plan.files[0].newPath = payload;
  plan.files[0].hunks[0].lines = ['+' + payload];
  plan.units[0].symbolIds = [payload];
  plan.groups[0].files = [payload]; plan.groups[0].title = payload;
  const evidence = { type: 'test', message: `before\n\t${payload}`, symbol: payload, paths: [payload], details: { message: payload, source: payload } };
  plan.edges = [{ evidence: [evidence] }];
  plan.groups[0].reasons = [evidence];
  plan.candidates[0].reasons = [evidence];
  plan.warnings = [evidence];
  plan.config.checks = [{ name: 'example', command: payload, args: [payload], timeoutMs: 1000 }];
  plan.checks = { example: [{ name: 'example', status: 'unavailable', message: `before\n\t${payload}`, log: payload }] };
  plan.verification.checks = plan.checks;
  const unchanged = JSON.stringify({ files: plan.files, units: plan.units, config: plan.config, details: evidence.details });
  sanitizePlanDescriptions(plan);
  assert.doesNotMatch(evidence.message, controls);
  assert.ok(evidence.message.startsWith('before\n\t'));
  assert.doesNotMatch(plan.groups[0].title, controls);
  assert.doesNotMatch(plan.checks.example[0].message, controls);
  assert.equal(plan.checks.example[0].log, payload);
  assert.equal(evidence.symbol, payload); assert.deepEqual(evidence.paths, [payload]);
  assert.deepEqual(plan.groups[0].files, [payload]);
  assert.equal(JSON.stringify({ files: plan.files, units: plan.units, config: plan.config, details: evidence.details }), unchanged);
  const finalized = JSON.stringify(plan); sanitizePlanDescriptions(plan);
  assert.equal(JSON.stringify(plan), finalized);
});

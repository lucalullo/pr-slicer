import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, normalizeConfig, validatePlan, verifyPlan, planDigest } from '../../dist/index.js';
import { assertPlanSize, serializePlan, readPlanJson, MAX_PLAN_BYTES } from '../../dist/core/plan-size.js';

function sample(t, config = {}) {
  const f = fixture(t, { 'a.ts': 'export function first() { return 1; }\n\nexport function second() { return 2; }\n', 'b.ts': 'export const b = 1;\n' });
  f.write('a.ts', 'export function first() { return 3; }\n\nexport function second() { return 4; }\n'); f.write('b.ts', 'export const b = 2;\n'); f.commit();
  return { f, plan: createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig(config) }) };
}
const copy = p => JSON.parse(JSON.stringify(p));
function invalid(p, mutate, pattern) {
  const changed = copy(p); mutate(changed); changed.integrity.digest = planDigest(changed);
  assert.throws(() => validatePlan(changed), error => error.code === 'INVALID_PLAN' && pattern.test(error.message), String(pattern));
}

test('plan validation recursively enforces the public schema and precise paths', async t => {
  const { plan } = sample(t);
  assert.doesNotThrow(() => validatePlan(plan)); assert.doesNotThrow(() => validatePlan(copy(plan)));
  const cases = [
    ['missing field', p => { delete p.metrics; }, /metrics:.*mancante/],
    ['nested missing field', p => { delete p.units[0].syntaxKind; }, /units\[0\]\.syntaxKind/],
    ['wrong type', p => { p.groups[0].title = 8; }, /groups\[0\]\.title/],
    ['unknown status', p => { p.status = 'bogus'; }, /status:.*enum/],
    ['unknown syntax enum', p => { p.units[0].syntaxKind = 'bogus'; }, /units\[0\]\.syntaxKind/],
    ['unknown property', p => { p.metrics.extra = 1; }, /metrics\.extra/],
    ['missing config field', p => { delete p.config.limits.maxGroups; }, /config\.limits\.maxGroups/],
    ['fractional count', p => { p.units[0].addedLines = 0.5; }, /units\[0\]\.addedLines/],
    ['unsafe integer', p => { p.units[0].addedLines = 2 ** 53; }, /units\[0\]\.addedLines/],
    ['negative count', p => { p.groups[0].deletedLines = -1; }, /groups\[0\]\.deletedLines/],
    ['nonfinite metric', p => { p.metrics.reviewability = NaN; }, /metrics\.reviewability/],
    ['infinite evidence detail', p => { p.warnings.push({ type: 'bad', message: 'bad', details: { value: Infinity } }); }, /warnings\[\d+\]\.details\.value/],
    ['metric range', p => { p.metrics.reviewability = 101; }, /metrics\.reviewability/],
    ['empty evidence message', p => { p.warnings.push({ type: 'bad' }); }, /warnings\[\d+\]\.message/],
    ['malformed nested evidence', p => { p.candidates[0].reasons = [{ type: 'bad', message: null }]; }, /candidates\[0\]\.reasons\[0\]\.message/],
    ['malformed OID', p => { p.repository.baseOid = 'not-an-oid'; }, /repository\.baseOid/],
    ['wrong OID format', p => { p.repository.objectFormat = 'sha256'; }, /repository\.baseOid/],
    ['malformed Git mode', p => { p.files[0].oldMode = '777777'; }, /files\[0\]\.oldMode/],
    ['inconsistent verification digest', p => { p.verification.digest = 'a'.repeat(64); }, /verification\.digest/],
    ['malformed verification tree', p => { p.verification.trees = ['invalid']; }, /verification\.trees\[0\]/],
    ['title ANSI', p => { p.groups[0].title = '\u001b[2Jconcealed'; }, /groups\[0\]\.title/],
    ['title trailing LF', p => { p.groups[0].title += '\n'; }, /groups\[0\]\.title/],
    ['ID trailing LF', p => { p.groups[0].id += '\n'; }, /groups\[0\]\.id/],
    ['title blank', p => { p.groups[0].title = '   '; }, /groups\[0\]\.title/],
    ['non-enumerable required field', p => { Object.defineProperty(p.groups[0], 'title', { value: 123, enumerable: false }); }, /groups\[0\].*title.*non enumerabile/],
    ['evidence terminal hyperlink', p => { p.warnings.push({ type: 'bad', message: '\u001b]8;;https://example.invalid\u0007' }); }, /warnings\[\d+\]\.message/],
    ['check name ANSI', p => { p.config.checks = [{ name: '\u001b[2J', command: 'node', args: [], timeoutMs: 10 }]; }, /config\.checks\[0\]\.name/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, () => invalid(plan, mutate, pattern));
});

test('plan validation recomputes Git facts, membership, statistics, candidates and metrics', async t => {
  const { plan } = sample(t);
  const cases = [
    ['duplicate file', p => { p.files.push(p.files[0]); }, /files\[\d+\]\.id:.*duplicato/],
    ['duplicate unit', p => { p.units.push(p.units[0]); }, /units\[\d+\]\.id:.*duplicato/],
    ['duplicate hunk', p => { p.files[0].hunks.push(p.files[0].hunks[0]); }, /files\[0\]\.hunks\[\d+\]\.id/],
    ['missing hunk', p => { p.units = p.units.filter(unit => !unit.hunkIds.includes(p.files[0].hunks[0].id)); }, /files\[0\].*(perso|perdo)/],
    ['unknown file', p => { p.units[0].fileId = 'unknown'; }, /units\[0\]\.fileId/],
    ['unknown hunk', p => { p.units[0].hunkIds[0] = 'unknown'; }, /units\[0\]\.hunkIds\[0\]/],
    ['forged unit lines', p => { p.units[0].addedLines += 100; }, /units\[0\]\.addedLines/],
    ['forged unit test flag', p => { p.units[0].isTest = !p.units[0].isTest; }, /units\[0\]\.isTest/],
    ['forged unit area', p => { p.units[0].area = 'unknown'; }, /units\[0\]\.area/],
    ['duplicate group', p => { p.groups.push(p.groups[0]); }, /groups\[\d+\]\.id/],
    ['duplicate group membership', p => { p.groups[0].unitIds.push(p.groups[0].unitIds[0]); }, /groups\[0\]\.unitIds\[\d+\].*duplicata/],
    ['unknown group unit', p => { p.groups[0].unitIds[0] = 'unknown'; }, /groups\[0\]\.unitIds\[0\]/],
    ['cyclic group dependency', p => { p.groups[0].dependsOn = [p.groups[0].id]; }, /groups\[0\]\.dependsOn\[0\]/],
    ['forged group lines', p => { p.groups[0].addedLines += 100; }, /groups\[0\]\.addedLines/],
    ['forged group files', p => { p.groups[0].files[0] = 'bogus'; }, /groups\[0\]\.files\[0\]/],
    ['forged metric', p => { p.metrics.reviewability = 1; }, /metrics\.reviewability/],
    ['duplicate candidate', p => { p.candidates.push(p.candidates[0]); }, /candidates\[\d+\]\.id/],
    ['candidate unknown unit', p => { p.candidates[0].groups[0].unitIds[0] = 'unknown'; }, /candidates\[0\]\.groups\[0\]\.unitIds\[0\]/],
    ['candidate forged cost', p => { p.candidates[0].cost += 1; }, /candidates\[0\]\.cost/],
    ['candidate stale ID', p => { p.candidates[0].id = 'candidate_obsolete'; }, /candidates\[0\]\.id/],
    ['candidate stale after repair', p => { p.warnings.push({ type: 'rejected-boundary', message: 'Boundary failed.' }); }, /candidates:.*obsolete/],
    ['unknown edge endpoint', p => { p.edges.push({ id: 'test', from: p.units[0].id, to: 'unknown', kind: 'before', weight: 50, evidence: [{ type: 'test', message: 'test' }] }); }, /edges\[\d+\]\.to/],
    ['invalid edge weight', p => { p.edges.push({ id: 'test', from: p.units[0].id, to: p.units[1].id, kind: 'before', weight: -1, evidence: [{ type: 'test', message: 'test' }] }); }, /edges\[\d+\]\.weight/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, () => invalid(plan, mutate, pattern));
  const digest = copy(plan); digest.integrity.digest = 'a'.repeat(64); assert.throws(() => validatePlan(digest), /integrity\.digest/);
  const descriptive = copy(plan); descriptive.groups[0].title = 'A descriptive edit'; descriptive.groups[0].reasons.push({ type: 'note', message: 'A multiline\nexplanation.' });
  assert.doesNotThrow(() => validatePlan(descriptive));
});

test('verification records and derived summary are internally consistent', async t => {
  const { plan } = sample(t), verified = await verifyPlan(plan), group = verified.groups[0].id;
  assert.doesNotThrow(() => validatePlan(verified));
  const cases = [
    ['unknown check group', p => { p.checks.unknown = []; p.verification.checks = p.checks; }, /checks\["unknown"\]/],
    ['missing check group', p => { delete p.checks[group]; p.verification.checks = p.checks; }, /checks\[.*mancanti/],
    ['different duplicated checks', p => { p.verification.checks[group][0].message = 'altered'; }, /verification\.checks/],
    ['inconsistent exit code', p => { p.checks[group][0].exitCode = 7; p.verification.checks = p.checks; }, /checks\[.*\[0\]\.exitCode/],
    ['unrecognized result enum', p => { p.checks[group][0].status = 'bogus'; }, /checks\[.*\[0\]\.status/],
    ['verification status mismatch', p => { p.verification.status = 'failed'; }, /verification\.status/],
    ['verification level mismatch', p => { p.verification.level = 'project'; }, /verification\.level/],
    ['commands flag mismatch', p => { p.verification.commandsExecuted = true; }, /verification\.commandsExecuted/],
    ['coverage mismatch', p => { p.metrics.verificationCoverage.passed = 0; }, /metrics\.verificationCoverage\.passed/],
    ['prefix tree count', p => { p.verification.trees.push(p.repository.headTreeOid); }, /verification\.trees\.length/],
    ['prefix final tree', p => { p.verification.trees[p.verification.trees.length - 1] = p.repository.baseTreeOid; }, /verification\.trees\[/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, () => invalid(verified, mutate, pattern));
});

test('configured checks retain identity even when named like optional built-ins', async t => {
  const { plan } = sample(t, { checks: [{ name: 'semantic', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }] });
  const skipped = await verifyPlan(plan);
  assert.equal(skipped.metrics.verificationCoverage.passed, 0); assert.doesNotThrow(() => validatePlan(skipped));
  const passed = await verifyPlan(plan, { runChecks: true });
  assert.equal(passed.metrics.verificationCoverage.passed, passed.groups.length); assert.doesNotThrow(() => validatePlan(passed));
});

test('verified prefix OIDs are recomputed in isolated storage, not trusted because the final tree matches', async t => {
  const { f, plan } = sample(t, { limits: { targetChangedLines: 1, hardMaxChangedLines: 100 } });
  const verified = await verifyPlan(plan); assert.ok(verified.groups.length > 1);
  const objects = f.git('count-objects', '-v'), refs = f.git('show-ref');
  assert.doesNotThrow(() => validatePlan(verified));
  invalid(verified, p => { p.verification.trees[0] = p.repository.headTreeOid; }, /verification\.trees\[0\].*ricostruzione Git/);
  assert.equal(f.git('count-objects', '-v'), objects); assert.equal(f.git('show-ref'), refs);
});

test('historically valid configured check names stay readable after verification', async t => {
  const checks = [' ', 'x'.repeat(1001)].map(name => ({ name, command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }));
  const { plan } = sample(t, { checks }); assert.doesNotThrow(() => validatePlan(plan));
  const verified = await verifyPlan(plan, { runChecks: true }); assert.doesNotThrow(() => validatePlan(verified));
});

test('legal Git references preserve C1 characters rather than using display-title restrictions', async t => {
  const { f } = sample(t), base = 'base-\u009b', head = 'head-\u009b';
  f.git('branch', base, 'main'); f.git('branch', head, 'feature');
  const plan = createPlan({ repo: f.root, base, head, mode: 'fast' });
  assert.equal(plan.repository.baseRef, base); assert.equal(plan.repository.headRef, head); assert.doesNotThrow(() => validatePlan(plan));
  const verified = await verifyPlan(plan); assert.equal(verified.verification.status, 'passed'); assert.doesNotThrow(() => validatePlan(verified));
});

test('plan size bound is exact, shared, configurable for tests and checked before full serialization', t => {
  assert.equal(MAX_PLAN_BYTES, 100 * 1024 * 1024);
  const f = fixture(t), values = [{}, [], { text: 'caffè\n😀\t\u0000\\\"\ud800\udc00\ud800a\udc00', a: [1, null, true, false, [], {}], missing: undefined }, { nested: { a: [1, { b: 'c' }] } }];
  for (const [index, value] of values.entries()) {
    const json = JSON.stringify(value, null, 2) + '\n', bytes = Buffer.byteLength(json);
    assert.equal(serializePlan(value, bytes), json); assert.doesNotThrow(() => assertPlanSize(value, bytes));
    assert.throws(() => serializePlan(value, bytes - 1), error => error.code === 'PLAN_TOO_LARGE');
    const file = path.join(f.parent, `${index}.json`); fs.writeFileSync(file, json);
    assert.deepEqual(readPlanJson(file, bytes), JSON.parse(json)); assert.throws(() => readPlanJson(file, bytes - 1), error => error.code === 'PLAN_TOO_LARGE');
  }
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => assertPlanSize(cyclic), /ciclico/);
  let nested = {}; for (let i = 0; i < 70; i++) nested = { child: nested }; assert.throws(() => assertPlanSize(nested), /profondità/);
  assert.throws(() => assertPlanSize({ nonfinite: Infinity }), /numero finito/);
  assert.throws(() => assertPlanSize({ fn() {} }), /valore JSON/);
  assert.throws(() => assertPlanSize({ get value() { throw Error('must not run'); } }), /accessor/);
  assert.throws(() => assertPlanSize({ escaped: '\u0000'.repeat(32) }, 64), error => error.code === 'PLAN_TOO_LARGE');
  assert.throws(() => assertPlanSize(new Array(1)), /elemento JSON mancante/);
  assert.throws(() => assertPlanSize(Object.assign([], { extra: 1 })), /proprietà non indicizzata/);
  let invoked = 0;
  const serializer = Object.defineProperty({}, 'toJSON', { value() { invoked++; return 'x'.repeat(1024); } });
  assert.throws(() => serializePlan(serializer, 64), /toJSON/); assert.equal(invoked, 0);
  const accessor = []; Object.defineProperty(accessor, '0', { get() { invoked++; return 1; }, enumerable: false });
  assert.throws(() => assertPlanSize(accessor), /accessor/); assert.equal(invoked, 0);
  const inherited = Object.setPrototypeOf([], { toJSON() { invoked++; return 'x'.repeat(1024); } });
  assert.throws(() => serializePlan(inherited, 64), /oggetto JSON semplice/); assert.equal(invoked, 0);
  const repeated = { value: 1 }; assert.doesNotThrow(() => assertPlanSize([repeated, repeated]));
});

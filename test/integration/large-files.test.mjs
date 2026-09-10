import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan } from '../../dist/index.js';
import { createSandbox, exportSnapshot, resolveRepository } from '../../dist/git/index.js';
import { MAX_BLOB_BYTES } from '../../dist/git/objects.js';
import { diagnoseSnapshot } from '../../dist/languages/index.js';

function inspectContentRequests(t) {
  const calls = [], original = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    const index = args?.indexOf('cat-file') ?? -1;
    if (command === 'git' && index !== -1) calls.push({ args: args.slice(index + 1), input: options?.input?.toString() ?? '', streamed: typeof options?.stdio?.[1] === 'number' });
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}
const planFor = f => createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast' });
const body = size => Buffer.alloc(size, 97);

for (const [label, size] of [['below', MAX_BLOB_BYTES - 1], ['at', MAX_BLOB_BYTES], ['above', MAX_BLOB_BYTES + 1]]) test(`text blob ${label} limit preserves exact tree and threshold behavior`, t => {
  const before = body(size), after = Buffer.from(before); after[after.length - 1] = 98;
  const f = fixture(t, { 'large.txt': before }); f.write('large.txt', after); f.commit();
  const calls = inspectContentRequests(t), plan = planFor(f), file = plan.files[0];
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(file.atomic, size > MAX_BLOB_BYTES);
  assert.equal(plan.warnings.some(warning => warning.type === 'oversized-blob'), size > MAX_BLOB_BYTES);
  if (size > MAX_BLOB_BYTES) {
    assert.equal(file.hunks.length, 1); assert.deepEqual(file.hunks[0].lines, []);
    assert.ok(calls.filter(call => call.args[0] === '--batch').every(call => !call.input.includes(file.oldOid) && !call.input.includes(file.newOid)));
    assert.ok(!calls.some(call => call.args[0] === 'blob'));
    assert.ok(plan.warnings.some(warning => warning.details?.maxBytes === MAX_BLOB_BYTES && warning.details.sizeBytes === size));
  }
});

test('large binary is atomic and materializes exact head without buffered content reads', async t => {
  const before = body(MAX_BLOB_BYTES + 1); before[0] = 0;
  const after = Buffer.from(before); after[1] = 3;
  const f = fixture(t, { 'large.bin': before }); f.write('large.bin', after); f.commit();
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { assert.notEqual(file, path.join(f.root, 'large.bin'), 'Clean-worktree verification must hash large files incrementally'); return originalRead(file, ...args); });
  const calls = inspectContentRequests(t), plan = planFor(f), file = plan.files[0];
  assert.equal(file.atomic, true); assert.equal(file.changeKind, 'binary'); assert.equal(file.hunks[0].binary, true);
  const verified = await verifyPlan(plan); assert.equal(verified.verification.status, 'passed');
  const result = materializePlan(verified, { prefix: 'large' }); assert.equal(result.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  assert.ok(calls.filter(call => call.args[0] === '--batch').every(call => !call.input.includes(file.oldOid) && !call.input.includes(file.newOid)));
  f.git('fsck', '--full', '--strict');
});

test('large rename remains atomic without loading its contents', t => {
  const f = fixture(t, { 'before.txt': body(MAX_BLOB_BYTES + 1) }); fs.renameSync(path.join(f.root, 'before.txt'), path.join(f.root, 'after.txt')); f.commit();
  const calls = inspectContentRequests(t), plan = planFor(f), file = plan.files[0];
  assert.equal(file.changeKind, 'rename'); assert.equal(file.atomic, true); assert.equal(file.oldOid, file.newOid);
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  assert.ok(calls.filter(call => call.args[0] === '--batch').every(call => !call.input.includes(file.newOid)));
});

test('analysis omits oversized compiler input explicitly, full snapshot streams exact bytes', t => {
  const source = Buffer.concat([Buffer.from('/*'), body(MAX_BLOB_BYTES), Buffer.from('*/\n')]);
  const f = fixture(t, { 'large.ts': source, 'small.ts': 'export const a = 1;\n' }); f.write('small.ts', 'export const a = 2;\n'); f.commit();
  const repository = resolveRepository(f.root, 'main', 'feature'), sandbox = createSandbox(repository); t.after(() => sandbox.cleanup());
  const calls = inspectContentRequests(t), warnings = [], analysis = path.join(sandbox.root, 'analysis'), full = path.join(sandbox.root, 'full');
  exportSnapshot(repository, repository.headOid, analysis, sandbox, { mode: 'analysis', warnings });
  assert.equal(fs.existsSync(path.join(analysis, 'large.ts')), false);
  assert.ok(warnings.some(warning => warning.type === 'oversized-blob' && warning.paths.includes('large.ts')));
  exportSnapshot(repository, repository.headOid, full, sandbox);
  assert.equal(fs.statSync(path.join(full, 'large.ts')).size, source.length);
  assert.ok(fs.readFileSync(path.join(full, 'large.ts')).equals(source));
  const oid = f.git('rev-parse', 'HEAD:large.ts');
  assert.ok(calls.some(call => call.args[0] === 'blob' && call.args[1] === oid && call.streamed));
  assert.ok(calls.filter(call => call.args[0] === '--batch').every(call => !call.input.includes(oid)));
});

test('oversized TypeScript leaves reconstruction exact but verification unavailable', async t => {
  const f = fixture(t, { 'large.ts': Buffer.concat([Buffer.from('/*'), body(MAX_BLOB_BYTES), Buffer.from('*/\n')]), 'a.ts': 'export const a = 1;\n' });
  f.write('a.ts', 'export const a = 2;\n'); f.commit();
  const plan = planFor(f), verified = await verifyPlan(plan);
  assert.equal(verified.integrity.finalTreeOid, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(verified.verification.status, 'verification-unavailable');
  assert.ok(Object.values(verified.checks).flat().some(check => check.name === 'snapshot' && check.status === 'unavailable'));
  assert.throws(() => materializePlan(verified, { prefix: 'oversized-source' }), /verification/);
});

test('binary and malformed UTF-8 compiler inputs are unavailable, never decoded as source', t => {
  const f = fixture(t, { 'binary.ts': Buffer.from([0, 1, 2]), 'invalid.ts': Buffer.from([255, 254]) });
  const diagnostics = diagnoseSnapshot(f.root, false);
  assert.equal(diagnostics.syntax.status, 'unavailable');
  assert.ok(diagnostics.warnings.some(warning => warning.message.includes('binary compiler input')));
  assert.ok(diagnostics.warnings.some(warning => warning.message.includes('not valid UTF-8')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import zlib from 'node:zlib';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan, normalizeConfig } from '../../dist/index.js';
import { persistObjects } from '../../dist/materialize/objects.js';

function objectFixture(t, objectFormat = 'sha1') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-objects-')), root = path.join(parent, 'repo'), source = path.join(parent, 'source');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true })); fs.mkdirSync(root); fs.mkdirSync(source);
  const git = (...args) => childProcess.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init', '--bare', `--object-format=${objectFormat}`);
  const repository = { root, commonDir: root, objectFormat }, objects = path.join(root, 'objects');
  const put = (content, type = 'blob', expected) => {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content), raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const oid = expected ?? createHash(objectFormat).update(raw).digest('hex'), relative = path.join(oid.slice(0, 2), oid.slice(2));
    fs.mkdirSync(path.join(source, oid.slice(0, 2)), { recursive: true }); fs.writeFileSync(path.join(source, relative), deflateSync(raw));
    return { oid, body, source: path.join(source, relative), target: path.join(objects, relative) };
  };
  const assertClean = () => { assert.deepEqual(fs.readdirSync(objects).filter(name => name.startsWith('tmp_pr_slicer_')), []); assert.doesNotThrow(() => git('fsck', '--full', '--strict')); };
  return { parent, root, source, repository, objects, put, git, assertClean };
}

function withGitMock(t, intercept, run) {
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => intercept(command, args, options, () => original(command, args, options)));
  syncBuiltinESMExports();
  try { return run(); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}

for (const format of ['sha1', 'sha256']) {
  test(`atomic object transfer ${format}: new binary object and existing object are exact`, t => {
    const f = objectFixture(t, format), object = f.put(Buffer.from([0, 255, 10, 13, 128, 42]));
    persistObjects(f.repository, f.source); assert.equal(f.git('cat-file', '-t', object.oid), 'blob');
    const first = fs.readFileSync(object.target), stat = fs.statSync(object.target); persistObjects(f.repository, f.source);
    assert.deepEqual(fs.readFileSync(object.target), first); assert.equal(fs.statSync(object.target).ino, stat.ino); assert.equal(fs.statSync(object.target).mtimeMs, stat.mtimeMs); f.assertClean();
  });

  test(`atomic object transfer ${format}: wrong source OID is rejected before publication`, t => {
    const f = objectFixture(t, format), object = f.put('wrong expected ID', 'blob', 'f'.repeat(format === 'sha1' ? 40 : 64));
    assert.throws(() => persistObjects(f.repository, f.source), /expected object ID/); assert.equal(fs.existsSync(object.target), false); f.assertClean();
  });

  test(`atomic object transfer ${format}: concurrent existing object is never overwritten`, t => {
    const f = objectFixture(t, format), object = f.put('concurrent writer'), original = fs.linkSync;
    const mocked = t.mock.method(fs, 'linkSync', (source, target) => { original(source, target); const error = new Error('concurrent object'); error.code = 'EEXIST'; throw error; });
    try { persistObjects(f.repository, f.source); } finally { mocked.mock.restore(); }
    assert.equal(f.git('cat-file', 'blob', object.oid), 'concurrent writer'); f.assertClean();
  });

  test(`atomic object transfer ${format}: a killed Git writer cannot expose its temporary bytes`, t => {
    const f = objectFixture(t, format), object = f.put('interrupted');
    withGitMock(t, (_command, args, options) => {
      assert.ok(args.includes('hash-object')); assert.ok(args.includes('core.fsync=loose-object')); assert.ok(args.includes('core.fsyncMethod=fsync')); const stage = options.env.GIT_OBJECT_DIRECTORY;
      fs.mkdirSync(path.join(stage, 'aa')); fs.writeFileSync(path.join(stage, 'aa', 'tmp_obj_partial'), 'partial');
      return { status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.from('injected interruption') };
    }, () => assert.throws(() => persistObjects(f.repository, f.source), /injected interruption/));
    assert.equal(fs.existsSync(object.target), false); f.assertClean();
  });

  test(`atomic object transfer ${format}: wrong Git response is rejected and staging is removed`, t => {
    const f = objectFixture(t, format), object = f.put('protocol check');
    withGitMock(t, (_command, _args, _options, run) => ({ ...run(), stdout: Buffer.from(`${'f'.repeat(object.oid.length)}\n`) }), () => assert.throws(() => persistObjects(f.repository, f.source), /unexpected object ID/));
    assert.equal(fs.existsSync(object.target), false); f.assertClean();
  });
}

test('atomic object transfer: read failure after private staging creation cleans it', t => {
  const f = objectFixture(t), object = f.put('read failure'), original = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === object.source) throw new Error('injected source read failure'); return original(file, ...args); });
  try { assert.throws(() => persistObjects(f.repository, f.source), /injected source read failure/); } finally { mocked.mock.restore(); }
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: failure before atomic publication cleans complete staged objects', t => {
  const f = objectFixture(t), object = f.put('link failure');
  const mocked = t.mock.method(fs, 'linkSync', () => { const error = new Error('injected publication failure'); error.code = 'EIO'; throw error; });
  try { assert.throws(() => persistObjects(f.repository, f.source), /injected publication failure/); } finally { mocked.mock.restore(); }
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: corrupted staged output is detected before linking', t => {
  const f = objectFixture(t), object = f.put('staged integrity');
  withGitMock(t, (_command, _args, options, run) => {
    const result = run(), target = path.join(options.env.GIT_OBJECT_DIRECTORY, object.oid.slice(0, 2), object.oid.slice(2));
    fs.chmodSync(target, 0o600); fs.writeFileSync(target, deflateSync(Buffer.from('blob 5\0other'))); return result;
  }, () => assert.throws(() => persistObjects(f.repository, f.source), /expected object ID/));
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: trailing compressed bytes in staging are rejected before publication', t => {
  const f = objectFixture(t), object = f.put('trailing staged integrity');
  withGitMock(t, (_command, _args, options, run) => {
    const result = run(), target = path.join(options.env.GIT_OBJECT_DIRECTORY, object.oid.slice(0, 2), object.oid.slice(2));
    fs.chmodSync(target, 0o600); fs.appendFileSync(target, 'garbage'); return result;
  }, () => assert.throws(() => persistObjects(f.repository, f.source), /trailing data/));
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: a corrupt existing object is refused without overwriting it', t => {
  const f = objectFixture(t), object = f.put('existing integrity'); persistObjects(f.repository, f.source);
  fs.chmodSync(object.target, 0o600); fs.appendFileSync(object.target, 'garbage'); const before = fs.readFileSync(object.target);
  assert.throws(() => persistObjects(f.repository, f.source), /trailing data/); assert.deepEqual(fs.readFileSync(object.target), before);
  assert.deepEqual(fs.readdirSync(f.objects).filter(name => name.startsWith('tmp_pr_slicer_')), []);
});

test('atomic object transfer: oversized compressed objects are rejected before reading bytes', t => {
  const f = objectFixture(t), object = f.put('bounded compressed input'), original = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => file === object.source ? { isFile: () => true, size: 256 * 1024 * 1024 + 1 } : original(file, ...args));
  try { assert.throws(() => persistObjects(f.repository, f.source), error => error.code === 'OBJECT_TOO_LARGE'); } finally { mocked.mock.restore(); }
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: bounded inflation fails safely on a decompression bomb', t => {
  const f = objectFixture(t), object = f.put('bounded expanded output');
  const mocked = t.mock.method(zlib, 'inflateSync', (_bytes, options) => { assert.equal(options.maxOutputLength, 256 * 1024 * 1024); const error = new Error('bounded output exceeded'); error.code = 'ERR_BUFFER_TOO_LARGE'; throw error; });
  syncBuiltinESMExports();
  try { assert.throws(() => persistObjects(f.repository, f.source), error => error.code === 'OBJECT_TOO_LARGE'); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(object.target), false); f.assertClean();
});

test('atomic object transfer: failed publication after a complete object leaves only valid objects', t => {
  const f = objectFixture(t), a = f.put('first content'), b = f.put('second content'), original = fs.linkSync; let count = 0;
  const mocked = t.mock.method(fs, 'linkSync', (source, target) => { if (++count === 2) throw new Error('second link interrupted'); return original(source, target); });
  try { assert.throws(() => persistObjects(f.repository, f.source), /second link interrupted/); } finally { mocked.mock.restore(); }
  assert.equal(Number(fs.existsSync(a.target)) + Number(fs.existsSync(b.target)), 1); f.assertClean();
});

test('interrupted object publication leaves refs and the Git database valid', async t => {
  const f = fixture(t, { 'a.js': 'export const a = 1;\n' }); f.write('a.js', 'export const a = 2;\n'); f.commit();
  const verified = await verifyPlan(createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({}) }));
  const objects = path.join(f.root, '.git', 'objects'), refs = f.git('show-ref'), originalSpawn = childProcess.spawnSync;
  // `persistObjects` creates its private stage as <git-objects>/tmp_pr_slicer_*.
  // Checking the stage basename avoids realpath/junction spelling differences on Windows,
  // while still distinguishing it from createSandbox's .../pr-slicer-*/objects directory.
  const isPrivateStage = stage => typeof stage === 'string' && path.basename(path.normalize(stage)).startsWith('tmp_pr_slicer_');
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    const stage = options?.env?.GIT_OBJECT_DIRECTORY;
    if (command === 'git' && args.includes('hash-object') && isPrivateStage(stage)) {
      fs.mkdirSync(path.join(stage, 'aa'), { recursive: true }); fs.writeFileSync(path.join(stage, 'aa', 'tmp_obj_interrupted'), 'partial');
      return { status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.from('simulated write interruption') };
    }
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => materializePlan(verified, { prefix: 'interrupted' }), /simulated write interruption/); }
  finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(f.git('show-ref'), refs);
  assert.doesNotThrow(() => f.git('fsck', '--full', '--strict'), 'interrupted writes must not publish truncated objects');
  assert.deepEqual(fs.readdirSync(objects).filter(name => name.startsWith('tmp_pr_slicer_')), []);
});

test('SHA-256 complete materialization matches preview and head and passes strict fsck', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-sha256-')), root = path.join(parent, 'repo'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost', GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' };
  const git = (...args) => childProcess.execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main', '--object-format=sha256'); fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n'); git('add', '-A'); git('commit', '-m', 'base');
  git('checkout', '-b', 'feature'); fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 2;\n'); fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 255, 128])); git('add', '-A'); git('commit', '-m', 'head');
  const verified = await verifyPlan(createPlan({ repo: root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({}) }));
  const preview = materializePlan(verified, { prefix: 'sha256', dryRun: true }), result = materializePlan(verified, { prefix: 'sha256' });
  assert.deepEqual(result, preview); assert.equal(result.finalTreeOid, git('rev-parse', 'feature^{tree}')); assert.ok(result.branches.every(branch => branch.oid.length === 64));
  assert.doesNotThrow(() => git('fsck', '--full', '--strict')); assert.deepEqual(fs.readdirSync(path.join(root, '.git', 'objects')).filter(name => name.startsWith('tmp_pr_slicer_')), []);
});

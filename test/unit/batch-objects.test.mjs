import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures/repository.mjs';
import { git } from '../../dist/git/runner.js';
import { GitObjectReader, MAX_BATCH_BYTES } from '../../dist/git/objects.js';
import { readChanges, resolveRepository } from '../../dist/git/index.js';

test('batch reads text, binary and empty objects in order with one content process', t => {
  const f = fixture(t, { 'text': 'caffè\r\nlast', 'binary': Buffer.from([0, 10, 255, 1]), 'empty': '' });
  const names = ['text', 'binary', 'empty'], oids = names.map(name => f.git('rev-parse', `HEAD:${name}`)), calls = [];
  const reader = new GitObjectReader(f.root, {}, (repo, args, options) => { calls.push(args); return git(repo, args, options); });
  const result = [];
  reader.readMany([...oids, oids[0]], (oid, bytes) => result.push([oid, Buffer.from(bytes)]));
  assert.deepEqual(result.map(([oid]) => oid), oids);
  assert.deepEqual(result.map(([, bytes]) => bytes), [Buffer.from('caffè\r\nlast'), Buffer.from([0, 10, 255, 1]), Buffer.alloc(0)]);
  assert.deepEqual(calls, [['cat-file', '--batch-check'], ['cat-file', '--batch']]);
  assert.ok(reader.read(oids[1]).equals(result[1][1])); assert.equal(calls.length, 2);
  reader.clear(); assert.equal(reader.cachedBytes, 0);
});

test('serial requests do not mix content and object cache is bounded', t => {
  const f = fixture(t, { a: 'one', b: 'two', c: 'three' }), oids = ['a', 'b', 'c'].map(name => f.git('rev-parse', `HEAD:${name}`));
  const reader = new GitObjectReader(f.root, {}, git, 4);
  for (const [index, text] of ['one', 'two', 'three', 'one'].entries()) { assert.equal(reader.read(oids[index % 3]).toString(), text); assert.ok(reader.cachedBytes <= 4); }
});

test('oversized reads reject from metadata without requesting contents', t => {
  const f = fixture(t, { a: 'four' }), oid = f.git('rev-parse', 'HEAD:a'), calls = [];
  const reader = new GitObjectReader(f.root, {}, (repo, args, options) => { calls.push(args); return git(repo, args, options); });
  assert.throws(() => reader.read(oid, 3), /exceeding the 3-byte read limit/);
  assert.deepEqual(calls, [['cat-file', '--batch-check']]);
});

test('unknown IDs, non-blob objects and unsafe requests fail explicitly', t => {
  const f = fixture(t, { a: 'text' }), reader = new GitObjectReader(f.root);
  assert.throws(() => reader.read('f'.repeat(40)), /does not exist/);
  assert.throws(() => reader.read(f.base), /not a blob/);
  for (const oid of ['HEAD:a', '-a', 'f'.repeat(40) + '\nHEAD']) assert.throws(() => reader.read(oid), /full hexadecimal/);
});

test('batch parser rejects missing, wrong, truncated and extra responses', () => {
  const oid = 'a'.repeat(40), metadata = `${oid} blob 3\n`;
  for (const output of [Buffer.from(`${oid} blob 3\nab`), Buffer.from(`${oid} blob 4\nabc\n`), Buffer.from(`${'b'.repeat(40)} blob 3\nabc\n`), Buffer.from(`${oid} missing\n`), Buffer.from(`${oid} blob 3\nabc\ntrailing`)]) {
    const reader = new GitObjectReader('.', {}, (_repo, args) => args[1] === '--batch-check' ? Buffer.from(metadata) : output);
    assert.throws(() => reader.read(oid), /Git batch/);
    assert.equal(reader.cachedBytes, 0);
  }
  for (const output of [`${oid} blob 3`, `${oid} blob 3\nextra\n`, `${'b'.repeat(40)} blob 3\n`, `${oid} blob 9007199254740992\n`]) {
    const reader = new GitObjectReader('.', {}, () => Buffer.from(output));
    assert.throws(() => reader.inspect([oid]), /Git batch/);
  }
});

test('a malformed second response never publishes the valid first response', () => {
  const oids = ['a'.repeat(40), 'b'.repeat(40)], consumed = [];
  const reader = new GitObjectReader('.', {}, (_repo, args) => args[1] === '--batch-check' ? Buffer.from(oids.map(oid => `${oid} blob 1\n`).join('')) : Buffer.from(`${oids[0]} blob 1\nx\n${oids[1]} blob 1\n`));
  assert.throws(() => reader.readMany(oids, oid => consumed.push(oid)), /Git batch/);
  assert.deepEqual(consumed, []); assert.equal(reader.cachedBytes, 0);
});

test('diff consumes bounded object windows before cache eviction', t => {
  const base = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`${index}.txt`, `before ${index}\n`]));
  const f = fixture(t, base); for (let index = 0; index < 12; index++) f.write(`${index}.txt`, `after ${index}\n`); f.commit();
  const actual = new GitObjectReader(f.root), virtualCache = new Set(), virtualSize = 6 * 1024 * 1024; let windows = 0;
  const reader = {
    inspect: oids => new Map([...actual.inspect(oids)].map(([oid, info]) => [oid, { ...info, size: virtualSize }])),
    readMany: (oids, consume) => { windows++; assert.ok(oids.length * virtualSize <= 32 * 1024 * 1024); for (const oid of oids) { virtualCache.add(oid); while (virtualCache.size * virtualSize > 32 * 1024 * 1024) virtualCache.delete(virtualCache.values().next().value); } actual.readMany(oids, consume); },
    read: oid => { assert.ok(virtualCache.has(oid), 'A prefetched object was evicted before consumption'); return actual.read(oid); },
  };
  const files = readChanges(resolveRepository(f.root, 'main', 'feature'), reader);
  assert.equal(files.length, 12); assert.ok(windows > 1);
});

test('unexpected Git failure is propagated without partial success or fallback', () => {
  const oid = 'a'.repeat(40), stopped = new Error('Git exited unexpectedly');
  const reader = new GitObjectReader('.', {}, (_repo, args) => { if (args[1] === '--batch-check') return Buffer.from(`${oid} blob 1\n`); throw stopped; });
  assert.throws(() => reader.read(oid), error => error === stopped); assert.equal(reader.cachedBytes, 0);
});

test('batch content is split by bytes, not repository size', () => {
  const oids = ['a', 'b', 'c'].map(letter => letter.repeat(40)), size = Math.floor(MAX_BATCH_BYTES / 2) + 1, calls = [];
  const reader = new GitObjectReader('.', {}, (_repo, args, options) => {
    const requested = options.input.trim().split('\n'); calls.push([args[1], requested.length, options.maxBuffer]);
    if (args[1] === '--batch-check') return Buffer.from(requested.map(oid => `${oid} blob ${size}\n`).join(''));
    return Buffer.concat(requested.map(oid => Buffer.concat([Buffer.from(`${oid} blob ${size}\n`), Buffer.alloc(size, 1), Buffer.from('\n')])));
  }, 0);
  let count = 0; reader.readMany(oids, (_oid, bytes) => { assert.equal(bytes.length, size); count++; });
  assert.equal(count, 3); assert.equal(calls.filter(([command]) => command === '--batch').length, 3);
  assert.ok(calls.every(([, , maxBuffer]) => maxBuffer <= MAX_BATCH_BYTES + 129));
});

test('real Git timeout is bounded and a following request works', t => {
  const f = fixture(t, { a: 'text' }), oid = f.git('rev-parse', 'HEAD:a');
  assert.throws(() => git(f.root, ['cat-file', '--batch-check'], { input: `${oid}\n`.repeat(200_000), timeoutMs: 1, maxBuffer: 16 * 1024 * 1024 }), /ETIMEDOUT|timed out/);
  assert.equal(new GitObjectReader(f.root).read(oid).toString(), 'text');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fixture, tsconfig } from '../fixtures/repository.mjs';
import { normalizeConfig } from '../../dist/index.js';
import { analyzeChanges } from '../../dist/languages/index.js';
import { createSandbox, exportSnapshot, readChanges, resolveRepository } from '../../dist/git/index.js';

function snapshots(t, f, mode) {
  const repository = resolveRepository(f.root, 'main', 'feature'), sandbox = createSandbox(repository); t.after(() => sandbox.cleanup());
  const files = readChanges(repository, sandbox.objects), config = normalizeConfig(), warnings = [];
  const roots = Object.fromEntries(['base-full', 'head-full', 'base-light', 'head-light'].map(name => [name, path.join(sandbox.root, name)]));
  exportSnapshot(repository, repository.mergeBaseOid, roots['base-full'], sandbox);
  exportSnapshot(repository, repository.headOid, roots['head-full'], sandbox);
  exportSnapshot(repository, repository.mergeBaseOid, roots['base-light'], sandbox, { mode, files, warnings });
  exportSnapshot(repository, repository.headOid, roots['head-light'], sandbox, { mode, files, warnings });
  const analysisMode = mode === 'fast' ? 'fast' : 'deep';
  assert.deepEqual(analyzeChanges(files, roots['base-light'], roots['head-light'], config, analysisMode), analyzeChanges(files, roots['base-full'], roots['head-full'], config, analysisMode));
  assert.deepEqual(warnings, []);
  return roots;
}

test('fast snapshot keeps changed sources, direct imports and ancestor manifests only', t => {
  const f = fixture(t, { 'package.json': '{"name":"root"}', 'packages/a/package.json': '{"name":"a"}', 'packages/a/a.ts': 'import { value } from "../../lib/value.js";\nexport const a = value;\n', 'lib/value.ts': 'export const value = 1;\n', 'unrelated.ts': 'export const ignored = 1;\n', 'assets/large.bin': Buffer.alloc(1024, 1) });
  f.write('packages/a/a.ts', 'import { value } from "../../lib/value.js";\nexport const a = value + 1;\n'); f.commit();
  const roots = snapshots(t, f, 'fast'), root = roots['head-light'];
  for (const name of ['package.json', 'packages/a/package.json', 'packages/a/a.ts', 'lib/value.ts']) assert.ok(fs.existsSync(path.join(root, name)), name);
  for (const name of ['unrelated.ts', 'assets/large.bin']) assert.equal(fs.existsSync(path.join(root, name)), false, name);
});

test('deep snapshot preserves barrel aliases, JSON imports and nonstandard config extends', t => {
  const config = JSON.stringify({ extends: './base.config', include: ['**/*.ts'] });
  const f = fixture(t, { 'package.json': '{"name":"root","type":"module"}', 'tsconfig.json': config, 'base.config': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, resolveJsonModule: true, types: [] } }), 'lib/value.ts': 'export const value = 1;\n', 'lib/index.ts': 'export { value as alias } from "./value.js";\n', 'consumer.ts': 'import { alias } from "./lib/index.js";\nexport const result = alias;\n', 'data.json': '{"value":1}', 'assets/picture.bin': Buffer.from([0, 1, 2]) });
  f.write('lib/value.ts', 'export const value = 2;\n'); f.write('consumer.ts', 'import { alias } from "./lib/index.js";\nexport const result = alias + 1;\n'); f.commit();
  const roots = snapshots(t, f, 'analysis'), root = roots['head-light'];
  for (const name of ['lib/index.ts', 'base.config', 'data.json']) assert.ok(fs.existsSync(path.join(root, name)), name);
  assert.equal(fs.existsSync(path.join(root, 'assets/picture.bin')), false);
});

test('static verification snapshot retains unchanged invalid sources for syntax checks', t => {
  const f = fixture(t, { 'tsconfig.json': tsconfig, 'a.ts': 'export const a = 1;\n', 'broken.ts': 'export const broken = ;\n', 'README.md': 'Opaque documentation\n' });
  f.write('a.ts', 'export const a = 2;\n'); f.commit();
  const repository = resolveRepository(f.root, 'main', 'feature'), sandbox = createSandbox(repository); t.after(() => sandbox.cleanup());
  const root = path.join(sandbox.root, 'analysis'); exportSnapshot(repository, repository.headOid, root, sandbox, { mode: 'analysis' });
  assert.ok(fs.existsSync(path.join(root, 'broken.ts'))); assert.equal(fs.existsSync(path.join(root, 'README.md')), false);
});

test('package tsconfig entry point takes precedence over its default config', t => {
  const f = fixture(t, { 'tsconfig.json': '{"extends":"pkg","include":["a.ts"]}', 'node_modules/pkg/package.json': '{"name":"pkg","tsconfig":"special.json"}', 'node_modules/pkg/tsconfig.json': '{}', 'node_modules/pkg/special.json': '{"extends":"./base.cfg"}', 'node_modules/pkg/base.cfg': '{"compilerOptions":{"strict":true,"types":[]}}', 'a.ts': 'export const a = 1;\n' });
  f.write('a.ts', 'export const a = 2;\n'); f.commit();
  const roots = snapshots(t, f, 'analysis'); assert.ok(fs.existsSync(path.join(roots['head-light'], 'node_modules/pkg/base.cfg')));
});

test('analysis normalizes Windows separators in config extends without changing Git paths', t => {
  const f = fixture(t, { 'tsconfig.json': JSON.stringify({ extends: '.\\base.cfg', references: [{ path: '.\\project' }], include: ['a.ts'] }), 'base.cfg': '{"compilerOptions":{"strict":true,"types":[]}}', 'project/tsconfig.json': JSON.stringify({ extends: '.\\settings.cfg', include: ['b.ts'] }), 'project/settings.cfg': '{"compilerOptions":{"composite":true,"types":[]}}', 'project/b.ts': 'export const b = 1;\n', 'a.ts': 'export const a = 1;\n' });
  f.write('a.ts', 'export const a = 2;\n'); f.commit();
  const roots = snapshots(t, f, 'analysis');
  assert.ok(fs.existsSync(path.join(roots['head-light'], 'base.cfg'))); assert.ok(fs.existsSync(path.join(roots['head-light'], 'project/settings.cfg')));
});

test('case-insensitive source discovery preserves direct imports with different path case', t => {
  const f = fixture(t, { 'consumer.ts': 'import { value } from "./value.js";\nexport const result = value;\n', 'Value.ts': 'export const value = 1;\n', 'unrelated.ts': 'export const unrelated = 0;\n' });
  f.write('consumer.ts', 'import { value } from "./value.js";\nexport const result = value + 1;\n'); f.commit();
  const repository = resolveRepository(f.root, 'main', 'feature'), sandbox = createSandbox(repository); t.after(() => sandbox.cleanup());
  const files = readChanges(repository, sandbox.objects), root = path.join(sandbox.root, 'case-insensitive'), original = ts.sys.useCaseSensitiveFileNames;
  ts.sys.useCaseSensitiveFileNames = false;
  try { exportSnapshot(repository, repository.headOid, root, sandbox, { mode: 'fast', files }); }
  finally { ts.sys.useCaseSensitiveFileNames = original; }
  assert.ok(fs.existsSync(path.join(root, 'Value.ts'))); assert.equal(fs.existsSync(path.join(root, 'unrelated.ts')), false);
});

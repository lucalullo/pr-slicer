import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan, normalizeConfig } from '../../dist/index.js';
import { createSandbox, exportSnapshot, resolveRepository } from '../../dist/git/index.js';
import { safePath, validateGitPath } from '../../dist/core/paths.js';

const options = f => ({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig() });
const sourceRoot = new URL('../../', import.meta.url);

test('CI and release explicitly run clean install, build, typecheck, tests and package checks', () => {
  for (const filename of ['ci.yml', 'release.yml']) {
    const workflow = fs.readFileSync(new URL(`.github/workflows/${filename}`, sourceRoot), 'utf8');
    for (const command of ['npm ci --ignore-scripts', 'npm run build', 'npm run typecheck', 'npm test', 'npm run test:package']) {
      assert.ok(workflow.split(/\r?\n/).some(line => line.trim() === `- run: ${command}`), `${filename}: missing explicit ${command}`);
    }
  }
  const ci = fs.readFileSync(new URL('.github/workflows/ci.yml', sourceRoot), 'utf8');
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[22, 24\]/);
});

test('worktree directory with spaces and Unicode preserves Git paths and LF/CRLF bytes', async t => {
  const filename = 'src/caffè λ/hello world.ts';
  const expected = Buffer.from('export const first = 3;\r\nexport const second = 4;\n');
  const f = fixture(t, { [filename]: 'export const first = 1;\r\nexport const second = 2;\n' });
  f.write(filename, expected); f.commit();
  const linked = path.join(f.parent, 'repository with spaces è');
  f.git('worktree', 'add', '--detach', linked, 'feature');
  const plan = createPlan({ ...options(f), repo: linked });
  assert.equal(plan.files[0].newPath, filename);
  assert.ok(plan.files.every(file => !file.newPath?.includes('\\') && !file.oldPath?.includes('\\')));
  const verified = await verifyPlan(plan);
  assert.equal(verified.verification.status, 'passed', JSON.stringify(verified.checks));
  const result = materializePlan(verified, { prefix: 'portable/spaces' });
  assert.equal(result.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
  assert.deepEqual(fs.readFileSync(path.join(linked, ...filename.split('/'))), expected);
  f.git('fsck', '--full', '--strict');
});

test('case-only rename is exact with Git case-insensitive matching enabled', async t => {
  const original = Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n';
  const f = fixture(t, { 'Widget.ts': original });
  // Simulates Git's ignorecase setting, not a case-insensitive host filesystem.
  // The intermediate name also makes the rename explicit on a native insensitive filesystem.
  f.git('config', 'core.ignorecase', 'true');
  f.git('mv', 'Widget.ts', 'intermediate-name.ts');
  f.git('mv', 'intermediate-name.ts', 'widget.ts');
  f.write('widget.ts', original.replace('value19 = 19', 'value19 = 29'));
  f.commit();
  const plan = createPlan(options(f));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].oldPath, 'Widget.ts');
  assert.equal(plan.files[0].newPath, 'widget.ts');
  const verified = await verifyPlan(plan);
  assert.equal(verified.verification.status, 'passed', JSON.stringify(verified.checks));
  const result = materializePlan(verified, { prefix: 'portable/case' });
  assert.equal(result.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
});

test('Git slash paths resolve to native separators; backslash and drive escapes are rejected', t => {
  const f = fixture(t);
  assert.equal(validateGitPath('src/è/space name.ts'), 'src/è/space name.ts');
  assert.equal(safePath(f.root, 'src/è/space name.ts'), path.join(fs.realpathSync(f.root), 'src', 'è', 'space name.ts'));
  for (const name of ['src\\file.ts', '..\\outside', 'C:\\outside', 'C:/outside', '\\\\server\\share']) {
    assert.throws(() => safePath(f.root, name), error => error.code === 'UNSAFE_PATH');
  }
});

test('POSIX-only newline and colon names preserve their exact Git tree', t => {
  if (process.platform === 'win32') return t.skip('Windows cannot create these filenames; POSIX-only fixture');
  const f = fixture(t, { 'line\nname.ts': 'export const a = 1;\n', 'name:part.ts': 'export const b = 1;\n' });
  f.write('line\nname.ts', 'export const a = 2;\n');
  f.write('name:part.ts', 'export const b = 2;\n');
  f.commit();
  const plan = createPlan(options(f));
  assert.deepEqual(plan.files.map(file => file.newPath).sort(), ['line\nname.ts', 'name:part.ts']);
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
});

test('symlinks are omitted from snapshots without dereferencing, where creation is permitted', t => {
  const f = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  const external = path.join(f.parent, 'outside.ts');
  const content = 'outside repository: this must never become snapshot source';
  fs.writeFileSync(external, content);
  try { fs.symlinkSync(external, path.join(f.root, 'external.ts'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return t.skip(`Host cannot create symlinks: ${error.code}`);
    throw error;
  }
  f.git('config', 'core.symlinks', 'true'); f.commit();
  assert.match(f.git('ls-tree', 'feature', '--', 'external.ts'), /^120000 blob /);
  const plan = createPlan(options(f));
  assert.equal(plan.files.find(file => file.newPath === 'external.ts').atomic, true);
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
  const sandbox = createSandbox(plan.repository);
  try {
    const snapshot = path.join(sandbox.root, 'snapshot with spaces');
    exportSnapshot(plan.repository, plan.repository.headOid, snapshot, sandbox);
    assert.equal(fs.existsSync(path.join(snapshot, 'external.ts')), false);
    assert.equal(fs.readFileSync(external, 'utf8'), content);
  } finally { sandbox.cleanup(); }
  assert.equal(fs.existsSync(sandbox.root), false);
});

test('sandbox temporary directories are cleaned after successful and failing setup', t => {
  const f = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  f.write('a.ts', 'export const a = 2;\n'); f.commit();
  const repository = resolveRepository(f.root, 'main', 'feature');
  const created = [], original = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => { const dir = original(...args); created.push(dir); return dir; };
  syncBuiltinESMExports();
  try {
    createPlan(options(f));
    assert.throws(() => createSandbox({ ...repository, root: f.parent }), error => error.code === 'GIT_ERROR');
  } finally { fs.mkdtempSync = original; syncBuiltinESMExports(); }
  assert.ok(created.length >= 2, 'observed both successful and failing sandbox allocations');
  for (const dir of created) assert.equal(fs.existsSync(dir), false, `leftover temporary directory: ${dir}`);
});

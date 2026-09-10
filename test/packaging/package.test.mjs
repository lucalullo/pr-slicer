import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fixture } from '../fixtures/repository.mjs';

const root = process.cwd();
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' }, shell: false, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`); return result.stdout;
}
function npm(args, cwd = root) {
  assert.ok(process.env.npm_execpath, 'Run packaging tests through npm run test:package');
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}
function tarEntries(file) {
  const data = gunzipSync(fs.readFileSync(file)), names = [];
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, ''), type = header[156];
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length, 'Invalid tar framing');
    if (type !== 120 && type !== 103) names.push(name.replace(/^package\//, ''));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}
function safeRuntimeEntries(names) {
  for (const name of names) {
    assert.doesNotMatch(name, /(?:^|\/)(?:\.git|node_modules|coverage|test|releases|docs)(?:\/|$)|\.(?:tgz|zip|log|map)$|\.env/);
    assert.ok(/^(?:package\.json|README\.md|LICENSE|src\/(?:config\/schema|core\/plan-schema)\.json|dist\/.+\.(?:js|d\.ts)|dist\/(?:config\/schema|core\/plan-schema)\.json)$/.test(name), `Unexpected package entry: ${name}`);
  }
}
test('publishable tarball is allowlisted, installs offline and runs its installed CLI', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-slicer package ')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dry = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--offline', '--json']))[0]; safeRuntimeEntries(dry.files.map(file => file.path));
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', dir]))[0];
  const tarball = path.join(dir, packed.filename), names = tarEntries(tarball); safeRuntimeEntries(names);
  assert.deepEqual([...names].sort(), packed.files.map(file => file.path).sort());
  assert.ok(names.includes('dist/cli/main.js')); assert.ok(names.includes('dist/config/schema.json'));
  const installed = path.join(dir, 'fresh install'); fs.mkdirSync(installed);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const local = `file:../${packed.filename}`, dependencies = { 'pr-slicer': local };
  // Repack the installed, lockfile-pinned runtime dependencies as local fixtures.
  // This tests a genuine fresh npm installation without relying on registry/cache
  // URL aliases or allowing a packaging smoke test to access the network.
  const packages = {};
  for (const [name, value] of Object.entries(lock.packages).filter(([name, value]) => name && !value.dev)) {
    const dependency = JSON.parse(npm(['pack', path.join(root, name), '--ignore-scripts', '--offline', '--json', '--pack-destination', dir]))[0];
    assert.equal(dependency.version, value.version);
    packages[name] = { ...value, resolved: `file:../${dependency.filename}`, integrity: dependency.integrity };
  }
  packages[''] = { name: 'package-smoke', version: '1.0.0', dependencies };
  packages['node_modules/pr-slicer'] = { version: manifest.version, resolved: local, integrity: packed.integrity, dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines };
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'package-smoke', version: '1.0.0', private: true, dependencies }));
  fs.writeFileSync(path.join(installed, 'package-lock.json'), JSON.stringify({ name: 'package-smoke', version: '1.0.0', lockfileVersion: 3, requires: true, packages }));
  npm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
  const cli = path.join(installed, 'node_modules/pr-slicer/dist/cli/main.js');
  assert.equal(run(process.execPath, [cli, '--version'], installed).trim(), '0.1.0');
  assert.match(run(process.execPath, [cli, '--help'], installed), /materialize/);
  const repository = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  repository.write('a.ts', 'export const a = 2;\n'); repository.commit();
  const plan = path.join(dir, 'plan.json'), verified = path.join(dir, 'verified.json');
  run(process.execPath, [cli, 'plan', '--repo', repository.root, '--base', 'main', '--head', 'feature', '--fast', '--format', 'json', '--output', plan], installed);
  run(process.execPath, [cli, 'verify', plan, '--output', verified], installed);
  const result = JSON.parse(run(process.execPath, [cli, 'materialize', verified, '--prefix', 'installed-smoke', '--dry-run'], installed));
  assert.equal(result.finalTreeOid, repository.git('rev-parse', 'feature^{tree}'));
  assert.equal(result.branches.length, 1);
});
test('source ZIP excludes Git objects, dependencies, nested archives, reports and local files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-slicer zip ')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'source.zip'), python = process.env.PR_SLICER_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  run(python, ['scripts/package-release.py', '--output', zip]);
  const names = JSON.parse(run(python, ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))', zip]));
  assert.ok(names.includes('pr-slicer/package-lock.json')); assert.ok(names.includes('pr-slicer/test/integration/end-to-end.test.mjs'));
  for (const name of names) assert.doesNotMatch(name, /(?:^|\/)(?:\.git|node_modules|coverage|releases|\.demo)(?:\/|$)|\.(?:tgz|zip|log)$|\/docs\/validation\/|\/VALIDATION\.md$|\.pr-slicer\.json$/);
});

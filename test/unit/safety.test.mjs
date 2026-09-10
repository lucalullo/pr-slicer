import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, matchesGlob } from '../../dist/config/index.js';
import { runCheck, MAX_LOG_BYTES } from '../../dist/verify/check-runner.js';
import { createCheckEnvironment } from '../../dist/verify/environment.js';
import { validateGitPath, safePath } from '../../dist/core/paths.js';
import { applyHunks, parseHunks } from '../../dist/git/index.js';

test('strict JSON data configuration', () => {
  assert.throws(() => normalizeConfig({ limits: { maxGroups: 0 } }), /maxGroups/);
  assert.throws(() => normalizeConfig({ evil: true }), /sconosciuto/);
  assert.throws(() => normalizeConfig({ checks: [{ name: 'x', command: 'node', args: [] }] }), /timeoutMs/);
  assert.throws(() => normalizeConfig({ environment: { allow: ['NOT=AN_ENV'] } }), /formato/);
  assert.throws(() => normalizeConfig({ limits: { targetChangedLines: 9999 } }), /hardMax/);
  assert.equal(normalizeConfig().limits.maxGroups, 5);
});
test('portable glob matching', () => {
  assert.equal(matchesGlob('a.ts', '**/*.ts'), true); assert.equal(matchesGlob('a/b.ts', '**/*.ts'), true);
  assert.equal(matchesGlob('a/b.js', '**/*.ts'), false); assert.equal(matchesGlob('src/a/b.ts', 'src/*'), false);
});
test('path traversal and symlink confinement', t => {
  for (const value of ['../a', '/tmp/a', 'a/../b', 'a/.git/config', 'C:/x', 'a\\b', 'a\0b']) assert.throws(() => validateGitPath(value), /Unsafe/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-path-')); t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  if (process.platform !== 'win32') { fs.symlinkSync(os.tmpdir(), path.join(dir, 'escape')); assert.throws(() => safePath(dir, 'escape/file'), /Symlink/); }
  assert.equal(safePath(dir, 'valid/è.txt'), path.join(dir, 'valid/è.txt'));
});
test('hunks preserve CRLF and missing final newline; malformed rejected', () => {
  const patch = '@@ -1 +1 @@\n-old\r\n+new\r\n@@ -3 +3 @@\n-tail\n\\ No newline at end of file\n+end\n\\ No newline at end of file\n';
  const hunks = parseHunks(patch, 'a', 'a', 'f');
  assert.ok(applyHunks(Buffer.from('old\r\nkeep\r\ntail'), hunks).equals(Buffer.from('new\r\nkeep\r\nend')));
  assert.ok(applyHunks(Buffer.from('old\r\nkeep\r\ntail'), [hunks[1]]).equals(Buffer.from('old\r\nkeep\r\nend')));
  assert.throws(() => applyHunks(Buffer.from('mismatch'), hunks), /match|bounds/);
  assert.throws(() => applyHunks(Buffer.from('old\r\nkeep\r\ntail'), [hunks[0], hunks[0]]), /Overlapping/);
});
test('check runner bounded logs and explicit structured args', async () => {
  const env = createCheckEnvironment({ inherit: false, allow: [] });
  const check = await runCheck({ name: 'log', command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(200000))'], timeoutMs: 5000 }, process.cwd(), env);
  assert.equal(check.status, 'passed'); assert.ok(Buffer.byteLength(check.log) < MAX_LOG_BYTES + 100);
  const literal = await runCheck({ name: 'literal', command: process.execPath, args: ['-e', 'console.log(process.argv[1])', '$(echo unsafe);*'], timeoutMs: 5000 }, process.cwd(), env);
  assert.equal(literal.log.trim(), '$(echo unsafe);*');
});
test('check runner timeout and unavailable executable', async () => {
  const env = createCheckEnvironment({ inherit: false, allow: [] });
  const timed = await runCheck({ name: 'hang', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }, process.cwd(), env);
  assert.equal(timed.status, 'timeout'); assert.ok(timed.durationMs < 3000);
  const missing = await runCheck({ name: 'missing', command: 'pr-slicer-command-that-does-not-exist', args: [], timeoutMs: 1000 }, process.cwd(), env);
  assert.equal(missing.status, 'unavailable');
});
test('check environment strips secrets and Node injection by default', () => {
  const e = createCheckEnvironment({ inherit: false, allow: ['CUSTOM'] }, { PATH: '/bin', GITHUB_TOKEN: 'hidden', NODE_OPTIONS: '--require bad', CUSTOM: 'ok' });
  assert.equal(e.GITHUB_TOKEN, undefined); assert.equal(e.NODE_OPTIONS, undefined); assert.equal(e.CUSTOM, 'ok'); assert.equal(e.PATH, '/bin');
});
test('configuration rejects prototype property names', () => {
  for (const value of ['{"__proto__":{"evil":true}}', '{"toString":{}}', '{"limits":{"constructor":2}}']) assert.throws(() => normalizeConfig(JSON.parse(value)), /sconosciuto/);
});
test('timeout kills descendants in the process group', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group assertion');
  const check = await runCheck({ name: 'descendant', command: process.execPath, args: ['-e', 'const p=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log(p.pid);setInterval(()=>{},1000)'], timeoutMs: 1200 }, process.cwd(), createCheckEnvironment({ inherit: false, allow: [] }));
  assert.equal(check.status, 'timeout'); const pid = Number(check.log?.trim()); assert.ok(Number.isInteger(pid) && pid > 0);
  // A dead child may remain a zombie briefly; it must never execute another timer after group termination.
  try { const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]; assert.equal(state, 'Z'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

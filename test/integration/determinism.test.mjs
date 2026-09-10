import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan, verifyPlan, materializePlan, normalizeConfig } from '../../dist/index.js';

test('materialized commit bytes ignore local/global Git identity, signing, encoding, locale and timezone', async t => {
  const f = fixture(t, { 'a.js': 'export const a = 1;\n' }); f.write('a.js', 'export const a = 2;\n'); f.commit();
  const verified = await verifyPlan(createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({}) }));
  verified.groups[0].title = 'Caffè già pronto — funzione π';
  const first = materializePlan(verified, { prefix: 'first' }), bytes = first.branches.map(branch => f.git('cat-file', 'commit', branch.oid));
  for (const [key, value] of Object.entries({ 'user.name': 'Unrelated User', 'user.email': 'other@example.invalid', 'author.name': 'Other Author', 'author.email': 'author@example.invalid', 'committer.name': 'Other Committer', 'committer.email': 'committer@example.invalid', 'user.useConfigOnly': 'true', 'user.signingKey': 'not-a-real-key', 'i18n.commitEncoding': 'ISO-8859-1', 'commit.gpgSign': 'true', 'gpg.format': 'ssh', 'gpg.ssh.program': 'must-not-execute-pr-slicer-test' })) f.git('config', key, value);
  const global = path.join(f.parent, 'global.gitconfig');
  fs.writeFileSync(global, '[user]\n name = Global User\n email = global@example.invalid\n[i18n]\n commitEncoding = UTF-16\n[commit]\n gpgSign = true\n');
  const changes = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'i18n.commitEncoding', GIT_CONFIG_VALUE_0: 'UTF-16', GIT_AUTHOR_NAME: 'Ambient Author', GIT_AUTHOR_EMAIL: 'ambient@example.invalid', GIT_AUTHOR_DATE: '2001-02-03T04:05:06-1100', GIT_COMMITTER_NAME: 'Ambient Committer', GIT_COMMITTER_EMAIL: 'ambient-committer@example.invalid', GIT_COMMITTER_DATE: '2002-03-04T05:06:07+1300', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Pacific/Honolulu' };
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]])); let second;
  Object.assign(process.env, changes);
  try { second = materializePlan(verified, { prefix: 'second' }); }
  finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.deepEqual(second.branches.map(branch => branch.oid), first.branches.map(branch => branch.oid));
  assert.deepEqual(second.branches.map(branch => f.git('cat-file', 'commit', branch.oid)), bytes);
  for (const content of bytes) { assert.doesNotMatch(content, /^encoding |^gpgsig /m); assert.match(content, /\nauthor PR Slicer <pr-slicer@localhost> \d+ \+0000\ncommitter PR Slicer <pr-slicer@localhost> \d+ \+0000\n/); assert.match(content, /Caffè già pronto — funzione π/); }
  assert.equal(second.finalTreeOid, f.git('rev-parse', 'feature^{tree}')); assert.doesNotThrow(() => f.git('fsck', '--full', '--strict'));
});

test('commit timestamp extraction ignores local log output encoding', async t => {
  const f = fixture(t, { 'a.js': 'export const a = 1;\n' }); f.write('a.js', 'export const a = 2;\n'); f.commit();
  const verified = await verifyPlan(createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({}) }));
  const first = materializePlan(verified, { prefix: 'encoding', dryRun: true });
  f.git('config', 'i18n.logOutputEncoding', 'UTF-16');
  assert.deepEqual(materializePlan(verified, { prefix: 'encoding', dryRun: true }), first);
});

test('timestamp extraction never invokes a configured signature verifier', async t => {
  const f = fixture(t, { 'a.js': 'export const a = 1;\n' }); f.write('a.js', 'export const a = 2;\n'); f.commit();
  const raw = f.git('cat-file', 'commit', 'HEAD'), split = raw.indexOf('\n\n');
  const signed = `${raw.slice(0, split)}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n ZmFrZQ==\n -----END PGP SIGNATURE-----${raw.slice(split)}\n`;
  const oid = childProcess.execFileSync('git', ['-C', f.root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { env: f.env, input: signed, encoding: 'utf8' }).trim(); f.git('update-ref', 'refs/heads/feature', oid);
  const verified = await verifyPlan(createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast', config: normalizeConfig({}) }));
  const first = materializePlan(verified, { prefix: 'signed', dryRun: true }), trace = path.join(f.parent, 'git-signature.trace');
  f.git('config', 'log.showSignature', 'true'); f.git('config', 'gpg.program', path.join(f.parent, 'must-not-run-signature-verifier'));
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => original(command, args, command === 'git' && args.includes('show') ? { ...options, env: { ...options.env, GIT_TRACE: trace } } : options));
  syncBuiltinESMExports();
  try { assert.deepEqual(materializePlan(verified, { prefix: 'signed', dryRun: true }), first); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.match(fs.readFileSync(trace, 'utf8'), /built-in: git/); assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /must-not-run-signature-verifier/);
  assert.doesNotThrow(() => f.git('fsck', '--full', '--strict'));
});

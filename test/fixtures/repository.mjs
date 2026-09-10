import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export const cli = path.resolve('dist/cli/main.js');
export function fixture(t, baseFiles = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-test-'));
  const root = path.join(parent, 'repo'); fs.mkdirSync(root);
  t?.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost', GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z', LC_ALL: 'C' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL','GIT_AUTHOR_DATE','GIT_COMMITTER_DATE'].includes(key)) delete env[key];
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (name, bytes) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  for (const [name, bytes] of Object.entries(baseFiles)) write(name, bytes);
  git('add', '-A'); git('commit', '--allow-empty', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature');
  const commit = (message = 'feature') => { git('add', '-A'); git('commit', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  return { parent, root, base, git, write, commit, env };
}
export const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, types: [] }, include: ['**/*.ts', '**/*.tsx'] });

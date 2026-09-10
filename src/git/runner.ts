import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safePath, validateGitPath } from '../core/paths.js';
import { dirname, join, resolve } from 'node:path';
import { SlicerError } from '../core/errors.js';
import type { Repository } from '../core/model.js';

export interface GitOptions { input?: string | Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number; outputFd?: number }

/** No shell, network protocols, hooks, lazy fetching, fsmonitor, external diff or textconv. */
export function git(repo: string, args: string[], options: GitOptions = {}): Buffer {
  const timeout = options.timeoutMs ?? 120_000, maxBuffer = options.maxBuffer ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 256 * 1024 * 1024 || options.outputFd !== undefined && (!Number.isSafeInteger(options.outputFd) || options.outputFd < 3)) throw new SlicerError('Invalid Git process resource limits.', 'INVALID_INPUT');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env: NodeJS.ProcessEnv = { ...inherited, ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', LANG: 'C' };
  const settings = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'protocol.allow=never', 'submodule.recurse=false', 'core.attributesFile=/dev/null', 'core.pager=cat', 'diff.external=', 'diff.ignoreSubmodules=none', 'color.ui=false'];
  const result = spawnSync('git', [...settings.flatMap(setting => ['-c', setting]), '-C', repo, ...args], { input: typeof options.input === 'string' ? Buffer.from(options.input, 'utf8') : options.input, env, encoding: 'buffer', maxBuffer, timeout, shell: false, windowsHide: true, stdio: ['pipe', options.outputFd ?? 'pipe', 'pipe'] });
  if (result.error) throw new SlicerError(`Unable to execute Git: ${result.error.message}`, 'GIT_ERROR');
  if (result.status !== 0) throw new SlicerError(`Git ${args[0] ?? ''} failed: ${result.stderr?.toString('utf8').trim().slice(0, 4000) || `exit ${result.status}`}`, 'GIT_ERROR');
  return result.stdout ?? Buffer.alloc(0);
}

const value = (repo: string, args: string[]): string => git(repo, args).toString('utf8').trim();
function commit(repo: string, ref: string): string {
  if (!ref || ref.includes('\0') || ref.startsWith('-')) throw new SlicerError('A non-option local commit reference is required.');
  return value(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}

export function resolveRepository(repo: string, base: string, head: string): Repository {
  let requested: string;
  try { requested = realpathSync(resolve(repo)); } catch { throw new SlicerError(`Repository does not exist: ${repo}`, 'INVALID_REPOSITORY'); }
  const root = realpathSync(value(requested, ['rev-parse', '--show-toplevel']));
  const gitDir = value(root, ['rev-parse', '--absolute-git-dir']);
  const commonDir = value(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const baseOid = commit(root, base), headOid = commit(root, head);
  const bases = value(root, ['merge-base', '--all', baseOid, headOid]).split('\n').filter(Boolean);
  if (bases.length !== 1) throw new SlicerError('Expected one merge-base; unrelated or criss-cross histories cannot be sliced safely.', 'AMBIGUOUS_MERGE_BASE');
  const mergeBaseOid = bases[0];
  return { root, gitDir, commonDir, objectFormat: value(root, ['rev-parse', '--show-object-format']), baseRef: base, headRef: head, baseOid, headOid, mergeBaseOid, baseTreeOid: value(root, ['rev-parse', `${mergeBaseOid}^{tree}`]), headTreeOid: value(root, ['rev-parse', `${headOid}^{tree}`]) };
}

export function assertClean(repository: Repository): void {
  const dirty = (): never => { throw new SlicerError('Materialization requires a clean working tree and index, including untracked files.', 'DIRTY_WORKTREE'); };
  const regularOid = (target: string, mode?: string): string => {
    const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || mode && process.platform !== 'win32' && ((info.mode & 0o111) !== 0) !== (mode === '100755')) dirty();
      const hash = createHash(repository.objectFormat).update(Buffer.from(`blob ${info.size}\0`)), chunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) { const count = readSync(descriptor, chunk); if (!count) break; hash.update(chunk.subarray(0, count)); }
      return hash.digest('hex');
    } finally { closeSync(descriptor); }
  };
  if (git(repository.root, ['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--']).length || git(repository.root, ['ls-files', '--others', '--exclude-standard', '-z']).length) dirty();
  // Read bytes directly: `git status` can execute clean filters configured by a repository.
  for (const record of git(repository.root, ['ls-files', '--stage', '-z']).toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== '0') dirty();
    const [, mode, oid, , name] = match!; validateGitPath(name);
    if (mode === '160000') continue; // Opaque gitlink OIDs are preserved; never inspect or initialize a submodule worktree.
    let actual: string;
    try {
      const parent = dirname(name); if (parent !== '.') safePath(repository.root, parent);
      const target = join(repository.root, name), stat = lstatSync(target);
      if (mode === '120000') {
        if (stat.isSymbolicLink()) {
          const content = readlinkSync(target, { encoding: 'buffer' });
          actual = createHash(repository.objectFormat).update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
        } else if (process.platform === 'win32' && stat.isFile()) actual = regularOid(target); // Git for Windows may check out symlinks as plain link-text files when core.symlinks=false.
        else dirty();
      } else {
        if (!stat.isFile() || stat.isSymbolicLink()) dirty();
        actual = regularOid(target, mode);
      }
    } catch { dirty(); }
    if (actual! !== oid) dirty();
  }
}

export function assertRefsUnchanged(repository: Repository): void {
  if (commit(repository.root, repository.baseRef) !== repository.baseOid || commit(repository.root, repository.headRef) !== repository.headOid) throw new SlicerError('Base or head moved after this plan was generated. Generate a fresh plan.', 'REFS_CHANGED');
  if (value(repository.root, ['rev-parse', `${repository.mergeBaseOid}^{tree}`]) !== repository.baseTreeOid || value(repository.root, ['rev-parse', `${repository.headOid}^{tree}`]) !== repository.headTreeOid) throw new SlicerError('Plan tree identifiers do not match its commits.', 'INVALID_PLAN');
}

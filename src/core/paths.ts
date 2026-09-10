import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SlicerError } from './errors.js';

/** Git paths are relative, slash-delimited names; reject platform-dependent escapes. */
export function validateGitPath(path: string): string {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[a-z]:/i.test(path)) throw new SlicerError(`Unsafe Git path: ${JSON.stringify(path)}`, 'UNSAFE_PATH');
  if (path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new SlicerError(`Unsafe Git path: ${JSON.stringify(path)}`, 'UNSAFE_PATH');
  return path;
}

/** Resolve a path without allowing existing symlinks in any component. */
export function safePath(root: string, path: string): string {
  validateGitPath(path);
  const realRoot = realpathSync(root), target = resolve(realRoot, path), rel = relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SlicerError(`Path escapes snapshot: ${JSON.stringify(path)}`, 'UNSAFE_PATH');
  let current = realRoot;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new SlicerError(`Symlink in snapshot path: ${JSON.stringify(path)}`, 'UNSAFE_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

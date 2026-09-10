import { chmodSync, closeSync, fstatSync, openSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { SlicerError } from '../core/errors.js';
import { safePath, validateGitPath } from '../core/paths.js';
import type { ChangeUnit, DiffHunk, Evidence, FileChange, Repository } from '../core/model.js';
import { byteLines, readBlob } from './diff.js';
import { git } from './runner.js';
import { GitObjectReader, MAX_BLOB_BYTES, oversizedBlobWarning } from './objects.js';

export interface GitSandbox { root: string; env: NodeJS.ProcessEnv; objects?: GitObjectReader; cleanup(): void }
export function createSandbox(repository: Repository): GitSandbox {
  const root = mkdtempSync(join(tmpdir(), 'pr-slicer-'));
  try {
    const objects = join(root, 'objects'); mkdirSync(objects);
    const originalObjects = git(repository.root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString('utf8').trim();
    const env = { GIT_INDEX_FILE: join(root, 'index'), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(originalObjects) };
    const reader = new GitObjectReader(repository.root, env);
    return { root, env, objects: reader, cleanup: () => { reader.clear(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function hunkBytes(hunk: DiffHunk): { oldBytes: Buffer; newBytes: Buffer } {
  const old: Buffer[] = [], next: Buffer[] = []; let preceding = '';
  for (const line of hunk.lines) {
    const marker = line[0];
    if (line === '\\ No newline at end of file') {
      if (!preceding) throw new SlicerError('Misplaced no-final-newline marker.', 'INVALID_DIFF');
      if (preceding === '-' || preceding === ' ') old[old.length - 1] = old[old.length - 1].subarray(0, -1);
      if (preceding === '+' || preceding === ' ') next[next.length - 1] = next[next.length - 1].subarray(0, -1);
      preceding = ''; continue;
    }
    if (marker !== '-' && marker !== '+' && marker !== ' ') throw new SlicerError('Malformed hunk body.', 'INVALID_DIFF');
    const bytes = Buffer.from(`${line.slice(1)}\n`, 'utf8');
    if (marker === '-' || marker === ' ') old.push(bytes);
    if (marker === '+' || marker === ' ') next.push(bytes);
    preceding = marker;
  }
  if (old.length !== hunk.oldRange.count || next.length !== hunk.newRange.count) throw new SlicerError('Hunk line counts do not match its ranges.', 'INVALID_DIFF');
  return { oldBytes: Buffer.concat(old), newBytes: Buffer.concat(next) };
}

export function applyHunks(base: Buffer, hunks: DiffHunk[]): Buffer {
  const lines = byteLines(base), output: Buffer[] = []; let cursor = 0;
  const ordered = [...hunks].sort((a, b) => a.oldRange.start - b.oldRange.start || a.newRange.start - b.newRange.start);
  for (const hunk of ordered) {
    const position = hunk.oldRange.count === 0 ? hunk.oldRange.start : hunk.oldRange.start - 1;
    if (!Number.isSafeInteger(position) || position < cursor || position < 0 || position + hunk.oldRange.count > lines.length) throw new SlicerError('Overlapping or out-of-bounds hunk.', 'INVALID_DIFF');
    const { oldBytes, newBytes } = hunkBytes(hunk);
    if (!Buffer.concat(lines.slice(position, position + hunk.oldRange.count)).equals(oldBytes)) throw new SlicerError('Hunk does not match the immutable base blob.', 'INVALID_DIFF');
    output.push(...lines.slice(cursor, position), newBytes); cursor = position + hunk.oldRange.count;
  }
  output.push(...lines.slice(cursor)); return Buffer.concat(output);
}

export function reconstructTree(repository: Repository, files: FileChange[], units: ChangeUnit[], selectedUnitIds: string[], sandbox: GitSandbox): string {
  const selected = new Set(selectedUnitIds), unitMap = new Map(units.map(unit => [unit.id, unit])), selectedHunks = new Map<string, Set<string>>();
  if (selected.size !== selectedUnitIds.length) throw new SlicerError('A unit was selected more than once.', 'INVALID_PLAN');
  for (const unitId of selected) {
    const unit = unitMap.get(unitId); if (!unit) throw new SlicerError(`Unknown selected unit: ${unitId}`, 'INVALID_PLAN');
    const found = selectedHunks.get(unit.fileId) ?? new Set<string>();
    for (const hunkId of unit.hunkIds) { if (found.has(hunkId)) throw new SlicerError(`Hunk selected twice: ${hunkId}`, 'INVALID_PLAN'); found.add(hunkId); }
    selectedHunks.set(unit.fileId, found);
  }
  const indexPath = sandbox.env.GIT_INDEX_FILE;
  if (!indexPath || !sandbox.env.GIT_OBJECT_DIRECTORY) throw new SlicerError('An isolated Git index and object directory are required.', 'INVALID_SANDBOX');
  rmSync(indexPath, { force: true });
  git(repository.root, ['read-tree', repository.baseTreeOid], { env: sandbox.env });
  const removals: Buffer[] = [], updates: Buffer[] = [], zeros = '0'.repeat(repository.headOid.length);
  for (const file of files) {
    const hunkIds = selectedHunks.get(file.id); if (!hunkIds) continue;
    selectedHunks.delete(file.id);
    if (file.oldPath) validateGitPath(file.oldPath); if (file.newPath) validateGitPath(file.newPath);
    const chosen = file.hunks.filter(hunk => hunkIds.has(hunk.id));
    if (!chosen.length || chosen.length !== hunkIds.size || (file.atomic && chosen.length !== file.hunks.length)) throw new SlicerError('Unknown hunk or partial atomic file in selected units.', 'INVALID_PLAN');
    if (file.oldPath && file.oldPath !== file.newPath) removals.push(Buffer.from(`0 ${zeros}\t${file.oldPath}\0`));
    if (!file.newPath) continue;
    let oid = file.newOid;
    if (!file.atomic) {
      const result = applyHunks(readBlob(repository, file.oldOid, sandbox.objects), chosen);
      oid = git(repository.root, ['hash-object', '-w', '--stdin'], { env: sandbox.env, input: result }).toString('ascii').trim();
      if (chosen.length === file.hunks.length && oid !== file.newOid) throw new SlicerError('All hunks do not reconstruct the exact head blob.', 'RECONSTRUCTION_FAILED');
    }
    if (!/^(100644|100755|120000|160000)$/.test(file.newMode) || !new RegExp(`^[a-f0-9]{${zeros.length}}$`).test(oid)) throw new SlicerError('Invalid tree entry in plan.', 'INVALID_PLAN');
    updates.push(Buffer.from(`${file.newMode} ${oid}\t${file.newPath}\0`));
  }
  if (selectedHunks.size) throw new SlicerError('Selected unit references an unknown file.', 'INVALID_PLAN');
  if (removals.length || updates.length) git(repository.root, ['update-index', '-z', '--index-info'], { env: sandbox.env, input: Buffer.concat([...removals, ...updates]) });
  return git(repository.root, ['write-tree'], { env: sandbox.env }).toString('ascii').trim();
}

interface TreeEntry { mode: string; type: string; oid: string; path: string }
export interface SnapshotOptions { mode?: 'full' | 'analysis' | 'fast'; files?: FileChange[]; warnings?: Evidence[] }
const sourcePath = /\.[cm]?[jt]sx?$/i;
const configName = /^(?:ts|js)config(?:\.[^/]+)?\.json$/i;
const decoder = new TextDecoder('utf-8', { fatal: true });
function sourceText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return decoder.decode(bytes); } catch (error) { if (error instanceof TypeError) return undefined; throw error; }
}
function packagePaths(files: readonly string[]): string[] {
  const result = new Set<string>();
  for (const file of files) {
    let folder = posix.dirname(file);
    for (;;) { result.add(posix.join(folder, 'package.json')); if (folder === '.') break; folder = posix.dirname(folder); }
  }
  return [...result];
}
function importPaths(file: string, module: string): string[] {
  if (!module.startsWith('.')) return [];
  const target = posix.normalize(posix.join(posix.dirname(file), module)), withoutJs = target.replace(/\.[cm]?jsx?$/, '');
  return [...new Set([target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.d.ts'].map(extension => withoutJs + extension)])]
    .filter(candidate => candidate !== '.' && candidate !== '..' && !candidate.startsWith('../') && !candidate.startsWith('/') && !candidate.includes('\\') && !candidate.includes('\0') && !candidate.split('/').some(part => part.toLowerCase() === '.git'));
}
function selectEntries(repository: Repository, tree: string, sandbox: GitSandbox | undefined, reader: GitObjectReader, options: SnapshotOptions): TreeEntry[] {
  if (options.mode === 'fast') {
    if (!options.files) throw new SlicerError('Fast snapshot selection requires the changed-file list.', 'INVALID_SNAPSHOT');
    const paths = [...new Set(options.files.flatMap(file => [file.oldPath, file.newPath]).filter((file): file is string => !!file))];
    const selected = new Map(treeEntries(repository, tree, sandbox, [...paths, ...packagePaths(paths)]).map(entry => [entry.path, entry]));
    const sources = [...selected.values()].filter(entry => sourcePath.test(entry.path) && entry.type === 'blob' && entry.mode !== '120000');
    const metadata = reader.inspect(sources.map(entry => entry.oid)), candidates = new Set<string>();
    for (const entry of sources) {
      if (metadata.get(entry.oid)!.size > MAX_BLOB_BYTES) continue;
      const text = sourceText(reader.read(entry.oid, MAX_BLOB_BYTES)); if (text === undefined) continue;
      for (const reference of ts.preProcessFile(text, true, true).importedFiles) for (const candidate of importPaths(entry.path, reference.fileName)) candidates.add(candidate);
    }
    for (const entry of treeEntries(repository, tree, sandbox, [...candidates])) selected.set(entry.path, entry);
    return [...selected.values()];
  }
  const entries = treeEntries(repository, tree, sandbox);
  if (options.mode !== 'analysis') return entries;
  const all = new Map(entries.map(entry => [entry.path, entry])), selected = new Map(entries.filter(entry => sourcePath.test(entry.path) || /\.json$/i.test(entry.path)).map(entry => [entry.path, entry]));
  const queue = [...selected.values()].filter(entry => configName.test(posix.basename(entry.path))), parsed = new Set<string>();
  const include = (name: string): TreeEntry | undefined => {
    const entry = all.get(posix.normalize(name));
    if (entry) selected.set(entry.path, entry);
    return entry;
  };
  while (queue.length) {
    const entry = queue.shift()!;
    if (parsed.has(entry.path) || entry.type !== 'blob' || entry.mode === '120000') continue;
    parsed.add(entry.path);
    if (reader.inspect([entry.oid]).get(entry.oid)!.size > MAX_BLOB_BYTES) continue;
    const text = sourceText(reader.read(entry.oid, MAX_BLOB_BYTES)); if (text === undefined) continue;
    const input = ts.parseConfigFileTextToJson(entry.path, text);
    if (input.error || !input.config || typeof input.config !== 'object') continue;
    const extended = typeof input.config.extends === 'string' ? [input.config.extends] : Array.isArray(input.config.extends) ? input.config.extends : [];
    const references = Array.isArray(input.config.references) ? input.config.references.filter((item: unknown): item is { path: string } => !!item && typeof item === 'object' && 'path' in item && typeof item.path === 'string').map((item: { path: string }) => item.path) : [];
    for (const item of [...extended.map((name: unknown) => ({ name, local: false })), ...references.map((name: string) => ({ name, local: true }))]) {
      if (typeof item.name !== 'string') continue;
      const name = item.name.replace(/\\/g, '/');
      if (posix.isAbsolute(name) || name.includes('\0')) continue;
      const candidates: string[] = [];
      if (item.local || name.startsWith('.')) candidates.push(posix.join(posix.dirname(entry.path), name));
      else {
        let folder = posix.dirname(entry.path);
        for (;;) { candidates.push(posix.join(folder, 'node_modules', name)); if (folder === '.') break; folder = posix.dirname(folder); }
      }
      for (const candidate of candidates) {
        const found = [candidate, candidate + '.json'].map(include).find(Boolean);
        if (found) { queue.push(found); break; }
        const manifest = all.get(posix.join(candidate, 'package.json'));
        if (manifest?.type === 'blob' && manifest.mode !== '120000' && reader.inspect([manifest.oid]).get(manifest.oid)!.size <= MAX_BLOB_BYTES) {
          const content = sourceText(reader.read(manifest.oid, MAX_BLOB_BYTES));
          if (content !== undefined) {
            const parsedManifest = ts.parseConfigFileTextToJson(manifest.path, content);
            if (!parsedManifest.error && typeof parsedManifest.config?.tsconfig === 'string') { const config = include(posix.join(candidate, parsedManifest.config.tsconfig)); if (config) { queue.push(config); break; } }
          }
        }
        const defaultConfig = include(posix.join(candidate, 'tsconfig.json')); if (defaultConfig) { queue.push(defaultConfig); break; }
      }
    }
  }
  return [...selected.values()];
}
function treeEntries(repository: Repository, treeOrCommit: string, sandbox?: GitSandbox, paths?: string[]): TreeEntry[] {
  const selected = paths ? new Set(paths.map(validateGitPath)) : undefined, chunks: string[][] = [];
  if (selected?.size === 0) return [];
  const caseSensitive = ts.sys.useCaseSensitiveFileNames, literal = selected && caseSensitive;
  const folded = selected && !caseSensitive ? new Set([...selected].map(path => path.toLowerCase())) : undefined;
  if (literal) {
    let chunk: string[] = [], bytes = 0;
    for (const path of selected) {
      const size = Buffer.byteLength(path) + 1;
      if (size > 16 * 1024) throw new SlicerError('Snapshot path exceeds the 16-KiB argument limit.', 'INVALID_SNAPSHOT');
      if (chunk.length && (chunk.length >= 128 || bytes + size > 16 * 1024)) { chunks.push(chunk); chunk = []; bytes = 0; }
      chunk.push(path); bytes += size;
    }
    if (chunk.length) chunks.push(chunk);
  } else chunks.push([]);
  const raw = Buffer.concat(chunks.map(chunk => git(repository.root, ['--literal-pathspecs', 'ls-tree', ...(literal ? [] : ['-r']), '-z', '--full-tree', treeOrCommit, '--', ...chunk], { env: sandbox?.env }))), result: TreeEntry[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 0) continue;
    const entry = raw.subarray(start, index), tab = entry.indexOf(9); start = index + 1;
    const metadata = /^(\d{6}) (blob|commit|tree) ([a-f0-9]+)$/.exec(entry.subarray(0, tab).toString('ascii'));
    if (tab < 0 || !metadata) throw new SlicerError('Malformed Git tree entry.', 'INVALID_TREE');
    let path: string;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(entry.subarray(tab + 1)); } catch { throw new SlicerError('Git filenames must be valid UTF-8.', 'UNSUPPORTED_PATH'); }
    validateGitPath(path);
    const [, mode, type, oid] = metadata;
    if (type === 'tree' || selected && !(folded ? folded.has(path.toLowerCase()) : selected.has(path))) continue;
    result.push({ mode, type, oid, path });
  }
  if (start !== raw.length) throw new SlicerError('Truncated Git tree entry.', 'INVALID_TREE');
  return result;
}
function writeSnapshotBlob(repository: Repository, entry: TreeEntry, root: string, sandbox: GitSandbox | undefined, bytes?: Buffer, size?: number): void {
  const target = safePath(root, entry.path); mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) throw new SlicerError('Snapshot contains a duplicate path.', 'INVALID_TREE');
  const mode = entry.mode === '100755' ? 0o755 : 0o644;
  if (bytes) writeFileSync(target, bytes, { flag: 'wx', mode });
  else {
    const descriptor = openSync(target, 'wx', mode);
    try {
      git(repository.root, ['cat-file', 'blob', entry.oid], { env: sandbox?.env, outputFd: descriptor, maxBuffer: 64 * 1024 });
      if (fstatSync(descriptor).size !== size) throw new SlicerError('Streamed snapshot blob size differs from Git metadata.', 'GIT_OBJECT_ERROR');
    } catch (error) { closeSync(descriptor); rmSync(target, { force: true }); throw error; }
    closeSync(descriptor);
  }
  chmodSync(target, mode);
}

/** Regular files only. Symlinks/gitlinks stay in Git trees and are never followed. */
export function exportSnapshot(repository: Repository, treeOrCommit: string, destination: string, sandbox?: GitSandbox, options: SnapshotOptions = {}): void {
  mkdirSync(destination, { recursive: true });
  const root = realpathSync(destination);
  if (readdirSync(root).length) throw new SlicerError('Snapshot destination must be empty.', 'INVALID_SNAPSHOT');
  const reader = sandbox?.objects ?? new GitObjectReader(repository.root, sandbox?.env), byOid = new Map<string, TreeEntry[]>();
  const entries = selectEntries(repository, treeOrCommit, sandbox, reader, options).filter(entry => entry.mode !== '120000' && entry.type !== 'commit');
  for (const entry of entries) { const paths = byOid.get(entry.oid) ?? []; paths.push(entry); byOid.set(entry.oid, paths); }
  const metadata = reader.inspect([...byOid.keys()]), buffered: string[] = [];
  for (const [oid, paths] of byOid) {
    const info = metadata.get(oid)!;
    if (info.type !== 'blob') throw new SlicerError('Snapshot entry does not reference a blob.', 'INVALID_TREE');
    if (info.size <= MAX_BLOB_BYTES) buffered.push(oid);
    else if (options.mode === 'analysis' || options.mode === 'fast') for (const entry of paths) options.warnings?.push(oversizedBlobWarning(oid, info.size, entry.path));
    else for (const entry of paths) writeSnapshotBlob(repository, entry, root, sandbox, undefined, info.size);
  }
  reader.readMany(buffered, (oid, bytes) => { for (const entry of byOid.get(oid)!) writeSnapshotBlob(repository, entry, root, sandbox, bytes); }, MAX_BLOB_BYTES);
}

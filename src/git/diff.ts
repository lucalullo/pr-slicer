import { id } from '../core/hashing.js';
import { SlicerError } from '../core/errors.js';
import { validateGitPath } from '../core/paths.js';
import type { DiffHunk, Evidence, FileChange, Repository } from '../core/model.js';
import { git } from './runner.js';
import { GitObjectReader, MAX_BATCH_BYTES, MAX_BLOB_BYTES, oversizedBlobWarning } from './objects.js';

const MAX_TEXT_BYTES = MAX_BLOB_BYTES;
const decoder = new TextDecoder('utf-8', { fatal: true });
export function readBlob(repository: Repository, oid: string, reader = new GitObjectReader(repository.root)): Buffer { return reader.read(oid, MAX_BLOB_BYTES); }
function textBlob(bytes: Buffer): string | null {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try { return decoder.decode(bytes); } catch { return null; }
}
export function byteLines(bytes: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) { result.push(bytes.subarray(start, index + 1)); start = index + 1; }
  if (start < bytes.length) result.push(bytes.subarray(start));
  return result;
}

/** Body strings retain CR; the Git no-final-newline marker preserves the final byte. */
export function parseHunks(patch: string, oldPath: string, newPath: string, fileId: string): DiffHunk[] {
  const result: DiffHunk[] = []; let current: DiffHunk | undefined;
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = { id: id('h', [fileId, result.length, match[0]]), oldPath, newPath, oldRange: { start: +match[1], count: match[2] === undefined ? 1 : +match[2] }, newRange: { start: +match[3], count: match[4] === undefined ? 1 : +match[4] }, lines: [], binary: false };
      result.push(current);
    } else if (current && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')) current.lines.push(line);
  }
  return result;
}

function rawPath(bytes: Buffer): string {
  let path: string;
  try { path = decoder.decode(bytes); } catch { throw new SlicerError('Git filenames must be valid UTF-8 for portable JSON plans.', 'UNSUPPORTED_PATH'); }
  return validateGitPath(path);
}

export function readChanges(repository: Repository, reader = new GitObjectReader(repository.root), warnings: Evidence[] = []): FileChange[] {
  const raw = git(repository.root, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', repository.mergeBaseOid, repository.headOid, '--']);
  const fields: Buffer[] = []; let start = 0;
  for (let index = 0; index < raw.length; index++) if (raw[index] === 0) { fields.push(raw.subarray(start, index)); start = index + 1; }
  const stats = new Map<string, [number, number]>();
  const numstat = git(repository.root, ['diff', '--numstat', '-z', '--find-renames=50%', '--no-ext-diff', '--no-textconv', repository.mergeBaseOid, repository.headOid, '--']).toString('utf8').split('\0');
  for (let i = 0; i < numstat.length; i++) {
    if (!numstat[i]) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numstat[i]);
    if (!match) throw new SlicerError('Malformed Git numstat.', 'INVALID_DIFF');
    let name = match[3]; if (!name) { i++; name = numstat[++i]; }
    stats.set(name, [match[1] === '-' ? 0 : Number(match[1]), match[2] === '-' ? 0 : Number(match[2])]);
  }
  const requested = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const metadata = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(fields[index++].toString('ascii'));
    if (!metadata) throw new SlicerError('Malformed Git raw diff.', 'INVALID_DIFF');
    index += metadata[5] === 'R' || metadata[5] === 'C' ? 2 : 1;
    if (!['000000', '160000'].includes(metadata[1])) requested.add(metadata[3]); if (!['000000', '160000'].includes(metadata[2])) requested.add(metadata[4]);
  }
  const objectInfo = reader.inspect([...requested]);
  if ([...objectInfo.values()].some(info => info.type !== 'blob')) throw new SlicerError('Git diff entry does not reference a blob.', 'INVALID_DIFF');
  const primeWindow = (from: number): number => {
    const oids = new Set<string>(); let bytes = 0, cursor = from, count = 0;
    while (cursor < fields.length && count < 256) {
      const metadata = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(fields[cursor].toString('ascii'))!;
      const pair = [[metadata[1], metadata[3]], [metadata[2], metadata[4]]].filter(([mode, oid]) => !['000000', '160000'].includes(mode) && objectInfo.get(oid)!.size <= MAX_BLOB_BYTES).map(([, oid]) => oid);
      const additional = [...new Set(pair)].filter(oid => !oids.has(oid)).reduce((total, oid) => total + objectInfo.get(oid)!.size, 0);
      if (count && bytes + additional > MAX_BATCH_BYTES) break;
      for (const oid of pair) oids.add(oid);
      bytes += additional; cursor += metadata[5] === 'R' || metadata[5] === 'C' ? 3 : 2; count++;
    }
    reader.readMany([...oids], () => {}, MAX_BLOB_BYTES); return cursor;
  };
  let bufferedThrough = -1;
  const changes: FileChange[] = [];
  for (let index = 0; index < fields.length;) {
    if (index >= bufferedThrough) bufferedThrough = primeWindow(index);
    const metadata = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])(\d*)$/.exec(fields[index++].toString('ascii'));
    if (!metadata || !fields[index]) throw new SlicerError('Malformed Git raw diff.', 'INVALID_DIFF');
    const [, oldMode, newMode, oldOid, newOid, status, score] = metadata;
    const first = rawPath(fields[index++]);
    const second = status === 'R' || status === 'C' ? rawPath(fields[index++]) : first;
    const oldPath = status === 'A' ? null : first, newPath = status === 'D' ? null : second;
    const fileId = id('f', [oldPath, newPath, oldOid, newOid, oldMode, newMode]);
    const oldSize = oldMode !== '000000' && oldMode !== '160000' ? objectInfo.get(oldOid)!.size : 0;
    const newSize = newMode !== '000000' && newMode !== '160000' ? objectInfo.get(newOid)!.size : 0;
    const oldLarge = oldSize > MAX_BLOB_BYTES, newLarge = newSize > MAX_BLOB_BYTES;
    if (oldLarge) warnings.push(oversizedBlobWarning(oldOid, oldSize, oldPath!));
    if (newLarge) warnings.push(oversizedBlobWarning(newOid, newSize, newPath!));
    const oldBytes = oldMode !== '000000' && oldMode !== '160000' && !oldLarge ? readBlob(repository, oldOid, reader) : Buffer.alloc(0);
    const newBytes = newMode !== '000000' && newMode !== '160000' && !newLarge ? readBlob(repository, newOid, reader) : Buffer.alloc(0);
    const oldText = oldLarge ? null : textBlob(oldBytes), newText = newLarge ? null : textBlob(newBytes);
    let binary = oldText === null || newText === null;
    let atomic = status !== 'M' || oldMode !== newMode || oldMode === '120000' || oldMode === '160000' || binary;
    let hunks: DiffHunk[] = [];
    if (!atomic && oldPath && newPath) {
      const patch = git(repository.root, ['diff', '--patch', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic', repository.mergeBaseOid, repository.headOid, '--', `:(literal)${newPath}`]).toString('utf8');
      hunks = parseHunks(patch, oldPath, newPath, fileId);
      if (!hunks.length) { atomic = true; binary = /GIT binary patch|Binary files /.test(patch) || binary; }
    }
    const [addedLines, deletedLines] = stats.get(newPath ?? oldPath!) ?? [0, 0];
    if (atomic) hunks = [{ id: id('h', [fileId, 'atomic']), oldPath, newPath, oldRange: { start: oldSize ? 1 : 0, count: deletedLines }, newRange: { start: newSize ? 1 : 0, count: addedLines }, lines: [], binary }];
    const changeKind = status === 'R' || status === 'C' ? 'rename' : status === 'A' ? 'add' : status === 'D' ? 'delete' : binary ? 'binary' : oldMode !== newMode ? 'mode-change' : 'modify';
    changes.push({ id: fileId, oldPath, newPath, oldOid, newOid, oldMode, newMode, changeKind, hunks, atomic, addedLines, deletedLines, ...(score ? { renameScore: +score } : {}) });
  }
  return changes;
}

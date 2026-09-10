import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Repository } from '../core/model.js';
import { SlicerError } from '../core/errors.js';
import { git } from '../git/runner.js';

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

function readObject(file: string, oid: string, algorithm: string): { type: string; content: Buffer } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new SlicerError('Isolated Git object is not a regular file.', 'INTEGRITY_ERROR');
  if (stat.size > MAX_OBJECT_BYTES) throw new SlicerError('Git object exceeds the 256 MiB safety limit.', 'OBJECT_TOO_LARGE');
  const compressed = fs.readFileSync(file);
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try { inflated = inflateSync(compressed, { maxOutputLength: MAX_OBJECT_BYTES, info: true }) as unknown as typeof inflated; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new SlicerError('Git object exceeds the 256 MiB safety limit.', 'OBJECT_TOO_LARGE'); throw error; }
  if (inflated.engine.bytesWritten !== compressed.length) throw new SlicerError('Unexpected trailing data in a compressed Git object.', 'INTEGRITY_ERROR');
  const raw = inflated.buffer, end = raw.indexOf(0);
  const header = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(raw.subarray(0, end).toString('utf8'));
  if (end < 0 || !header || !Number.isSafeInteger(Number(header[2])) || Number(header[2]) !== raw.length - end - 1 || createHash(algorithm).update(raw).digest('hex') !== oid) throw new SlicerError(`Git object does not match its expected object ID: ${oid}`, 'INTEGRITY_ERROR');
  return { type: header[1], content: raw.subarray(end + 1) };
}

/** Git writes only in private same-filesystem staging; atomic hard links publish complete objects without overwriting a concurrent writer. */
export function persistObjects(repository: Repository, source: string): void {
  const destination = path.join(repository.commonDir, 'objects');
  const length = repository.objectFormat === 'sha1' ? 40 : repository.objectFormat === 'sha256' ? 64 : 0;
  if (!length) throw new SlicerError('Unsupported Git object format.', 'INTEGRITY_ERROR');
  const stage = fs.mkdtempSync(path.join(destination, 'tmp_pr_slicer_'));
  try {
    for (const folder of fs.readdirSync(source).sort()) {
      if (!/^[a-f0-9]{2}$/.test(folder)) continue;
      const sourceFolder = path.join(source, folder);
      if (!fs.lstatSync(sourceFolder).isDirectory()) throw new SlicerError('Unexpected object directory in isolated Git storage.', 'INTEGRITY_ERROR');
      for (const file of fs.readdirSync(sourceFolder).sort()) {
        if (!new RegExp(`^[a-f0-9]{${length - 2}}$`).test(file)) throw new SlicerError('Unexpected object filename in isolated Git storage.', 'INTEGRITY_ERROR');
        const oid = folder + file, object = readObject(path.join(sourceFolder, file), oid, repository.objectFormat);
        const targetFolder = path.join(destination, folder), target = path.join(targetFolder, file);
        fs.mkdirSync(targetFolder, { recursive: true });
        if (!fs.lstatSync(targetFolder).isDirectory()) throw new SlicerError('Git object destination is not a regular directory.', 'INTEGRITY_ERROR');
        if (fs.existsSync(target)) { readObject(target, oid, repository.objectFormat); continue; }
        const result = git(repository.root, ['-c', 'core.fsync=loose-object', '-c', 'core.fsyncMethod=fsync', 'hash-object', '-w', '-t', object.type, '--stdin'], { input: object.content, env: { GIT_OBJECT_DIRECTORY: stage } }).toString('ascii');
        if (result !== `${oid}\n`) throw new SlicerError(`Git wrote an unexpected object ID instead of ${oid}.`, 'INTEGRITY_ERROR');
        const staged = path.join(stage, folder, file); readObject(staged, oid, repository.objectFormat);
        try { fs.linkSync(staged, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          readObject(target, oid, repository.objectFormat);
        }
      }
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

import { SlicerError } from '../core/errors.js';
import { git } from './runner.js';
import type { Evidence } from '../core/model.js';

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024 * 1024 - 8192;
const CACHE_BYTES = 32 * 1024 * 1024;
const METADATA_ENTRIES = 16_384;
export interface ObjectMetadata { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; size: number }
export function oversizedBlobWarning(oid: string, size: number, path: string): Evidence {
  return { type: 'oversized-blob', message: `Blob exceeds the ${MAX_BLOB_BYTES}-byte analysis limit; its Git content is preserved atomically.`, paths: [path], details: { oid, sizeBytes: size, maxBytes: MAX_BLOB_BYTES } };
}
type ExecuteGit = typeof git;

/** Synchronous, finite batches: no persistent child, unbounded pipe, or cross-run cache. */
export class GitObjectReader {
  private readonly metadataCache = new Map<string, ObjectMetadata>();
  private readonly contentCache = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly repo: string, private readonly env: NodeJS.ProcessEnv = {}, private readonly execute: ExecuteGit = git, private readonly cacheLimit = CACHE_BYTES) {
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0 || cacheLimit > CACHE_BYTES) throw new SlicerError('Invalid object cache byte limit.', 'INVALID_INPUT');
  }
  get cachedBytes(): number { return this.bytes; }
  clear(): void { this.metadataCache.clear(); this.contentCache.clear(); this.bytes = 0; }
  private validateOid(oid: string): void {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new SlicerError('Batch object requests require full hexadecimal object IDs.', 'GIT_OBJECT_ERROR');
  }
  inspect(oids: readonly string[]): Map<string, ObjectMetadata> {
    const unique = [...new Set(oids)], result = new Map<string, ObjectMetadata>(), pending: string[] = [];
    for (const oid of unique) { this.validateOid(oid); const cached = this.metadataCache.get(oid); if (cached) result.set(oid, cached); else pending.push(oid); }
    for (let offset = 0; offset < pending.length; offset += 1024) {
      const requested = pending.slice(offset, offset + 1024);
      const output = this.execute(this.repo, ['cat-file', '--batch-check'], { env: this.env, input: `${requested.join('\n')}\n`, maxBuffer: 128 * 1024 });
      const lines = output.toString('ascii').split('\n');
      if (lines.pop() !== '' || lines.length !== requested.length) throw new SlicerError('Truncated or extra Git batch metadata response.', 'GIT_OBJECT_ERROR');
      for (const [index, line] of lines.entries()) {
        if (line === `${requested[index]} missing`) throw new SlicerError(`Git object ${requested[index]} does not exist.`, 'GIT_OBJECT_ERROR');
        const match = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(line);
        if (!match || match[1] !== requested[index] || !Number.isSafeInteger(Number(match[3]))) throw new SlicerError('Invalid or mismatched Git batch metadata response.', 'GIT_OBJECT_ERROR');
        const metadata: ObjectMetadata = { oid: match[1], type: match[2] as ObjectMetadata['type'], size: Number(match[3]) };
        result.set(metadata.oid, metadata); this.metadataCache.set(metadata.oid, metadata);
        while (this.metadataCache.size > METADATA_ENTRIES) this.metadataCache.delete(this.metadataCache.keys().next().value!);
      }
    }
    return result;
  }
  private cached(oid: string): Buffer | undefined {
    const bytes = this.contentCache.get(oid);
    if (bytes) { this.contentCache.delete(oid); this.contentCache.set(oid, bytes); }
    return bytes;
  }
  private remember(oid: string, bytes: Buffer): void {
    if (bytes.length > this.cacheLimit) return;
    while (this.contentCache.size && (this.bytes + bytes.length > this.cacheLimit || this.contentCache.size >= METADATA_ENTRIES)) {
      const oldest = this.contentCache.keys().next().value!;
      this.bytes -= this.contentCache.get(oldest)!.length; this.contentCache.delete(oldest);
    }
    // Copy the slice so a small cached object cannot retain an entire batch response.
    const copy = Buffer.from(bytes); this.contentCache.set(oid, copy); this.bytes += copy.length;
  }
  readMany(oids: readonly string[], consume: (oid: string, bytes: Buffer) => void, maxBytes = MAX_READ_BYTES): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) throw new SlicerError('Invalid maximum object read size.', 'INVALID_INPUT');
    const unique = [...new Set(oids)], metadata = this.inspect(unique);
    for (const oid of unique) {
      const info = metadata.get(oid)!;
      if (info.type !== 'blob') throw new SlicerError(`Git object ${oid} is not a blob.`, 'GIT_OBJECT_ERROR');
      if (info.size > maxBytes) throw new SlicerError(`Git blob ${oid} has ${info.size} bytes, exceeding the ${maxBytes}-byte read limit.`, 'OVERSIZED_BLOB');
    }
    let pending: string[] = [], batchBytes = 0;
    const flush = (): void => {
      if (!pending.length) return;
      const output = this.execute(this.repo, ['cat-file', '--batch'], { env: this.env, input: `${pending.join('\n')}\n`, maxBuffer: batchBytes + pending.length * 128 + 1 });
      let offset = 0; const payloads: { oid: string; bytes: Buffer }[] = [];
      for (const oid of pending) {
        const newline = output.indexOf(10, offset);
        if (newline < 0) throw new SlicerError('Truncated Git batch content header.', 'GIT_OBJECT_ERROR');
        const match = /^([a-f0-9]+) blob (\d+)$/.exec(output.subarray(offset, newline).toString('ascii')), info = metadata.get(oid)!;
        if (!match || match[1] !== oid || Number(match[2]) !== info.size) throw new SlicerError('Invalid or mismatched Git batch content header.', 'GIT_OBJECT_ERROR');
        offset = newline + 1;
        if (offset + info.size >= output.length || output[offset + info.size] !== 10) throw new SlicerError('Truncated or malformed Git batch blob payload.', 'GIT_OBJECT_ERROR');
        const bytes = output.subarray(offset, offset + info.size); offset += info.size + 1;
        payloads.push({ oid, bytes });
      }
      if (offset !== output.length) throw new SlicerError('Unexpected trailing Git batch content.', 'GIT_OBJECT_ERROR');
      for (const { oid, bytes } of payloads) { this.remember(oid, bytes); consume(oid, bytes); }
      pending = []; batchBytes = 0;
    };
    for (const oid of unique) {
      const bytes = this.cached(oid);
      if (bytes) { flush(); consume(oid, bytes); continue; }
      const size = metadata.get(oid)!.size;
      if (pending.length && (batchBytes + size > MAX_BATCH_BYTES || pending.length >= 1024)) flush();
      pending.push(oid); batchBytes += size;
    }
    flush();
  }
  read(oid: string, maxBytes = MAX_READ_BYTES): Buffer {
    let result: Buffer | undefined;
    this.readMany([oid], (_oid, bytes) => { result = Buffer.from(bytes); }, maxBytes);
    return result!;
  }
}

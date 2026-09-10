import { createHash } from 'node:crypto';
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
export function id(prefix: string, value: unknown): string { return `${prefix}_${hash(value).slice(0, 16)}`; }
export function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

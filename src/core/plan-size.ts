import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { SlicerError } from './errors.js';

export const MAX_PLAN_BYTES = 100 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const invalid = (path: string, reason: string): never => { throw new SlicerError(`Piano non valido: ${path}: ${reason}`, 'INVALID_PLAN'); };
const limitError = (limit: number): never => { throw new SlicerError(`Piano oltre il limite di ${limit} byte (${limit / 1024 / 1024} MiB).`, 'PLAN_TOO_LARGE'); };
function validLimit(limit: number): void { if (!Number.isSafeInteger(limit) || limit < 1) throw new SlicerError('Il limite del piano deve essere un intero positivo.', 'INVALID_INPUT'); }

/** Count the exact UTF-8 size of pretty JSON plus LF without allocating that JSON. */
export function assertPlanSize(value: unknown, maxBytes = MAX_PLAN_BYTES): void {
  validLimit(maxBytes);
  let bytes = 1;
  const ancestors = new Set<object>();
  const add = (count: number): void => { bytes += count; if (bytes > maxBytes) limitError(maxBytes); };
  const textSize = (value: string): number => {
    if (value.length > maxBytes) limitError(maxBytes);
    let length = 2; // JSON quotation marks; count escaping without an escaped string copy.
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92) length += 2;
      else if (code < 32) length += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code < 128) length++;
      else if (code < 2048) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { length += 4; index++; } else length += 6;
      } else length += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
      if (length > maxBytes) limitError(maxBytes);
    }
    return length;
  };
  const visit = (item: unknown, path: string, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) invalid(path, `profondità JSON oltre ${MAX_JSON_DEPTH}`);
    if (item === null) { add(4); return; }
    if (typeof item === 'string') { add(textSize(item)); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(path, 'atteso numero finito'); add(JSON.stringify(item).length); return; }
    if (typeof item !== 'object') invalid(path, 'atteso valore JSON');
    const object = item as object;
    if (ancestors.has(object)) invalid(path, 'riferimento JSON ciclico');
    if (![Array.isArray(object) ? Array.prototype : Object.prototype, null].includes(Object.getPrototypeOf(object))) invalid(path, 'atteso oggetto JSON semplice');
    // JSON.stringify observes toJSON even when it is non-enumerable or inherited.
    for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
      const method = Object.getOwnPropertyDescriptor(current, 'toJSON');
      if (!method) continue;
      if (method.get || method.set || typeof method.value === 'function') invalid(`${path}.toJSON`, 'metodo/accessor JSON non consentito');
      break;
    }
    if (Object.getOwnPropertySymbols(object).length) invalid(path, 'chiavi simboliche non consentite');
    ancestors.add(object);
    const entries: [string, unknown][] = [];
    for (const key of Object.getOwnPropertyNames(object)) {
      if (Array.isArray(object) && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(object, key)!;
      if (property.get || property.set) invalid(`${path}[${JSON.stringify(key)}]`, 'accessor non consentito');
      if (!Array.isArray(object) && !property.enumerable) invalid(`${path}[${JSON.stringify(key)}]`, 'proprietà non enumerabile non consentita');
      // Optional undefined object fields are omitted by JSON.stringify (e.g. check evidence).
      if (property.value !== undefined) entries.push([key, property.value]);
    }
    const length = Array.isArray(object) ? object.length : entries.length;
    if (Array.isArray(object) && entries.some(([key]) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= object.length)) invalid(path, 'proprietà non indicizzata della lista');
    if (!length) add(2);
    else {
      add(2 + depth * 2 + length * (depth * 2 + 4));
      if (Array.isArray(object)) {
        for (let index = 0; index < object.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (!descriptor) invalid(`${path}[${index}]`, 'elemento JSON mancante');
          if (descriptor!.get || descriptor!.set) invalid(`${path}[${index}]`, 'accessor non consentito');
          visit(descriptor!.value, `${path}[${index}]`, depth + 1);
        }
      } else for (const [key, child] of entries) { add(textSize(key) + 2); visit(child, /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`, depth + 1); }
    }
    ancestors.delete(object);
  };
  visit(value, '$', 0);
}

export function serializePlan(value: unknown, maxBytes = MAX_PLAN_BYTES): string {
  assertPlanSize(value, maxBytes);
  return JSON.stringify(value, null, 2) + '\n';
}

/** Bound reads even if a file grows after fstat; no full read of an unbounded input. */
export function readPlanJson(file: string, maxBytes = MAX_PLAN_BYTES): unknown {
  validLimit(maxBytes);
  const descriptor = openSync(file, 'r');
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    if (fstatSync(descriptor).size > maxBytes) limitError(maxBytes);
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
      const count = readSync(descriptor, chunk);
      if (!count) break;
      bytes += count; if (bytes > maxBytes) limitError(maxBytes);
      chunks.push(chunk.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new SlicerError('Piano non valido: $: JSON non valido.', 'INVALID_PLAN'); }
}

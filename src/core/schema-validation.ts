import { SlicerError } from './errors.js';
import planSchema from './plan-schema.json' with { type: 'json' };
import configSchema from '../config/schema.json' with { type: 'json' };

type Schema = { $ref?: string; const?: unknown; enum?: unknown[]; type?: string | string[]; additionalProperties?: boolean | Schema; required?: string[]; properties?: Record<string, Schema>; items?: Schema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; minItems?: number; maxItems?: number; uniqueItems?: boolean; $defs?: Record<string, Schema> };
const field = (path: string, key: string): string => /^[A-Za-z_$][\w$]*$/.test(key) ? `${path ? path + '.' : ''}${key}` : `${path}[${JSON.stringify(key)}]`;
export const invalidPlan = (path: string, reason: string): never => { throw new SlicerError(`Piano non valido: ${path || '$'}: ${reason}`, 'INVALID_PLAN'); };

/** The public schemas are authoritative; no independent hand-maintained shape validator. */
export function validatePlanSchema(value: unknown): void {
  const validate = (value: unknown, rule: Schema, path: string, root: Schema): void => {
    if (rule.$ref) {
      const [document, fragment] = rule.$ref.split('#');
      const targetRoot = document === '../config/schema.json' ? configSchema as Schema : !document ? root : undefined;
      if (!targetRoot) throw new Error(`Unsupported schema reference: ${rule.$ref}`);
      let target: unknown = targetRoot;
      for (const token of (fragment ?? '').split('/').filter(Boolean)) target = (target as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (!target || typeof target !== 'object') throw new Error(`Missing schema reference: ${rule.$ref}`);
      validate(value, target as Schema, path, targetRoot);
    }
    const fail = (reason: string): never => invalidPlan(path, reason);
    if (Object.hasOwn(rule, 'const') && value !== rule.const) fail(`atteso ${JSON.stringify(rule.const)}`);
    if (rule.enum && !rule.enum.includes(value)) fail(`valore enum sconosciuto; atteso ${rule.enum.join(', ')}`);
    const types = rule.type ? Array.isArray(rule.type) ? rule.type : [rule.type] : [];
    const matches = (type: string): boolean => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (types.length && !types.some(matches)) fail(`tipo errato; atteso ${types.join(' o ')}`);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('atteso numero finito');
      if (rule.minimum !== undefined && value < rule.minimum) fail(`minimo ${rule.minimum}`);
      if (rule.maximum !== undefined && value > rule.maximum) fail(`massimo ${rule.maximum}`);
    }
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) fail(`lunghezza minima ${rule.minLength}`);
      if (rule.maxLength !== undefined && value.length > rule.maxLength) fail(`lunghezza massima ${rule.maxLength}`);
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail('formato o caratteri di controllo non consentiti');
    }
    if (Array.isArray(value)) {
      if (rule.minItems !== undefined && value.length < rule.minItems) fail(`minimo ${rule.minItems} elementi`);
      if (rule.maxItems !== undefined && value.length > rule.maxItems) fail(`massimo ${rule.maxItems} elementi`);
      const seen = new Set<string>();
      value.forEach((item, index) => {
        if (rule.uniqueItems) { const key = JSON.stringify(item); if (seen.has(key)) invalidPlan(`${path}[${index}]`, 'voce duplicata'); seen.add(key); }
        if (rule.items) validate(item, rule.items, `${path}[${index}]`, root);
      });
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      for (const key of rule.required ?? []) if (!Object.hasOwn(object, key)) invalidPlan(field(path, key), 'campo obbligatorio mancante');
      for (const [key, item] of Object.entries(object)) {
        if (rule.properties && Object.hasOwn(rule.properties, key)) validate(item, rule.properties[key], field(path, key), root);
        else if (rule.additionalProperties === false) invalidPlan(field(path, key), 'campo sconosciuto');
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') validate(item, rule.additionalProperties, `${path}[${JSON.stringify(key)}]`, root);
      }
    }
  };
  validate(value, planSchema as Schema, '', planSchema as Schema);
}

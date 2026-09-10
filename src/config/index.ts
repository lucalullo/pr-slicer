import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { Config } from '../core/model.js';
import { SlicerError } from '../core/errors.js';
import schema from './schema.json' with { type: 'json' };

export const DEFAULT_CONFIG: Config = {
  schemaVersion: 1, base: 'main', head: 'HEAD', language: 'typescript',
  limits: { maxGroups: 5, targetChangedLines: 350, hardMaxChangedLines: 800, targetFiles: 12, hardMaxFiles: 30, maxAnalysisFiles: 1500, maxFileBytes: 2097152 },
  paths: { include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.cjs'], exclude: ['**/dist/**', '**/coverage/**', '**/*.min.js'] },
  relations: { keepTestsWithImplementation: true, testPatterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], generatedPatterns: ['**/*.generated.*', '**/generated/**'], generatedFrom: [] },
  areas: [], checks: [], environment: { inherit: false, allow: ['CI'] }
};
type Schema = { $ref?: string; const?: unknown; type?: string; additionalProperties?: boolean; required?: string[]; properties?: Record<string, Schema>; items?: Schema; minimum?: number; maximum?: number; minLength?: number; pattern?: string };
function validate(value: unknown, rule: Schema, path: string): void {
  if (rule.$ref) rule = (schema.$defs as Record<string, Schema>)[rule.$ref.split('/').pop()!];
  const fail = (reason: string): never => { throw new SlicerError(`Configurazione ${path}: ${reason}`); };
  if ('const' in rule && value !== rule.const) fail(`atteso ${JSON.stringify(rule.const)}`);
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('atteso oggetto');
    const obj = value as Record<string, unknown>;
    for (const key of rule.required ?? []) if (!(key in obj)) fail(`campo obbligatorio ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      if (!rule.properties || !Object.hasOwn(rule.properties, key)) { if (rule.additionalProperties === false) fail(`campo sconosciuto ${key}`); }
      else validate(v, rule.properties[key], `${path}.${key}`);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) fail('attesa lista');
    (value as unknown[]).forEach((v, i) => validate(v, rule.items!, `${path}[${i}]`));
  } else if (rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('atteso intero');
    if (rule.minimum !== undefined && (value as number) < rule.minimum) fail(`minimo ${rule.minimum}`);
    if (rule.maximum !== undefined && (value as number) > rule.maximum) fail(`massimo ${rule.maximum}`);
  } else if (rule.type === 'string') {
    if (typeof value !== 'string') fail('atteso testo');
    if ((value as string).includes('\0')) fail('NUL non consentito');
    if (rule.minLength && (value as string).length < rule.minLength) fail('testo vuoto');
    if (rule.pattern && !new RegExp(rule.pattern).test(value as string)) fail('formato non valido');
  } else if (rule.type === 'boolean' && typeof value !== 'boolean') fail('atteso booleano');
}
export function normalizeConfig(input: unknown = {}): Config {
  validate(input, schema, '$');
  const value = input as Partial<Config>;
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), ...value, limits: { ...DEFAULT_CONFIG.limits, ...value.limits }, paths: { ...DEFAULT_CONFIG.paths, ...value.paths }, relations: { ...DEFAULT_CONFIG.relations, ...value.relations }, environment: { ...DEFAULT_CONFIG.environment, ...value.environment } };
  delete (config as unknown as Record<string, unknown>).$schema;
  if (config.limits.targetChangedLines > config.limits.hardMaxChangedLines) throw new SlicerError('limits.targetChangedLines supera hardMaxChangedLines');
  if (config.limits.targetFiles > config.limits.hardMaxFiles) throw new SlicerError('limits.targetFiles supera hardMaxFiles');
  if (new Set(config.checks.map(c => c.name)).size !== config.checks.length) throw new SlicerError('checks: nomi duplicati');
  config.checks.forEach((check, index) => { if (/[\u0000-\u001f\u007f-\u009f]/.test(check.name)) throw new SlicerError(`Configurazione config.checks[${index}].name: caratteri di controllo non consentiti.`); });
  return config;
}
export function loadConfig(repo: string, file?: string): Config {
  const path = file ? resolve(file) : ['.pr-slicer.json', '.pr-slicer.jsonc'].map(n => resolve(repo, n)).find(existsSync);
  if (!path) return normalizeConfig();
  const result = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (result.error) throw new SlicerError(`Configurazione ${path}: ${ts.flattenDiagnosticMessageText(result.error.messageText, '\n')}`);
  return normalizeConfig(result.config);
}
/** Portable, deliberately small glob syntax: **, *, ?. Paths always use '/'. */
export function matchesGlob(path: string, pattern: string): boolean {
  let rx = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; rx += '(?:.*/)?'; } else rx += '.*'; }
    else if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(rx + '$').test(path);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeChanges, diagnoseSnapshot } from '../../dist/languages/index.js';
import { DEFAULT_CONFIG } from '../../dist/config/index.js';

function fixture(t, before, after) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-slicer-analysis-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const roots = ['base', 'head'].map(name => path.join(directory, name));
  for (const [index, files] of [before, after].entries()) {
    fs.mkdirSync(roots[index], { recursive: true });
    for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(roots[index], name)), { recursive: true }); fs.writeFileSync(path.join(roots[index], name), content); }
  }
  return roots;
}
const lines = text => text ? text.replace(/\n$/, '').split('\n') : [];
function change(file, before, after, ranges) {
  const oldLines = lines(before), newLines = lines(after);
  const hunks = (ranges ?? [{ oldStart: before === undefined ? 0 : 1, oldCount: oldLines.length, newStart: after === undefined ? 0 : 1, newCount: newLines.length }]).map((range, index) => ({ id: `h-${file}-${index}`, oldPath: before === undefined ? null : file, newPath: after === undefined ? null : file, oldRange: { start: range.oldStart, count: range.oldCount }, newRange: { start: range.newStart, count: range.newCount }, lines: [...oldLines.slice(Math.max(0, range.oldStart - 1), Math.max(0, range.oldStart - 1) + range.oldCount).map(line => '-' + line), ...newLines.slice(Math.max(0, range.newStart - 1), Math.max(0, range.newStart - 1) + range.newCount).map(line => '+' + line)], binary: false }));
  return { id: `f-${file}`, oldPath: before === undefined ? null : file, newPath: after === undefined ? null : file, oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40), oldMode: before === undefined ? '000000' : '100644', newMode: after === undefined ? '000000' : '100644', changeKind: before === undefined ? 'add' : after === undefined ? 'delete' : 'modify', hunks, atomic: before === undefined || after === undefined, addedLines: hunks.reduce((n, h) => n + h.lines.filter(line => line.startsWith('+')).length, 0), deletedLines: hunks.reduce((n, h) => n + h.lines.filter(line => line.startsWith('-')).length, 0) };
}
const config = () => structuredClone(DEFAULT_CONFIG);
const project = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, types: [], skipLibCheck: true }, include: ['**/*.ts'] });
function run(roots, changes, mode = 'fast', options = config()) { return analyzeChanges(changes, ...roots, options, mode); }
function hasEdge(result, source, destination, kind, evidenceType) {
  const from = result.units.find(unit => (unit.newPath ?? unit.oldPath) === source)?.id, to = result.units.find(unit => (unit.newPath ?? unit.oldPath) === destination)?.id;
  return result.edges.some(edge => edge.kind === kind && (edge.from === from && edge.to === to || kind !== 'before' && edge.to === from && edge.from === to) && (!evidenceType || edge.evidence.some(evidence => evidence.type === evidenceType)));
}

test('AST merges distant hunks in one function but keeps independent functions separable', t => {
  const before = 'export function one() {\n  const a = 1;\n  const b = 1;\n  return a + b;\n}\n\nexport function two() {\n  return 1;\n}\n';
  const after = before.replace('a = 1', 'a = 2').replace('return a + b', 'return a * b').replace('return 1', 'return 2');
  const ranges = [2, 4, 8].map(line => ({ oldStart: line, oldCount: 1, newStart: line, newCount: 1 }));
  const roots = fixture(t, { 'code.ts': before }, { 'code.ts': after }), result = run(roots, [change('code.ts', before, after, ranges)]);
  assert.equal(result.units.length, 2);
  assert.deepEqual(result.units.map(unit => unit.hunkIds.length).sort(), [1, 2]);
  assert.equal(new Set(result.units.flatMap(unit => unit.hunkIds)).size, 3);
  assert.deepEqual(result, run(roots, [change('code.ts', before, after, ranges)]));
});

test('deep checker resolves a renamed import through tsconfig paths', t => {
  const tsconfig = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', baseUrl: '.', paths: { '@core/*': ['src/*'] }, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] });
  const added = 'export function expired(value: number): boolean { return value < 0; }\n', used = "import { expired as isExpired } from '@core/model';\nexport const active = !isExpired(1);\n";
  const roots = fixture(t, { 'tsconfig.json': tsconfig }, { 'tsconfig.json': tsconfig, 'src/model.ts': added, 'src/use.ts': used });
  const result = run(roots, [change('src/model.ts', undefined, added), change('src/use.ts', undefined, used)], 'deep');
  assert.ok(hasEdge(result, 'src/model.ts', 'src/use.ts', 'before', 'new-symbol-reference'));
});

test('optional parameter extension can precede changed consumers', t => {
  const before = 'export function hello(name: string): string { return name; }\n', after = 'export function hello(name: string, suffix?: string): string { return name + (suffix ?? ""); }\n';
  const oldUse = "import { hello } from './api';\nexport const result = hello('A');\n", newUse = oldUse.replace("hello('A')", "hello('A', '!')");
  const roots = fixture(t, { 'tsconfig.json': project, 'api.ts': before, 'use.ts': oldUse }, { 'tsconfig.json': project, 'api.ts': after, 'use.ts': newUse });
  const result = run(roots, [change('api.ts', before, after), change('use.ts', oldUse, newUse)], 'deep');
  assert.ok(hasEdge(result, 'api.ts', 'use.ts', 'before', 'compatible-signature-change'));
  assert.equal(hasEdge(result, 'api.ts', 'use.ts', 'must_with'), false);
});

test('incompatible signatures retain affected changed call sites', t => {
  const before = 'export function hello(name: string): string { return name; }\n', after = 'export function hello(name: number): string { return String(name); }\n';
  const oldUse = "import { hello } from './api';\nexport const result = hello('A');\n", newUse = oldUse.replace("hello('A')", 'hello(1)');
  const roots = fixture(t, { 'tsconfig.json': project, 'api.ts': before, 'use.ts': oldUse }, { 'tsconfig.json': project, 'api.ts': after, 'use.ts': newUse });
  assert.ok(hasEdge(run(roots, [change('api.ts', before, after), change('use.ts', oldUse, newUse)], 'deep'), 'api.ts', 'use.ts', 'must_with', 'incompatible-signature-change'));
});

test('consumer migration precedes API removal', t => {
  const before = 'export function legacy(): number { return 1; }\n', oldUse = "import { legacy } from './api';\nexport const result = legacy();\n", newUse = 'export const result = 2;\n';
  const roots = fixture(t, { 'tsconfig.json': project, 'api.ts': before, 'use.ts': oldUse }, { 'tsconfig.json': project, 'use.ts': newUse });
  const result = run(roots, [change('api.ts', before, undefined), change('use.ts', oldUse, newUse)], 'deep');
  assert.ok(hasEdge(result, 'use.ts', 'api.ts', 'before', 'removed-symbol-reference'));
});

test('an overload edit is retained even when its implementation signature is unchanged', t => {
  const before = 'export function value(input: string): string;\nexport function value(input: unknown): unknown { return input; }\n', after = before.replace('input: string): string;', 'input: number): number;');
  const oldUse = "import { value } from './api';\nexport const result = value('A');\n", newUse = oldUse.replace("value('A')", 'value(1)');
  const roots = fixture(t, { 'tsconfig.json': project, 'api.ts': before, 'use.ts': oldUse }, { 'tsconfig.json': project, 'api.ts': after, 'use.ts': newUse });
  assert.ok(hasEdge(run(roots, [change('api.ts', before, after), change('use.ts', oldUse, newUse)], 'deep'), 'api.ts', 'use.ts', 'must_with', 'incompatible-signature-change'));
});

test('removing a dependency follows the migration of its imports', t => {
  const beforeManifest = '{"dependencies":{"legacy":"1.0.0"}}\n', afterManifest = '{"dependencies":{}}\n', before = "import { value } from 'legacy';\nexport const result = value();\n", after = 'export const result = 1;\n';
  const roots = fixture(t, { 'package.json': beforeManifest, 'use.ts': before }, { 'package.json': afterManifest, 'use.ts': after });
  const result = run(roots, [change('package.json', beforeManifest, afterManifest), change('use.ts', before, after)]);
  assert.ok(hasEdge(result, 'use.ts', 'package.json', 'before', 'removed-package-dependency'));
});

test('new optional interface property is not mislabeled as a new interface', t => {
  const before = 'export interface Session {\n  id: string;\n}\n', after = 'export interface Session {\n  id: string;\n  expiresAt?: number;\n}\n';
  const oldUse = "import { Session } from './types';\nexport const session: Session = { id: '1' };\n", newUse = oldUse.replace("id: '1'", "id: '1', expiresAt: 1");
  const roots = fixture(t, { 'tsconfig.json': project, 'types.ts': before, 'use.ts': oldUse }, { 'tsconfig.json': project, 'types.ts': after, 'use.ts': newUse });
  const result = run(roots, [change('types.ts', before, after, [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1 }]), change('use.ts', oldUse, newUse)], 'deep');
  assert.ok(hasEdge(result, 'types.ts', 'use.ts', 'before', 'compatible-signature-change'));
  assert.equal(result.edges.some(edge => edge.evidence.some(evidence => evidence.type === 'new-symbol-reference' && evidence.symbol === 'types.ts#Session')), false);
});

test('excluded and generated files stay atomic, with configured source coupling', t => {
  const before = { 'src.ts': 'export const x = 1;\n', 'generated/output.ts': 'export const x = 1;\n', 'dist/code.js': 'const x = 1;\n' }, after = Object.fromEntries(Object.entries(before).map(([name, text]) => [name, text.replace('1', '2')]));
  const options = config(); options.relations.generatedFrom = [{ source: 'src.ts', generated: ['generated/**'] }];
  const result = run(fixture(t, before, after), Object.keys(before).map(file => change(file, before[file], after[file])), 'fast', options);
  assert.equal(result.units.length, 3);
  assert.ok(result.units.find(unit => unit.newPath === 'dist/code.js').isAtomic);
  assert.ok(result.units.find(unit => unit.newPath === 'generated/output.ts').isGenerated);
  assert.ok(hasEdge(result, 'src.ts', 'generated/output.ts', 'must_with', 'generated-from'));
});

test('diagnostics distinguish successful syntax, unavailable types and broken source', t => {
  const [good, bad] = fixture(t, { 'code.ts': 'export const x = 1;\n' }, { 'code.ts': 'export const = ;\n' });
  const valid = diagnoseSnapshot(good, true), invalid = diagnoseSnapshot(bad, true);
  assert.equal(valid.syntax.status, 'passed'); assert.equal(valid.semantic.status, 'unavailable'); assert.equal(invalid.syntax.status, 'failed');
});

test('diagnostics report absent dependencies without claiming typecheck passed', t => {
  const [root] = fixture(t, { 'tsconfig.json': project, 'code.ts': "import { fn } from 'package-that-is-not-installed';\nexport const x = fn();\n" }, {});
  const result = diagnoseSnapshot(root, true);
  assert.equal(result.syntax.status, 'passed'); assert.equal(result.semantic.status, 'unavailable'); assert.match(result.semantic.log, /TS2307/);
});

test('a missing relative module is a failed prefix rather than an unavailable dependency', t => {
  const [root] = fixture(t, { 'tsconfig.json': project, 'code.ts': "import { fn } from './missing';\nexport const x = fn();\n" }, {});
  const result = diagnoseSnapshot(root, true);
  assert.equal(result.syntax.status, 'passed'); assert.equal(result.semantic.status, 'failed'); assert.match(result.semantic.log, /TS2307/);
});

test('compiler does not follow arbitrary source symlinks outside the snapshot', t => {
  const [root, outside] = fixture(t, { 'tsconfig.json': project, 'safe.ts': 'export const value = 1;\n' }, { 'secret.ts': 'THIS_SECRET_MUST_NOT_BE_A_DIAGNOSTIC\n' });
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked.ts'));
  const result = diagnoseSnapshot(root, true);
  assert.equal(result.semantic.status, 'unavailable');
  assert.ok(result.warnings.some(warning => warning.type === 'blocked-access'));
  assert.equal(JSON.stringify(result).includes('THIS_SECRET_MUST_NOT_BE_A_DIAGNOSTIC'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { diagnoseSnapshot } from '../../dist/languages/program.js';
test('built-in diagnostics identify their bundled compiler separately from project commands', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-compiler-version-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], noLib: true }, files: ['a.ts'] }));
  const result = diagnoseSnapshot(root, true);
  for (const check of [result.syntax, result.semantic]) { assert.ok(check.message.includes(ts.version)); assert.match(check.message, /bundled with PR Slicer/); assert.match(check.message, /project's compiler command/); }
});

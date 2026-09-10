import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../fixtures/repository.mjs';
import { createPlan } from '../../dist/index.js';
import { validatePlan } from '../../dist/core/plan.js';

const declaration = 'export const value = 1;\n';
const payloads = [
  ['NUL', Buffer.concat([Buffer.from(declaration), Buffer.from([0])])],
  ['invalid UTF-8 without NUL', Buffer.concat([Buffer.from(declaration), Buffer.from([255])])],
];

for (const [label, bytes] of payloads) for (const kind of ['add', 'delete', 'rename']) {
  test(`${kind} of ${label} TypeScript stays opaque in fast and deep analysis`, t => {
    const f = fixture(t, { 'safe.ts': declaration, ...(kind === 'add' ? {} : { 'before.ts': bytes }) });
    if (kind === 'add') f.write('after.ts', bytes);
    else if (kind === 'delete') fs.unlinkSync(path.join(f.root, 'before.ts'));
    else fs.renameSync(path.join(f.root, 'before.ts'), path.join(f.root, 'after.ts'));
    f.commit();
    const headTree = f.git('rev-parse', 'feature^{tree}');
    for (const mode of ['fast', 'deep']) {
      const plan = createPlan({ repo: f.root, base: 'main', head: 'feature', mode });
      assert.equal(plan.files.length, 1);
      assert.equal(plan.files[0].changeKind, kind);
      assert.ok(plan.files[0].hunks.every(hunk => hunk.binary));
      assert.equal(plan.units.length, 1);
      assert.equal(plan.units[0].isAtomic, true);
      assert.equal(plan.units[0].syntaxKind, 'file');
      assert.deepEqual(plan.units[0].symbolIds, [], `${mode} must not derive symbols from binary source`);
      assert.equal(plan.integrity.finalTreeOid, headTree);
      validatePlan(plan);
    }
    f.git('fsck', '--full', '--strict');
  });
}

test('a valid UTF-8 TypeScript rename still retains its AST symbols', t => {
  const f = fixture(t, { 'before.ts': declaration });
  fs.renameSync(path.join(f.root, 'before.ts'), path.join(f.root, 'after.ts')); f.commit();
  const plan = createPlan({ repo: f.root, base: 'main', head: 'feature', mode: 'fast' });
  assert.equal(plan.files[0].changeKind, 'rename');
  assert.ok(plan.files[0].hunks.every(hunk => !hunk.binary));
  assert.deepEqual(plan.units[0].symbolIds, ['after.ts#value', 'before.ts#value']);
  assert.equal(plan.integrity.finalTreeOid, f.git('rev-parse', 'feature^{tree}'));
});

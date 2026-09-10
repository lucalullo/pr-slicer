import { fixture, tsconfig } from './repository.mjs';
import { createPlan, normalizeConfig, planDigest, markdownReport } from '../../dist/index.js';
export function goldenScenario(t, name) {
  const bases = { 'symbol-chain': { 'tsconfig.json': tsconfig }, 'mixed-files': { 'a.ts': 'export const a=1;\n', 'image.bin': Buffer.from([0,1,255]) }, 'signature-change': { 'tsconfig.json': tsconfig, 'a.ts': 'export function api(x: number) { return x; }\n', 'b.ts': 'import { api } from "./a.js";\nexport const b=api(1);\n' } };
  const f = fixture(t, bases[name]);
  if (name === 'symbol-chain') { f.write('types.ts', 'export interface Model { id: string; }\n'); f.write('consumer.ts', 'import type { Model } from "./types.js";\nexport const consume=(m: Model)=>m.id;\n'); }
  if (name === 'mixed-files') { f.write('a.ts', 'export const a=2;\n'); f.write('image.bin', Buffer.from([0,2,254])); f.write('notes.md', '# New notes\n'); }
  if (name === 'signature-change') { f.write('a.ts', 'export function api(x: string) { return x; }\n'); f.write('b.ts', 'import { api } from "./a.js";\nexport const b=api("ok");\n'); }
  f.commit(); const plan = createPlan({ repo: f.root, base: 'main', head: 'feature', config: normalizeConfig({ limits: { targetChangedLines: 2, hardMaxChangedLines: 100 } }), mode: 'deep' });
  plan.repository.root = '<REPO>'; plan.repository.gitDir = '<REPO>/.git'; plan.repository.commonDir = '<REPO>/.git'; plan.integrity.digest = planDigest(plan);
  return { json: JSON.stringify(plan, null, 2) + '\n', markdown: markdownReport(plan), edges: JSON.stringify(plan.edges, null, 2) + '\n' };
}
export const goldenNames = ['symbol-chain', 'mixed-files', 'signature-change'];

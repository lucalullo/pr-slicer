import { join } from 'node:path';
import type { Config, Evidence, SlicePlan } from './model.js';
import { TOOL_VERSION } from './model.js';
import { planDigest } from './plan.js';
import { assertPlanSize } from './plan-size.js';
import { sanitizePlanDescriptions } from './sanitize.js';
import { SlicerError } from './errors.js';
import { resolveRepository, readChanges, createSandbox, exportSnapshot, reconstructTree } from '../git/index.js';
import { analyzeChanges } from '../languages/index.js';
import { planCandidates } from '../planner/index.js';
import { normalizeConfig } from '../config/index.js';
export function createPlan(options: { repo?: string; base?: string; head?: string; config?: Config; mode?: 'fast' | 'deep' }): SlicePlan {
  const config = normalizeConfig(options.config); const mode = options.mode ?? 'deep';
  const repository = resolveRepository(options.repo ?? '.', options.base ?? config.base, options.head ?? config.head);
  const sandbox = createSandbox(repository);
  try {
    const objectWarnings: Evidence[] = [], files = readChanges(repository, sandbox.objects, objectWarnings);
    const base = join(sandbox.root, 'base'); const head = join(sandbox.root, 'head');
    const snapshot = { mode: mode === 'fast' ? 'fast' as const : 'analysis' as const, files, warnings: objectWarnings };
    exportSnapshot(repository, repository.mergeBaseOid, base, sandbox, snapshot); exportSnapshot(repository, repository.headOid, head, sandbox, snapshot);
    const analysis = analyzeChanges(files, base, head, config, mode); const partition = planCandidates(analysis.units, analysis.edges, config);
    const finalTreeOid = reconstructTree(repository, files, analysis.units, analysis.units.map(u => u.id), sandbox);
    if (finalTreeOid !== repository.headTreeOid) throw new SlicerError('Ricostruzione finale diversa da head: piano rifiutato', 'INVARIANT_FAILED');
    const plan: SlicePlan = {
      schemaVersion: 1, toolVersion: TOOL_VERSION, repository, config, analysisMode: mode, status: partition.status,
      files, units: analysis.units, edges: analysis.edges, groups: partition.groups, candidates: partition.candidates, checks: {}, warnings: [...new Map(objectWarnings.map(warning => [JSON.stringify(warning), warning])).values(), ...analysis.warnings, ...partition.warnings], metrics: partition.metrics,
      verification: { status: 'not-run', level: 'reconstructed', digest: '', trees: [], checks: {}, commandsExecuted: false },
      integrity: { finalTreeOid, exactReconstruction: true, digest: '' }
    };
    if (!files.length) plan.warnings.push({ type: 'empty-diff', message: 'Base e head hanno lo stesso tree: nessuna modifica da dividere.' });
    sanitizePlanDescriptions(plan);
    plan.integrity.digest = '0'.repeat(64); assertPlanSize(plan); plan.integrity.digest = planDigest(plan); return plan;
  } finally { sandbox.cleanup(); }
}

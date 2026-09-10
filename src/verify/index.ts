import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult, Evidence, PlanGroup, SlicePlan } from '../core/model.js';
import { SlicerError } from '../core/errors.js';
import { id } from '../core/hashing.js';
import { planDigest, validatePlan } from '../core/plan.js';
import { assertRefsUnchanged, createSandbox, exportSnapshot, git, reconstructTree } from '../git/index.js';
import { diagnoseSnapshot } from '../languages/index.js';
import { createCheckEnvironment } from './environment.js';
import { runCheck } from './check-runner.js';
import { calculateMetrics } from '../planner/scoring.js';
import { titleFor } from '../planner/titles.js';
import { collapseGraph } from '../graph/graph.js';
import { MAX_SEGMENT_BOUNDARIES } from '../planner/segmenter.js';
import { sanitizePlanDescriptions } from '../core/sanitize.js';
import { assertPlanSize } from '../core/plan-size.js';

export { runCheck, MAX_LOG_BYTES } from './check-runner.js';
export { createCheckEnvironment } from './environment.js';
export interface VerifyOptions { runChecks?: boolean; semantic?: boolean; nodeModules?: string; repair?: boolean }

function mergeFollowing(plan: SlicePlan, index: number): string[] {
  const left = plan.groups[index], right = plan.groups[index + 1], removed = [left.id, right.id];
  const title = `${left.title} + ${right.title}`, members = new Set([...left.unitIds, ...right.unitIds]);
  const merged: PlanGroup = { id: id('slice', [...left.unitIds, ...right.unitIds]), title: title.length <= 1000 ? title : `${titleFor(plan.units.filter(unit => members.has(unit.id)))} [${members.size} unità]`, unitIds: [...left.unitIds, ...right.unitIds], dependsOn: [...new Set([...left.dependsOn, ...right.dependsOn])].filter(dep => !removed.includes(dep)), files: [...new Set([...left.files, ...right.files])].sort(), addedLines: left.addedLines + right.addedLines, deletedLines: left.deletedLines + right.deletedLines, reasons: [...left.reasons, ...right.reasons, { type: 'verification-repair', message: 'Adjacent groups merged after an intermediate prefix failed verification.', details: { originalGroups: [{ id: left.id, title: left.title }, { id: right.id, title: right.title }] } }] };
  plan.groups.splice(index, 2, merged);
  // Alternatives describe the pre-repair partition and must not survive a rejected boundary.
  plan.candidates = [];
  for (const group of plan.groups) group.dependsOn = [...new Set(group.dependsOn.map(dep => removed.includes(dep) ? merged.id : dep))].filter(dep => dep !== group.id);
  if (merged.files.length > plan.config.limits.hardMaxFiles || merged.addedLines + merged.deletedLines > plan.config.limits.hardMaxChangedLines) {
    plan.status = 'cannot-safely-split';
    plan.warnings.push({ type: 'repair-over-limit', message: 'A verification repair requires an indivisible group larger than a configured hard size limit.', paths: merged.files });
  }
  return removed;
}

export async function verifyPlan(input: SlicePlan, options: VerifyOptions = {}): Promise<SlicePlan> {
  validatePlan(input);
  assertRefsUnchanged(input.repository);
  const plan = structuredClone(input), sandbox = createSandbox(plan.repository);
  let sharedModules: string | undefined;
  if (options.nodeModules) {
    try {
      sharedModules = fs.realpathSync(path.resolve(options.nodeModules));
      if (!fs.statSync(sharedModules).isDirectory()) throw new Error('Not a directory');
    } catch { sandbox.cleanup(); throw new SlicerError('The explicit node_modules path must be an existing directory.', 'INVALID_INPUT'); }
    plan.warnings.push({ type: 'shared-dependencies', message: 'Explicit external node_modules are shared with verification snapshots; their content is outside the immutable Git plan.' });
  }
  try {
    const initialGroups = plan.groups.length;
    const changedPaths = new Set(plan.files.flatMap(file => [file.oldPath, file.newPath].filter((name): name is string => name !== null)));
    for (let attempt = 0; attempt < Math.max(1, initialGroups); attempt++) {
      const selected: string[] = [], trees: string[] = [], checks: Record<string, CheckResult[]> = {};
      let firstFailure = -1, unavailable = false, commandsExecuted = false;
      for (const [index, group] of plan.groups.entries()) {
        selected.push(...group.unitIds);
        const tree = reconstructTree(plan.repository, plan.files, plan.units, selected, sandbox);
        trees.push(tree);
        const results: CheckResult[] = [{ name: 'reconstruction', status: 'passed', message: 'Prefix reconstructed from the immutable merge-base.' }];
        checks[group.id] = results;
        const treeEntries = git(plan.repository.root, ['ls-tree', '-r', '-z', tree], { env: sandbox.env }).toString('utf8').split('\0');
        const incomplete = treeEntries.filter(entry => /^(120000|160000) /.test(entry));
        const specialPaths = incomplete.map(entry => entry.slice(entry.indexOf('\t') + 1));
        if (incomplete.length && (specialPaths.some(name => changedPaths.has(name)) || options.runChecks && plan.config.checks.length)) {
          results.push({ name: 'snapshot', status: 'unavailable', message: `Snapshot contains ${incomplete.length} symlink or submodule entries; these are preserved in Git but not executed or followed.` });
          unavailable = true;
          continue;
        }
        if (incomplete.length) {
          const warning: Evidence = { type: 'unchanged-special-entries', message: 'Unchanged symlinks and gitlinks are preserved as opaque Git entries; ordinary source syntax can be checked without following them.', paths: specialPaths };
          if (!plan.warnings.some(existing => JSON.stringify(existing) === JSON.stringify(warning))) plan.warnings.push(warning);
        }
        const destination = path.join(sandbox.root, `verify-${attempt}-${index}`);
        const snapshotWarnings: Evidence[] = [];
        exportSnapshot(plan.repository, tree, destination, sandbox, {
          mode: options.runChecks && plan.config.checks.length ? 'full' : 'analysis',
          files: plan.files, warnings: snapshotWarnings,
        });
        for (const warning of snapshotWarnings) if (!plan.warnings.some(existing => JSON.stringify(existing) === JSON.stringify(warning))) plan.warnings.push(warning);
        if (snapshotWarnings.some(warning => warning.type === 'oversized-blob')) {
          results.push({ name: 'snapshot', status: 'unavailable', message: 'Analysis inputs larger than 8 MiB were omitted; Git reconstruction is exact, but source verification is unavailable.' });
          unavailable = true;
          fs.rmSync(destination, { recursive: true, force: true });
          continue;
        }
        if (sharedModules) {
          const link = path.join(destination, 'node_modules');
          if (fs.existsSync(link)) results.push({ name: 'dependencies', status: 'unavailable', message: 'The snapshot already contains node_modules; explicit dependencies cannot replace tracked files.' });
          else fs.symlinkSync(sharedModules, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        try {
          const diagnostics = diagnoseSnapshot(destination, options.semantic ?? false);
          if (incomplete.length && options.semantic) diagnostics.semantic = { ...diagnostics.semantic, status: 'unavailable', message: 'Semantic verification cannot establish completeness across opaque symlinks or gitlinks; no target was followed or initialized.' };
          results.push(diagnostics.syntax, diagnostics.semantic);
          for (const warning of diagnostics.warnings) if (!plan.warnings.some(existing => JSON.stringify(existing) === JSON.stringify(warning))) plan.warnings.push(warning);
          const staticFailure = results.some(result => ['failed', 'timeout', 'unavailable'].includes(result.status));
          for (const check of plan.config.checks) {
            if (!options.runChecks || staticFailure) results.push({ name: check.name, status: 'skipped', message: !options.runChecks ? 'Project commands require explicit --run-checks.' : 'Static verification did not pass.' });
            else { commandsExecuted = true; results.push(await runCheck(check, destination, createCheckEnvironment(plan.config.environment))); }
          }
        } finally { fs.rmSync(destination, { recursive: true, force: true }); }
        if (results.some(result => result.status === 'failed' || result.status === 'timeout') && firstFailure === -1) firstFailure = index;
        if (results.some(result => result.status === 'unavailable')) unavailable = true;
      }
      const finalTree = trees.at(-1) ?? plan.repository.baseTreeOid;
      if (finalTree !== plan.repository.headTreeOid) throw new SlicerError('Final reconstructed tree does not equal head.', 'INTEGRITY_ERROR');
      plan.integrity.finalTreeOid = finalTree; plan.integrity.exactReconstruction = true;
      if (firstFailure >= 0 && firstFailure < plan.groups.length - 1 && options.repair !== false) {
        const failures = checks[plan.groups[firstFailure].id].filter(result => result.status === 'failed' || result.status === 'timeout');
        const removed = mergeFollowing(plan, firstFailure);
        plan.warnings.push({ type: 'rejected-boundary', message: 'An intermediate boundary failed verification and was merged with the next group.', details: { groups: removed, checks: failures.map(result => ({ name: result.name, status: result.status, message: result.message, log: result.log })) } });
        plan.integrity.digest = planDigest(plan);
        continue;
      }
      sanitizePlanDescriptions(plan);
      const digest = planDigest(plan), status = firstFailure >= 0 ? 'failed' : unavailable ? 'verification-unavailable' : 'passed';
      plan.checks = checks;
      const all = Object.values(checks);
      const everyPassed = (name: string) => all.length > 0 && all.every(results => results.some(r => r.name === name && r.status === 'passed'));
      const level = options.runChecks && plan.config.checks.length && status === 'passed' && commandsExecuted ? 'project' : options.semantic && everyPassed('semantic') ? 'semantic' : everyPassed('syntax') ? 'syntax' : 'reconstructed';
      plan.verification = { status, level, digest, trees, checks, commandsExecuted };
      plan.metrics = calculateMetrics(plan.groups, plan.units, plan.edges, plan.config, collapseGraph(plan.units, plan.edges).components.length > MAX_SEGMENT_BOUNDARIES);
      plan.integrity.digest = digest;
      // Denominator: reconstructed prefixes. A skipped configured project check
      // is uncovered; only the optional built-in semantic check may be skipped.
      // Use positions, since configured check names can match built-in names.
      plan.metrics.verificationCoverage = { passed: Object.values(checks).filter(results =>
        results[1]?.name === 'syntax' && results[1].status === 'passed' &&
        results[2]?.name === 'semantic' && ['passed', 'skipped'].includes(results[2].status) &&
        results.slice(3).every(result => result.status === 'passed')
      ).length, total: plan.groups.length };
      if (plan.groups.length > 1 && plan.status !== 'cannot-safely-split') plan.status = status === 'passed' ? 'split-verified' : 'split-unverified';
      else if (plan.groups.length <= 1 && plan.status !== 'cannot-safely-split') plan.status = 'single-change';
      sanitizePlanDescriptions(plan); assertPlanSize(plan);
      assertRefsUnchanged(plan.repository);
      return plan;
    }
    throw new SlicerError('Verification repair exceeded its deterministic bound.', 'VERIFICATION_FAILED');
  } finally { sandbox.cleanup(); }
}

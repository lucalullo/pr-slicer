import type { SlicePlan } from '../core/model.js';
import { SlicerError } from '../core/errors.js';
import { planDigest, validatePlan } from '../core/plan.js';
import { assertClean, assertRefsUnchanged, createSandbox, git, reconstructTree } from '../git/index.js';
import { persistObjects } from './objects.js';

export interface MaterializeOptions { prefix: string; dryRun?: boolean }
export interface MaterializeResult { branches: { name: string; oid: string; tree: string }[]; finalTreeOid: string }

export function materializePlan(plan: SlicePlan, options: MaterializeOptions): MaterializeResult {
  validatePlan(plan);
  const digest = planDigest(plan);
  if (plan.verification.status !== 'passed' || plan.verification.digest !== digest || !plan.integrity.exactReconstruction) throw new SlicerError('Materialization requires an unchanged plan with passed verification.', 'UNVERIFIED_PLAN');
  if (!options.prefix || options.prefix.startsWith('-')) throw new SlicerError('A valid local branch prefix is required.', 'INVALID_INPUT');
  assertClean(plan.repository); assertRefsUnchanged(plan.repository);
  const names = plan.groups.map((_, index) => `${options.prefix}/${String(index + 1).padStart(2, '0')}`);
  for (const name of names) {
    git(plan.repository.root, ['check-ref-format', `refs/heads/${name}`]);
    const existing = git(plan.repository.root, ['for-each-ref', '--format=%(refname)', `refs/heads/${name}`]).toString('utf8').trim();
    if (existing) throw new SlicerError(`Branch already exists: ${name}`, 'BRANCH_EXISTS');
  }
  const sandbox = createSandbox(plan.repository);
  try {
    const branches: MaterializeResult['branches'] = [], selected: string[] = [];
    let parent = plan.repository.mergeBaseOid;
    const timestamp = git(plan.repository.root, ['show', '--encoding=UTF-8', '--no-show-signature', '-s', '--format=%ct', plan.repository.headOid]).toString('utf8').trim();
    if (!/^\d+$/.test(timestamp)) throw new SlicerError('Invalid head commit timestamp.', 'INTEGRITY_ERROR');
    const env = { ...sandbox.env, GIT_AUTHOR_NAME: 'PR Slicer', GIT_AUTHOR_EMAIL: 'pr-slicer@localhost', GIT_COMMITTER_NAME: 'PR Slicer', GIT_COMMITTER_EMAIL: 'pr-slicer@localhost', GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000` };
    for (const [index, group] of plan.groups.entries()) {
      selected.push(...group.unitIds);
      const tree = reconstructTree(plan.repository, plan.files, plan.units, selected, sandbox);
      if (tree !== plan.verification.trees[index]) throw new SlicerError('Reconstructed prefix differs from its verified tree.', 'INTEGRITY_ERROR');
      const message = `${group.title}\n\nPR Slicer group ${index + 1}/${plan.groups.length}\nOriginal-head: ${plan.repository.headOid}\nPlan-digest: ${digest}\n`;
      const oid = git(plan.repository.root, ['-c', 'commit.gpgSign=false', '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', tree, '-p', parent], { input: Buffer.from(message), env }).toString('utf8').trim();
      branches.push({ name: names[index], oid, tree }); parent = oid;
    }
    const finalTreeOid = branches.at(-1)?.tree ?? plan.repository.baseTreeOid;
    if (finalTreeOid !== plan.repository.headTreeOid || plan.verification.trees.length !== branches.length) throw new SlicerError('Final materialized tree is not the original head tree.', 'INTEGRITY_ERROR');
    assertClean(plan.repository); assertRefsUnchanged(plan.repository);
    if (!options.dryRun && branches.length) {
      persistObjects(plan.repository, sandbox.env.GIT_OBJECT_DIRECTORY!);
      const references = new Map<string, string>();
      for (const [ref, oid] of [[plan.repository.baseRef, plan.repository.baseOid], [plan.repository.headRef, plan.repository.headOid]]) {
        const full = git(plan.repository.root, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', ref]).toString('utf8').trim();
        if (full.startsWith('refs/')) references.set(full, git(plan.repository.root, ['rev-parse', '--verify', '--end-of-options', full]).toString('utf8').trim());
        else if (ref === 'HEAD') references.set('HEAD', oid);
      }
      const transaction = ['start', ...[...references].map(([ref, oid]) => `verify ${ref} ${oid}`), ...branches.map(branch => `create refs/heads/${branch.name} ${branch.oid}`), 'prepare', 'commit', ''].join('\n');
      git(plan.repository.root, ['update-ref', '--stdin'], { input: Buffer.from(transaction) });
    }
    return { branches, finalTreeOid };
  } finally { sandbox.cleanup(); }
}

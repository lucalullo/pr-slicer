import type { SlicePlan, ChangeUnit, PlanGroup, CheckResult } from './model.js';
import { hash, compare } from './hashing.js';
import { normalizeConfig, matchesGlob } from '../config/index.js';
import { resolveRepository, readChanges, createSandbox, reconstructTree } from '../git/index.js';
import { collapseGraph, requiresTogether } from '../graph/graph.js';
import { planCandidates } from '../planner/index.js';
import { calculateMetrics } from '../planner/scoring.js';
import { MAX_SEGMENT_BOUNDARIES } from '../planner/segmenter.js';
import { assertPlanSize } from './plan-size.js';
import { invalidPlan, validatePlanSchema } from './schema-validation.js';

export function planDigest(plan: SlicePlan): string {
  return hash({ schemaVersion: plan.schemaVersion, toolVersion: plan.toolVersion, repository: plan.repository, config: plan.config, analysisMode: plan.analysisMode, files: plan.files, units: plan.units, edges: plan.edges, groups: plan.groups.map(({ id, unitIds, dependsOn }) => ({ id, unitIds, dependsOn })) });
}

/** Compare recomputable data without hiding the first divergent field behind a generic error. */
function equal(actual: unknown, expected: unknown, path: string, reason = 'campo derivato incoerente'): void {
  if (actual === expected) return;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) invalidPlan(`${path}.length`, reason);
    actual.forEach((value, index) => equal(value, expected[index], `${path}[${index}]`, reason)); return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) invalidPlan(`${path}.${key}`, reason);
      equal(a[key], b[key], `${path}.${key}`, reason);
    }
    return;
  }
  invalidPlan(path, reason);
}

function indexed<T extends { id: string }>(items: T[], path: string): Map<string, T> {
  const byId = new Map<string, T>();
  items.forEach((item, index) => { if (byId.has(item.id)) invalidPlan(`${path}[${index}].id`, 'ID duplicato'); byId.set(item.id, item); });
  return byId;
}

function validateGroups(groups: PlanGroup[], units: Map<string, ChangeUnit>, p: SlicePlan, path: string, allowOversized: boolean): void {
  indexed(groups, path);
  if (groups.length > p.config.limits.maxGroups) invalidPlan(path, 'numero di gruppi oltre config.limits.maxGroups');
  const groupOf = new Map<string, number>(), groupIndex = new Map(groups.map((group, index) => [group.id, index]));
  groups.forEach((group, index) => {
    const base = `${path}[${index}]`, members: ChangeUnit[] = [];
    group.unitIds.forEach((id, position) => {
      const unit = units.get(id); if (!unit) invalidPlan(`${base}.unitIds[${position}]`, 'ID unità inesistente');
      if (groupOf.has(id)) invalidPlan(`${base}.unitIds[${position}]`, 'unità duplicata nella partizione');
      groupOf.set(id, index); members.push(unit!);
    });
    group.dependsOn.forEach((dependency, position) => { if (!groupIndex.has(dependency) || groupIndex.get(dependency)! >= index) invalidPlan(`${base}.dependsOn[${position}]`, 'dipendenza inesistente, ciclica o non precedente'); });
    equal(group.files, [...new Set(members.map(unit => unit.newPath ?? unit.oldPath ?? unit.id))].sort(compare), `${base}.files`);
    equal(group.addedLines, members.reduce((sum, unit) => sum + unit.addedLines, 0), `${base}.addedLines`);
    equal(group.deletedLines, members.reduce((sum, unit) => sum + unit.deletedLines, 0), `${base}.deletedLines`);
    if (!allowOversized && group.files.length > p.config.limits.hardMaxFiles) invalidPlan(`${base}.files`, 'oltre config.limits.hardMaxFiles');
    if (!allowOversized && group.addedLines + group.deletedLines > p.config.limits.hardMaxChangedLines) invalidPlan(`${base}.addedLines`, 'righe cambiate oltre config.limits.hardMaxChangedLines');
  });
  if (groupOf.size !== units.size) invalidPlan(path, 'copertura unità incompleta');
  const dependencies = groups.map(() => new Set<number>());
  p.edges.forEach((edge, index) => {
    const from = groupOf.get(edge.from)!, to = groupOf.get(edge.to)!;
    if (requiresTogether(edge) && from !== to) invalidPlan(path, `vincolo indivisibile edges[${index}] tagliato`);
    if (edge.kind === 'before') {
      if (from > to) invalidPlan(path, `dipendenza before edges[${index}] invertita`);
      if (from !== to) dependencies[to].add(from);
    }
  });
  groups.forEach((group, index) => equal(group.dependsOn, [...dependencies[index]].sort((a, b) => a - b).map(dependency => groups[dependency].id), `${path}[${index}].dependsOn`));
}

function validateVerification(p: SlicePlan): void {
  const v = p.verification;
  equal(v.checks, p.checks, 'verification.checks', 'risultati non corrispondenti a checks');
  if (v.status === 'not-run') {
    equal(v.digest, '', 'verification.digest'); equal(v.trees, [], 'verification.trees'); equal(p.checks, {}, 'checks');
    equal(v.commandsExecuted, false, 'verification.commandsExecuted'); equal(v.level, 'reconstructed', 'verification.level');
    equal(p.metrics.verificationCoverage, { passed: 0, total: 0 }, 'metrics.verificationCoverage');
    if (p.status === 'split-verified') invalidPlan('status', 'verifica non eseguita');
    if (p.status !== 'cannot-safely-split' && (p.groups.length <= 1 ? p.status !== 'single-change' : !['split-unverified', 'split-recommended'].includes(p.status))) invalidPlan('status', 'stato incompatibile con il numero di gruppi');
    return;
  }
  equal(v.digest, p.integrity.digest, 'verification.digest', 'digest di verifica obsoleto');
  equal(v.trees.length, p.groups.length, 'verification.trees.length');
  if (p.groups.length) equal(v.trees.at(-1), p.repository.headTreeOid, `verification.trees[${v.trees.length - 1}]`);
  const groupIds = new Set(p.groups.map(group => group.id));
  for (const key of Object.keys(p.checks)) if (!groupIds.has(key)) invalidPlan(`checks[${JSON.stringify(key)}]`, 'ID gruppo inesistente');
  const all: CheckResult[] = [], syntax: CheckResult[] = [], semantic: CheckResult[] = [];
  let commandsExecuted = false, covered = 0;
  for (const group of p.groups) {
    const base = `checks[${JSON.stringify(group.id)}]`, results = p.checks[group.id];
    if (!Object.hasOwn(p.checks, group.id)) invalidPlan(base, 'risultati del gruppo mancanti');
    if (!results.length) invalidPlan(base, 'risultati del gruppo vuoti');
    all.push(...results);
    results.forEach((result, index) => {
      if (result.status === 'passed' && result.exitCode !== undefined && result.exitCode !== 0) invalidPlan(`${base}[${index}].exitCode`, 'check passed con exitCode non zero');
      if (result.status === 'failed' && result.exitCode === 0) invalidPlan(`${base}[${index}].exitCode`, 'check failed con exitCode zero');
      if (result.status === 'skipped' && (result.exitCode !== undefined || result.durationMs !== undefined)) invalidPlan(`${base}[${index}]`, 'check skipped con dati di esecuzione');
    });
    const expect = (index: number, name: string): CheckResult => {
      if (!results[index]) invalidPlan(`${base}[${index}]`, `risultato ${name} mancante`);
      equal(results[index].name, name, `${base}[${index}].name`, `atteso controllo ${name}`); return results[index];
    };
    equal(expect(0, 'reconstruction').status, 'passed', `${base}[0].status`);
    if (results[1]?.name === 'snapshot') {
      equal(results.length, 2, `${base}.length`); equal(results[1].status, 'unavailable', `${base}[1].status`); continue;
    }
    const offset = results[1]?.name === 'dependencies' ? 2 : 1;
    if (offset === 2) equal(results[1].status, 'unavailable', `${base}[1].status`);
    const s = expect(offset, 'syntax'), m = expect(offset + 1, 'semantic'); syntax.push(s); semantic.push(m);
    if (!['passed', 'failed', 'unavailable'].includes(s.status)) invalidPlan(`${base}[${offset}].status`, 'esito syntax non producibile');
    if (!['passed', 'failed', 'skipped', 'unavailable'].includes(m.status)) invalidPlan(`${base}[${offset + 1}].status`, 'esito semantic non producibile');
    equal(results.length, offset + 2 + p.config.checks.length, `${base}.length`);
    const configured = p.config.checks.map((check, index) => expect(offset + 2 + index, check.name));
    // Configured names may coincide with built-ins: position preserves their distinct meaning.
    commandsExecuted ||= configured.some(result => result.status !== 'skipped');
    if (offset === 1 && s.status === 'passed' && ['passed', 'skipped'].includes(m.status) && configured.every(result => result.status === 'passed')) covered++;
  }
  const status = all.some(result => ['failed', 'timeout'].includes(result.status)) ? 'failed' : all.some(result => result.status === 'unavailable') ? 'verification-unavailable' : 'passed';
  const everyPassed = (results: CheckResult[]) => p.groups.length > 0 && results.length === p.groups.length && results.every(result => result.status === 'passed');
  const level = commandsExecuted && p.config.checks.length && status === 'passed' ? 'project' : everyPassed(semantic) ? 'semantic' : everyPassed(syntax) ? 'syntax' : 'reconstructed';
  equal(v.status, status, 'verification.status'); equal(v.level, level, 'verification.level'); equal(v.commandsExecuted, commandsExecuted, 'verification.commandsExecuted');
  equal(p.metrics.verificationCoverage, { passed: covered, total: p.groups.length }, 'metrics.verificationCoverage');
  if (p.status !== 'cannot-safely-split') equal(p.status, p.groups.length <= 1 ? 'single-change' : status === 'passed' ? 'split-verified' : 'split-unverified', 'status');
}

/** Validate data first, then independently re-read immutable Git facts and recompute derived fields. */
export function validatePlan(value: unknown): asserts value is SlicePlan {
  assertPlanSize(value);
  validatePlanSchema(value);
  const p = value as SlicePlan;
  let normalized;
  try { normalized = normalizeConfig(p.config); } catch (error) { invalidPlan('config', error instanceof Error ? error.message : String(error)); }
  equal(p.config, normalized, 'config', 'configurazione incompleta o incoerente');
  p.config.checks.forEach((check, index) => { if (/[\u0000-\u001f\u007f-\u009f]/.test(check.name)) invalidPlan(`config.checks[${index}].name`, 'caratteri di controllo non consentiti'); });
  const repository = p.repository, oidLength = repository.objectFormat === 'sha1' ? 40 : 64;
  for (const key of ['baseOid', 'mergeBaseOid', 'headOid', 'baseTreeOid', 'headTreeOid'] as const) if (repository[key].length !== oidLength) invalidPlan(`repository.${key}`, 'OID incompatibile con objectFormat');
  p.verification.trees.forEach((oid, index) => { if (oid.length !== oidLength) invalidPlan(`verification.trees[${index}]`, 'OID incompatibile con objectFormat'); });
  for (const key of ['baseRef', 'headRef'] as const) if (repository[key].startsWith('-')) invalidPlan(`repository.${key}`, 'riferimento Git non valido');
  const files = indexed(p.files, 'files'), units = indexed(p.units, 'units');
  const hunks = new Set<string>();
  p.files.forEach((file, index) => file.hunks.forEach((hunk, hunkIndex) => { if (hunks.has(hunk.id)) invalidPlan(`files[${index}].hunks[${hunkIndex}].id`, 'hunk duplicato'); hunks.add(hunk.id); }));
  const actual = resolveRepository(repository.root, repository.baseOid, repository.headOid);
  for (const key of ['root', 'gitDir', 'commonDir', 'objectFormat', 'baseOid', 'mergeBaseOid', 'headOid', 'baseTreeOid', 'headTreeOid'] as const) equal(repository[key], actual[key], `repository.${key}`, 'non corrisponde ai dati Git');
  equal(p.files, readChanges(actual), 'files', 'diff alterato o non corrispondente ai commit');
  const assignedHunks = new Set<string>(), fileUnits = new Map<string, ChangeUnit[]>();
  p.units.forEach((unit, index) => {
    const base = `units[${index}]`, file = files.get(unit.fileId);
    if (!file) invalidPlan(`${base}.fileId`, 'ID file inesistente');
    for (const key of ['oldPath', 'newPath', 'changeKind'] as const) equal(unit[key], file![key], `${base}.${key}`, 'non corrisponde al file');
    const byHunk = new Map(file!.hunks.map(hunk => [hunk.id, hunk]));
    unit.hunkIds.forEach((id, position) => {
      if (!byHunk.has(id)) invalidPlan(`${base}.hunkIds[${position}]`, 'hunk inesistente o estraneo al file');
      if (assignedHunks.has(id)) invalidPlan(`${base}.hunkIds[${position}]`, 'hunk duplicato'); assignedHunks.add(id);
    });
    if (file!.hunks.length && !unit.hunkIds.length) invalidPlan(`${base}.hunkIds`, 'unità vuota');
    if (file!.atomic && !unit.isAtomic) invalidPlan(`${base}.isAtomic`, 'file atomico suddiviso');
    if (unit.isAtomic) equal([...unit.hunkIds].sort(compare), [...byHunk.keys()].sort(compare), `${base}.hunkIds`, 'unità atomica incompleta');
    for (const [field, prefix] of [['addedLines', '+'], ['deletedLines', '-']] as const) equal(unit[field], unit.isAtomic ? file![field] : unit.hunkIds.reduce((sum, id) => sum + byHunk.get(id)!.lines.filter(line => line.startsWith(prefix)).length, 0), `${base}.${field}`);
    const relative = unit.newPath ?? unit.oldPath!;
    equal(unit.isTest, p.config.relations.testPatterns.some(pattern => matchesGlob(relative, pattern)), `${base}.isTest`);
    equal(unit.isGenerated, p.config.relations.generatedPatterns.some(pattern => matchesGlob(relative, pattern)) || p.config.relations.generatedFrom.some(rule => rule.generated.some(pattern => matchesGlob(relative, pattern))), `${base}.isGenerated`);
    equal(unit.area, p.config.areas.find(area => area.patterns.some(pattern => matchesGlob(relative, pattern)))?.name ?? null, `${base}.area`);
    if (!fileUnits.has(unit.fileId)) fileUnits.set(unit.fileId, []); fileUnits.get(unit.fileId)!.push(unit);
  });
  p.files.forEach((file, index) => {
    const members = fileUnits.get(file.id); if (!members) invalidPlan(`files[${index}].id`, 'file perso dal piano');
    if ((file.atomic || !file.hunks.length || members!.some(unit => unit.isAtomic)) && members!.length !== 1) invalidPlan(`files[${index}].id`, 'file atomico assegnato più volte');
    file.hunks.forEach((hunk, position) => { if (!assignedHunks.has(hunk.id)) invalidPlan(`files[${index}].hunks[${position}].id`, 'hunk perso dal piano'); });
  });
  indexed(p.edges, 'edges');
  p.edges.forEach((edge, index) => {
    for (const endpoint of ['from', 'to'] as const) if (!units.has(edge[endpoint])) invalidPlan(`edges[${index}].${endpoint}`, 'ID unità inesistente');
    if (edge.from === edge.to) invalidPlan(`edges[${index}].to`, 'arco verso se stesso');
  });
  validateGroups(p.groups, units, p, 'groups', p.status === 'cannot-safely-split');
  indexed(p.candidates, 'candidates');
  if (p.candidates.length) {
    if (p.warnings.some(warning => warning.type === 'rejected-boundary')) invalidPlan('candidates', 'candidate obsolete dopo una riparazione: rigenerare o invalidare le alternative');
    const candidates = new Map(planCandidates(p.units, p.edges, p.config).candidates.map(candidate => [candidate.id, candidate]));
    p.candidates.forEach((candidate, index) => {
      const base = `candidates[${index}]`;
      validateGroups(candidate.groups, units, p, `${base}.groups`, candidate.cost === Number.MAX_SAFE_INTEGER && p.status === 'cannot-safely-split');
      const expected = candidates.get(candidate.id); if (!expected) invalidPlan(`${base}.id`, 'candidato obsoleto o non derivato dal planner corrente');
      equal(candidate.cost, expected!.cost, `${base}.cost`);
      const structure = (groups: PlanGroup[]) => groups.map(({ id, unitIds, dependsOn }) => ({ id, unitIds, dependsOn }));
      equal(structure(candidate.groups), structure(expected!.groups), `${base}.groups`, 'candidato obsoleto');
    });
  }
  const coarse = collapseGraph(p.units, p.edges).components.length > MAX_SEGMENT_BOUNDARIES;
  const metrics = calculateMetrics(p.groups, p.units, p.edges, p.config, coarse);
  for (const key of ['reviewability', 'structuralCohesion', 'dependencyIntegrity'] as const) equal(p.metrics[key], metrics[key], `metrics.${key}`);
  const confidence = ['low', 'medium', 'high'];
  if (confidence.indexOf(p.metrics.boundaryConfidence) > confidence.indexOf(metrics.boundaryConfidence)) invalidPlan('metrics.boundaryConfidence', 'confidenza superiore alle evidenze disponibili');
  equal(p.integrity.finalTreeOid, repository.headTreeOid, 'integrity.finalTreeOid');
  equal(p.integrity.digest, planDigest(p), 'integrity.digest', 'digest errato: rigenerare il piano dopo modifiche strutturali');
  validateVerification(p);
  if (p.verification.status !== 'not-run' && p.groups.length) {
    const sandbox = createSandbox(repository), selected: string[] = [];
    try {
      p.groups.forEach((group, index) => {
        selected.push(...group.unitIds);
        equal(p.verification.trees[index], reconstructTree(repository, p.files, p.units, selected, sandbox), `verification.trees[${index}]`, 'tree del prefisso non corrispondente alla ricostruzione Git');
      });
    } finally { sandbox.cleanup(); }
  }
}

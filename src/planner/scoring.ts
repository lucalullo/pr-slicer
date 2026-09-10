import type { ChangeEdge, ChangeUnit, Config, Metrics, PlanGroup } from '../core/model.js';
import { requiresTogether } from '../graph/graph.js';

export function edgePenalty(edge: ChangeEdge, units: Map<string, ChangeUnit>, config: Config): number {
  if (requiresTogether(edge)) return 0;
  const weight = Math.max(0, Math.min(100, Number.isFinite(edge.weight) ? edge.weight : 0));
  if (edge.kind === 'unknown') return Math.max(40, weight);
  if (edge.kind === 'before') return weight * 0.1;
  const pairedTest = units.get(edge.from)?.isTest !== units.get(edge.to)?.isTest && config.relations.keepTestsWithImplementation;
  return weight * (pairedTest ? 0.8 : 0.4);
}

export function segmentCost(reviewLines: number, files: number, packages: number, areas: number, config: Config): number {
  const ratio = reviewLines / Math.max(1, config.limits.targetChangedLines), fileRatio = files / Math.max(1, config.limits.targetFiles);
  return 8 + 35 * Math.max(0, ratio - 1) ** 2 + 10 * Math.max(0, 0.25 - ratio) + 12 * Math.max(0, fileRatio - 1) ** 2 + 18 * Math.max(0, packages - 1) + 24 * Math.max(0, areas - 1);
}

/** Descriptive structural ratios, never a probability of behavioral correctness. */
export function calculateMetrics(groups: PlanGroup[], units: ChangeUnit[], edges: ChangeEdge[], config: Config, coarse = false): Metrics {
  const groupOf = new Map(groups.flatMap((group, index) => group.unitIds.map(unit => [unit, index] as const)));
  let affinity = 0, retained = 0, hard = 0, satisfied = 0;
  for (const edge of edges) {
    const from = groupOf.get(edge.from), to = groupOf.get(edge.to), present = from !== undefined && to !== undefined;
    if (edge.kind === 'affinity') { const weight = Math.max(0, edge.weight); affinity += weight; if (present && from === to) retained += weight; }
    if (requiresTogether(edge) || edge.kind === 'before') { hard++; if (present && (requiresTogether(edge) ? from === to : from <= to)) satisfied++; }
  }
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const oversized = groups.reduce((sum, group) => {
    const reviewLines = group.unitIds.reduce((total, unitId) => { const unit = byId.get(unitId)!; return total + (unit.isGenerated ? 0 : unit.addedLines + unit.deletedLines); }, 0);
    return sum + Math.min(1, config.limits.targetChangedLines / Math.max(1, reviewLines), config.limits.targetFiles / Math.max(1, group.files.length));
  }, 0);
  const rounded = (value: number) => Math.round(value * 10000) / 100;
  const uncertain = coarse || edges.some(edge => edge.kind === 'unknown') || !edges.length;
  const strongEvidence = new Set(['new-symbol-reference', 'removed-symbol-reference', 'new-module-import', 'removed-module-import', 'import-binding-change', 'removed-import-binding', 'new-package-dependency', 'removed-package-dependency']);
  // High describes observed structure, not behavioral correctness: every actual
  // boundary needs two distinct strongly evidenced provider/consumer pairs.
  const supportedBoundaries = groups.slice(1).every((_, boundary) => {
    const pairs = new Set<string>();
    for (const edge of edges) {
      const from = groupOf.get(edge.from), to = groupOf.get(edge.to);
      if (edge.kind === 'before' && edge.weight >= 90 && from !== undefined && to !== undefined && from <= boundary && to > boundary && edge.evidence.some(evidence => strongEvidence.has(evidence.type))) pairs.add(JSON.stringify([edge.from, edge.to]));
    }
    return pairs.size >= 2;
  });
  const high = !uncertain && groups.length > 1 && hard === satisfied && (!affinity || retained / affinity >= 0.9) && supportedBoundaries;
  return {
    reviewability: groups.length ? rounded(oversized / groups.length) : 100,
    structuralCohesion: affinity ? rounded(retained / affinity) : 100,
    dependencyIntegrity: hard ? rounded(satisfied / hard) : 100,
    boundaryConfidence: uncertain ? 'low' : high ? 'high' : 'medium',
    verificationCoverage: { passed: 0, total: 0 },
  };
}

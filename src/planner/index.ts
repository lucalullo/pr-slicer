import { compare, hash, id } from '../core/hashing.js';
import type { Candidate, ChangeEdge, ChangeUnit, Config, Evidence, Metrics, PlanGroup, SlicePlan } from '../core/model.js';
import { collapseGraph, type Component } from '../graph/graph.js';
import { topologicalOrder } from '../graph/topological-order.js';
import { MAX_SEGMENT_BOUNDARIES, segmentOrder } from './segmenter.js';
import { calculateMetrics } from './scoring.js';
import { titleFor } from './titles.js';

function makeGroups(segments: Component[][], edges: ChangeEdge[]): PlanGroup[] {
  const groups = segments.map(segment => {
    const units = segment.flatMap(component => component.units).sort((a, b) => compare(a.id, b.id)), unitIds = units.map(unit => unit.id);
    const reasons = [...new Map(segment.flatMap(component => component.reasons).map(reason => [hash(reason), reason])).values()];
    if (!reasons.length) reasons.push({ type: 'contiguous-segment', message: 'Segmento contiguo di un ordine che rispetta le dipendenze note; dimensione, package, aree e affinità determinano il costo.' });
    if (reasons.length > 20) reasons.splice(20, reasons.length - 20, { type: 'additional-evidence', message: 'Ulteriori evidenze sono disponibili negli archi del piano.' });
    return { id: id('slice', unitIds), title: titleFor(units), unitIds, dependsOn: [] as string[], files: [...new Set(units.map(unit => unit.newPath ?? unit.oldPath ?? unit.id))].sort(compare), addedLines: units.reduce((sum, unit) => sum + unit.addedLines, 0), deletedLines: units.reduce((sum, unit) => sum + unit.deletedLines, 0), reasons };
  });
  const groupOf = new Map(groups.flatMap((group, index) => group.unitIds.map(unit => [unit, index] as const))), dependencies = groups.map(() => new Set<number>());
  for (const edge of edges) if (edge.kind === 'before') { const from = groupOf.get(edge.from)!, to = groupOf.get(edge.to)!; if (from !== to) dependencies[to].add(from); }
  groups.forEach((group, index) => { group.dependsOn = [...dependencies[index]].sort((a, b) => a - b).map(dependency => groups[dependency].id); });
  return groups;
}

export function planCandidates(units: ChangeUnit[], edges: ChangeEdge[], config: Config): { groups: PlanGroup[]; candidates: Candidate[]; warnings: Evidence[]; metrics: Metrics; status: SlicePlan['status'] } {
  const graph = collapseGraph(units, edges), warnings = [...graph.warnings];
  const coarse = graph.components.length > MAX_SEGMENT_BOUNDARIES;
  if (coarse) warnings.push({ type: 'coarse-planning', message: `Oltre ${MAX_SEGMENT_BOUNDARIES} componenti: DP limitata a confini deterministici campionati. Una suddivisione valida potrebbe non essere individuata.`, details: { components: graph.components.length, maxBoundaries: MAX_SEGMENT_BOUNDARIES } });
  if (edges.some(edge => edge.kind === 'unknown')) warnings.push({ type: 'uncertain-boundary', message: 'Relazioni non risolte riducono la confidenza strutturale. Le relazioni marcate requiresTogether sono mantenute insieme; le altre penalizzano la separazione.' });
  if (!units.length) return { groups: [], candidates: [], warnings, metrics: calculateMetrics([], units, edges, config), status: 'single-change' };
  const componentById = new Map(graph.components.map(component => [component.id, component]));
  const key = (component: Component, mode: number) => {
    const paths = component.units.map(unit => unit.newPath ?? unit.oldPath ?? unit.id).sort(compare), packages = component.units.map(unit => unit.packageId ?? '').sort(compare), areas = component.units.map(unit => unit.area ?? '').sort(compare);
    return mode === 1 ? `${packages[0]}\0${paths[0]}` : mode === 2 ? `${areas[0]}\0${paths[0]}` : paths[0];
  };
  const candidatesById = new Map<string, Candidate>(), seenOrders = new Set<string>();
  for (let mode = 0; mode < 3; mode++) {
    const order = topologicalOrder(graph.components.map(component => component.id), graph.adjacency, node => key(componentById.get(node)!, mode));
    const orderKey = order.join(':'); if (seenOrders.has(orderKey)) continue; seenOrders.add(orderKey);
    for (const segmentation of segmentOrder(order.map(node => componentById.get(node)!), edges, config)) {
      const groups = makeGroups(segmentation.segments, edges), candidate: Candidate = { id: id('candidate', groups.map(group => group.id)), groups, cost: segmentation.cost, reasons: [{ type: 'planner-cost', message: 'Costo euristico: dimensione, dispersione, affinità e numero di gruppi; non è una probabilità di correttezza.', details: { order: ['path', 'package', 'area'][mode], boundedDynamicProgramming: coarse } }] };
      if (!candidatesById.has(candidate.id) || candidatesById.get(candidate.id)!.cost > candidate.cost) candidatesById.set(candidate.id, candidate);
    }
  }
  const ranked = [...candidatesById.values()].sort((a, b) => a.cost - b.cost || a.groups.length - b.groups.length || compare(a.id, b.id));
  let candidates = ranked.slice(0, 5);
  const single = ranked.find(candidate => candidate.groups.length === 1);
  if (single && !candidates.some(candidate => candidate.id === single.id)) candidates = [...candidates.slice(0, 4), { ...single, reasons: [...single.reasons, { type: 'repair-fallback', message: 'Candidato unico conservato per una verifica di riparazione, entro i limiti rigidi.' }] }];
  let status: SlicePlan['status'];
  if (!candidates.length) {
    const oversized = graph.components.filter(component => component.units.reduce((sum, unit) => sum + unit.addedLines + unit.deletedLines, 0) > config.limits.hardMaxChangedLines || new Set(component.units.map(unit => unit.newPath ?? unit.oldPath)).size > config.limits.hardMaxFiles);
    const reason: Evidence = { type: oversized.length ? 'oversized-indivisible-group' : 'no-feasible-partition', message: oversized.length ? 'Una componente indivisibile supera i limiti rigidi. Il gruppo unico documenta il diff completo e non costituisce una partizione conforme ai limiti.' : 'Nessuna partizione trovata entro i limiti e il numero massimo di gruppi. Il gruppo unico conserva il diff completo, ma non è una suddivisione conforme ai limiti.', details: { componentIds: oversized.map(component => component.id), hardMaxChangedLines: config.limits.hardMaxChangedLines, hardMaxFiles: config.limits.hardMaxFiles, maxGroups: config.limits.maxGroups } };
    warnings.push(reason);
    const groups = makeGroups([graph.components], edges); groups[0].reasons.push(reason);
    candidates = [{ id: id('candidate', groups.map(group => group.id)), groups, cost: Number.MAX_SAFE_INTEGER, reasons: [reason] }]; status = 'cannot-safely-split';
  } else status = candidates[0].groups.length > 1 ? 'split-unverified' : 'single-change';
  const groups = candidates[0].groups;
  return { groups, candidates, warnings, metrics: calculateMetrics(groups, units, edges, config, coarse), status };
}

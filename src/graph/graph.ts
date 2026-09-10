import { compare, id } from '../core/hashing.js';
import type { ChangeEdge, ChangeUnit, Evidence } from '../core/model.js';
import { UnionFind } from './union-find.js';
import { stronglyConnected } from './strongly-connected.js';

export interface Component { id: string; units: ChangeUnit[]; reasons: Evidence[] }
export interface CollapsedGraph { components: Component[]; componentOf: Map<string, string>; adjacency: Map<string, string[]>; warnings: Evidence[] }
export function requiresTogether(edge: ChangeEdge): boolean { return edge.kind === 'must_with' || (edge.kind === 'unknown' && edge.evidence.some(evidence => evidence.details?.requiresTogether === true)); }

export function collapseGraph(units: ChangeUnit[], edges: ChangeEdge[]): CollapsedGraph {
  const sorted = [...units].sort((a, b) => compare(a.id, b.id)), ids = sorted.map(unit => unit.id), uf = new UnionFind(ids), known = new Set(ids);
  if (known.size !== ids.length) throw new Error('Duplicate change unit identifiers');
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) throw new Error(`Edge ${edge.id} references an unknown change unit`);
    if (requiresTogether(edge)) uf.union(edge.from, edge.to);
  }
  const before = new Map<string, string[]>(), roots = [...new Set(ids.map(unit => uf.find(unit)))].sort(compare);
  for (const root of roots) before.set(root, []);
  for (const edge of edges) if (edge.kind === 'before') { const from = uf.find(edge.from), to = uf.find(edge.to); if (from !== to) before.get(from)!.push(to); }
  const cycles = stronglyConnected(roots, before).filter(component => component.length > 1), warnings: Evidence[] = [];
  for (const cycle of cycles) {
    for (const member of cycle.slice(1)) uf.union(cycle[0], member);
    warnings.push({ type: 'dependency-cycle', message: 'Le dipendenze cicliche richiedono un gruppo indivisibile.', details: { componentRoots: cycle } });
  }
  const members = new Map<string, ChangeUnit[]>();
  for (const unit of sorted) { const root = uf.find(unit.id); if (!members.has(root)) members.set(root, []); members.get(root)!.push(unit); }
  const components: Component[] = [...members.values()].map(group => ({ id: id('component', group.map(unit => unit.id)), units: group, reasons: [] })).sort((a, b) => compare(a.id, b.id));
  const componentOf = new Map<string, string>(), componentById = new Map(components.map(component => [component.id, component]));
  for (const component of components) for (const unit of component.units) componentOf.set(unit.id, component.id);
  const adjacencySets = new Map(components.map(component => [component.id, new Set<string>()]));
  for (const edge of [...edges].sort((a, b) => compare(a.id, b.id))) {
    const from = componentOf.get(edge.from)!, to = componentOf.get(edge.to)!;
    if (edge.kind === 'before' && from !== to) adjacencySets.get(from)!.add(to);
    if ((requiresTogether(edge) || edge.kind === 'before') && from === to) componentById.get(from)!.reasons.push(...edge.evidence);
  }
  for (const cycle of cycles) componentById.get(componentOf.get(cycle[0])!)!.reasons.push({ type: 'dependency-cycle', message: 'Ciclo before collassato: questi cambiamenti devono restare insieme.' });
  const adjacency = new Map([...adjacencySets].map(([key, value]) => [key, [...value].sort(compare)]));
  return { components, componentOf, adjacency, warnings };
}

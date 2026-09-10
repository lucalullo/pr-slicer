import type { ChangeEdge, ChangeUnit, Config } from '../core/model.js';
import type { Component } from '../graph/graph.js';
import { edgePenalty, segmentCost } from './scoring.js';

export const MAX_SEGMENT_BOUNDARIES = 800;
export interface Segmentation { segments: Component[][]; cost: number }

/** Exact contiguous DP up to 800 components; deterministic coarse boundaries beyond that. */
export function segmentOrder(order: Component[], edges: ChangeEdge[], config: Config): Segmentation[] {
  if (!order.length) return [];
  const count = Math.min(order.length, MAX_SEGMENT_BOUNDARIES), blocks: Component[][] = [];
  for (let i = 0; i < count; i++) blocks.push(order.slice(Math.floor(i * order.length / count), Math.floor((i + 1) * order.length / count)));
  const units = new Map<string, ChangeUnit>(), position = new Map<string, number>();
  blocks.forEach((block, i) => block.forEach(component => component.units.forEach(unit => { units.set(unit.id, unit); position.set(unit.id, i); })));
  const stride = count + 1, matrix = new Float64Array(stride * stride);
  let fixedCutCost = 0;
  const addPair = (from: number, to: number, weight: number, separate = false) => {
    matrix[(Math.min(from, to) + 1) * stride + Math.max(from, to) + 1] += separate ? weight : -weight;
    if (!separate) fixedCutCost += weight;
  };
  for (const edge of edges) addPair(position.get(edge.from)!, position.get(edge.to)!, edgePenalty(edge, units, config), edge.kind === 'separate');
  // Sparse cohesion hints avoid a quadratic clique for large packages or areas.
  const previousPackage = new Map<string, number>(), previousArea = new Map<string, number>();
  for (let i = 0; i < count; i++) for (const component of blocks[i]) for (const unit of component.units) {
    for (const [key, previous, weight] of [[unit.packageId, previousPackage, 1], [unit.area, previousArea, 2]] as const) {
      if (!key) continue; const prior = previous.get(key); if (prior !== undefined && prior !== i) addPair(prior, i, weight); previous.set(key, i);
    }
  }
  for (let row = 1; row <= count; row++) for (let col = 1; col <= count; col++) {
    const at = row * stride + col; matrix[at] += matrix[at - stride] + matrix[at - 1] - matrix[at - stride - 1];
  }
  const inside = (start: number, end: number) => matrix[end * stride + end] - matrix[start * stride + end] - matrix[end * stride + start] + matrix[start * stride + start];
  const costs = new Float64Array(stride * stride).fill(Infinity);
  const metadata = blocks.map(block => {
    const members = block.flatMap(component => component.units);
    return { lines: members.reduce((sum, unit) => sum + unit.addedLines + unit.deletedLines, 0), reviewLines: members.reduce((sum, unit) => sum + (unit.isGenerated ? 0 : unit.addedLines + unit.deletedLines), 0), files: members.map(unit => unit.newPath ?? unit.oldPath ?? unit.id), packages: members.map(unit => unit.packageId).filter((value): value is string => value !== null), areas: members.map(unit => unit.area).filter((value): value is string => value !== null) };
  });
  for (let start = 0; start < count; start++) {
    let lines = 0, reviewLines = 0; const files = new Set<string>(), packages = new Set<string>(), areas = new Set<string>();
    for (let end = start + 1; end <= count; end++) {
      const block = metadata[end - 1]; lines += block.lines; reviewLines += block.reviewLines;
      block.files.forEach(file => files.add(file)); block.packages.forEach(pkg => packages.add(pkg)); block.areas.forEach(area => areas.add(area));
      if (lines > config.limits.hardMaxChangedLines || files.size > config.limits.hardMaxFiles) break;
      costs[start * stride + end] = segmentCost(reviewLines, files.size, packages.size, areas.size, config) + inside(start, end);
    }
  }
  const maxGroups = Math.max(1, Math.min(20, Math.floor(config.limits.maxGroups), count));
  const dp = Array.from({ length: maxGroups + 1 }, () => new Float64Array(stride).fill(Infinity));
  const previous = Array.from({ length: maxGroups + 1 }, () => new Int32Array(stride).fill(-1)); dp[0][0] = 0;
  for (let groups = 1; groups <= maxGroups; groups++) for (let end = groups; end <= count; end++) for (let start = groups - 1; start < end; start++) {
    const candidate = dp[groups - 1][start] + costs[start * stride + end];
    if (candidate < dp[groups][end] - 1e-9) { dp[groups][end] = candidate; previous[groups][end] = start; }
  }
  const results: Segmentation[] = [];
  for (let groups = 1; groups <= maxGroups; groups++) {
    if (!Number.isFinite(dp[groups][count])) continue;
    const segments: Component[][] = []; let end = count;
    for (let remaining = groups; remaining > 0; remaining--) { const start = previous[remaining][end]; segments.unshift(blocks.slice(start, end).flat()); end = start; }
    results.push({ segments, cost: Math.round((dp[groups][count] + fixedCutCost) * 1e6) / 1e6 });
  }
  return results;
}

import { compare } from '../core/hashing.js';

/** Kahn with a binary heap: deterministic ties, O((V + E) log V). */
export function topologicalOrder(nodes: string[], adjacency: Map<string, string[]>, priority: (id: string) => string = id => id): string[] {
  const incoming = new Map(nodes.map(id => [id, 0])), heap: string[] = [], output: string[] = [];
  const keys = new Map(nodes.map(id => [id, priority(id)]));
  const less = (a: string, b: string) => compare(keys.get(a)!, keys.get(b)!) || compare(a, b);
  const push = (id: string) => {
    heap.push(id); let i = heap.length - 1;
    while (i > 0) { const parent = (i - 1) >> 1; if (less(heap[parent], heap[i]) <= 0) break; [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent; }
  };
  const pop = (): string => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      while (2 * i + 1 < heap.length) { let child = 2 * i + 1; if (child + 1 < heap.length && less(heap[child + 1], heap[child]) < 0) child++; if (less(heap[i], heap[child]) <= 0) break; [heap[i], heap[child]] = [heap[child], heap[i]]; i = child; }
    }
    return first;
  };
  for (const targets of adjacency.values()) for (const target of new Set(targets)) {
    if (!incoming.has(target)) throw new Error(`Unknown graph target: ${target}`);
    incoming.set(target, incoming.get(target)! + 1);
  }
  for (const node of nodes) if (incoming.get(node) === 0) push(node);
  while (heap.length) {
    const node = pop(); output.push(node);
    for (const target of new Set(adjacency.get(node) ?? [])) { const degree = incoming.get(target)! - 1; incoming.set(target, degree); if (degree === 0) push(target); }
  }
  if (output.length !== nodes.length) throw new Error('Cannot topologically order a cyclic graph');
  return output;
}

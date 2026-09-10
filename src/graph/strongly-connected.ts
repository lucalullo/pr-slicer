import { compare } from '../core/hashing.js';

/** Iterative Tarjan, O(V + E), including isolated vertices. */
export function stronglyConnected(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), active = new Set<string>(), stack: string[] = [], result: string[][] = [];
  let nextIndex = 0;
  const enter = (node: string) => { index.set(node, nextIndex); low.set(node, nextIndex++); active.add(node); stack.push(node); };
  for (const root of [...nodes].sort(compare)) {
    if (index.has(root)) continue;
    enter(root);
    const frames: { node: string; next: number; targets: string[] }[] = [{ node: root, next: 0, targets: [...(adjacency.get(root) ?? [])].sort(compare) }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.targets.length) {
        const target = frame.targets[frame.next++];
        if (!index.has(target)) { enter(target); frames.push({ node: target, next: 0, targets: [...(adjacency.get(target) ?? [])].sort(compare) }); }
        else if (active.has(target)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        continue;
      }
      frames.pop();
      if (frames.length) { const parent = frames[frames.length - 1].node; low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!)); }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do { popped = stack.pop()!; active.delete(popped); component.push(popped); } while (popped !== frame.node);
        result.push(component.sort(compare));
      }
    }
  }
  return result.sort((a, b) => compare(a[0], b[0]));
}

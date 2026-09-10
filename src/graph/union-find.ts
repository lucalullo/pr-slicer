import { compare } from '../core/hashing.js';

/** Stable representative plus iterative path compression: no recursion on large diffs. */
export class UnionFind {
  private parents = new Map<string, string>();
  constructor(ids: Iterable<string>) { for (const id of ids) this.parents.set(id, id); }
  find(id: string): string {
    if (!this.parents.has(id)) throw new Error(`Unknown graph node: ${id}`);
    let root = id;
    while (this.parents.get(root) !== root) root = this.parents.get(root)!;
    while (id !== root) { const parent = this.parents.get(id)!; this.parents.set(id, root); id = parent; }
    return root;
  }
  union(a: string, b: string): string {
    const left = this.find(a), right = this.find(b), root = compare(left, right) <= 0 ? left : right;
    this.parents.set(left === root ? right : left, root);
    return root;
  }
}

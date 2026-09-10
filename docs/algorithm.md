# Algorithm and interpretation

PR Slicer treats a Git change as a constrained partitioning problem.

## Planning pipeline

1. Resolve the local base/head commits and require a unique merge-base. Histories without a common
   ancestor or with an ambiguous merge-base are rejected.
2. Read NUL-delimited raw Git metadata, statistics, and zero-context hunks. Preserve original bytes,
   CRLF, final-newline markers, file modes, binary changes, renames, symlinks, and gitlinks.
3. Map changed hunks to AST declarations where possible. Hunks that touch the same declaration or an
   unsafe syntactic boundary are kept together. Areas, packages, tests, and generated files are
   annotated when evidence is available.
4. Extract structural relationships from the base and head snapshots:
   - additions can precede changed consumers;
   - removals must follow migrated consumers;
   - incompatible signature/reference changes can become hard constraints;
   - imports, tests, package boundaries, and configured areas add ordering or affinity evidence.
5. Collapse hard `must_with` relations with Union-Find, then collapse cycles in `before` relations with
   strongly connected components.
6. Generate stable topological orders using path, package, and area signals. Segment contiguous
   sequences with bounded dynamic programming while respecting hard limits and penalizing poor size,
   dispersion, and affinity cuts.
7. Keep a bounded set of distinct candidates and select the lowest-cost valid plan.
8. Reconstruct the complete diff and require the resulting Git tree object ID to equal the original
   head tree exactly.
9. If no valid partition exists, emit a single `cannot-safely-split` group instead of forcing an
   artificial split.
10. `verify` reconstructs each prefix. If an intermediate boundary fails, repair may merge that group
    with the next group, up to a deterministic bound. Final-state failure is never repaired away.

## Hard constraints and soft evidence

PR Slicer distinguishes between:

- **must stay together** — splitting is invalid;
- **must come before** — ordering is required;
- **affinity** — keeping the changes together is preferred but not mandatory;
- **unknown evidence** — uncertainty lowers confidence and can discourage splitting.

A relation marked `unknown` becomes hard only when its evidence explicitly requires the changes to
remain together.

## Complexity and bounds

The planner does not search for a theoretical global optimum.

Beyond 800 graph components, candidate boundaries are sampled deterministically to avoid unbounded
dynamic-programming growth. Large analyses may therefore miss a better split, but they never remove
changes from exact Git reconstruction.

Git object I/O uses `cat-file --batch-check` and batched content reads. The in-memory object cache is
bounded to one operation and is not persistent.

Fast snapshots include changed files, ancestor manifests, and direct imports. Deep/static snapshots
retain relevant JavaScript, TypeScript, JSON, and project-configuration context. Full project
snapshots are reserved for explicitly authorized project checks.

## Metrics

### Reviewability

Combines group size and structural dispersion.

### Structural cohesion

Measures how much known affinity remains inside the proposed groups.

### Dependency integrity

Measures whether known hard and ordered relationships are preserved.

### Verification coverage

The denominator is the number of reconstructed prefixes. A prefix counts as covered only when syntax
passes and all configured required checks actually pass. Skipped, failed, timed-out, or unavailable
project checks are not counted as passed.

An unverified plan reports `0/0`, not 100%.

### Boundary confidence

`boundaryConfidence` is `low`, `medium`, or `high`.

High confidence requires:

- at least two groups;
- all known hard constraints preserved;
- at least 90% structural affinity retained;
- two distinct observed provider/consumer pairs across every proposed boundary;
- strong `before` evidence for those pairs.

Duplicating evidence for the same provider/consumer pair does not increase confidence.

Confidence is a structural indicator, **not a probability that the program is correct**.

## Repair behavior

If verification merges adjacent groups:

- previous alternative candidates are invalidated;
- group metrics and dependencies are recomputed;
- titles remain deterministic and bounded;
- the complete reconstructed tree must still equal the original head tree.

## Benchmark scope

`npm run benchmark` compares planner strategies on synthetic graphs.

It does not benchmark:

- full repository build time;
- test-suite execution;
- human review time;
- universal end-to-end performance.

Exact final-tree identity is tested separately by integration tests.

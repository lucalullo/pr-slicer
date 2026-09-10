# Architecture

PR Slicer is a single TypeScript package built for Node.js and local Git.

TypeScript 5.9.3 is pinned in the lockfile. The CLI uses Node's native `util.parseArgs`, subprocesses
are started without an implicit shell, and tests use `node:test`.

## Modules

| Module | Responsibility |
|---|---|
| `core` | Versioned model, canonical hashing, plan validation, orchestration |
| `git` | Ref resolution, raw diff parsing, object reads, snapshots, tree reconstruction |
| `languages` | JavaScript/TypeScript AST, Program API, symbols, references, diagnostics |
| `graph` | Union-Find, SCC, DAG construction, deterministic topological ordering |
| `planner` | Candidate generation, segmentation, scoring, titles, metrics |
| `verify` | Prefix reconstruction, diagnostics, project checks, timeout handling, repair |
| `materialize` | Deterministic commits and atomic local ref creation |
| `config` | JSON/JSONC loading, normalization, schema |
| `report` | Terminal, Markdown, and JSON output |
| `cli` | Command-line interface |

## Snapshot design

The original specification considered temporary Git worktrees. The implementation instead uses:

- Git blob snapshots;
- a temporary Git index;
- isolated object storage;
- alternates pointing to the source repository's object database.

This avoids:

- checkout;
- worktree registration;
- hooks;
- smudge/clean filters;
- mutation of the source repository object database during analysis.

Regular source files are copied into analysis snapshots only when needed. Symlinks and gitlinks remain
opaque Git tree entries and are never dereferenced or initialized automatically.

Each prefix is reconstructed from the base tree through a temporary index. The output is a real Git
tree object, not code regenerated from an AST.

## Materialization

Materialization revalidates the plan and reconstructs the already-verified prefix trees.

Commit objects are built deterministically in isolated storage. New objects are validated against
their expected object IDs before being published into the repository object database. Local branch
refs are then created in one `update-ref` transaction.

If the ref transaction fails, partial branch creation is avoided. Unreferenced objects may remain and
can be collected later by normal Git garbage collection.

Existing branch names are never overwritten.

## Plan integrity

The plan contains immutable base/head/merge-base object IDs, file changes, units, graph relations,
groups, configuration, and structural evidence.

A canonical SHA-256 digest covers the structural data used for reconstruction and planning. Human
titles and timing metadata are intentionally excluded where repeatable verification must remain
possible.

The digest is **not a cryptographic signature of authorship**.

Before using a plan, PR Slicer rereads the referenced Git commits, validates the diff, checks
cross-references, and reconstructs expected trees. Treat plans received from other people as
untrusted input, especially before authorizing project checks.

## Local API

```ts
import { createPlan, verifyPlan, materializePlan } from "pr-slicer";

const plan = createPlan({
  repo: ".",
  base: "main",
  head: "HEAD",
  mode: "deep",
});

const verified = await verifyPlan(plan, {
  semantic: true,
  runChecks: false,
});

const preview = materializePlan(verified, {
  prefix: "slice/feature",
  dryRun: true,
});
```

Git analysis APIs are synchronous. Verification is asynchronous because explicitly configured local
processes may run.

`AnalysisResult` is the extension boundary for future language adapters. Version 0.1.0 implements
JavaScript and TypeScript only.

## Technical references

- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [git update-index](https://git-scm.com/docs/git-update-index)
- [git update-ref](https://git-scm.com/docs/git-update-ref)

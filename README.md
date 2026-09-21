# PR Slicer

PR Slicer is a local, deterministic CLI for JavaScript and TypeScript repositories. It analyzes a
committed Git change, finds conservative slice boundaries, verifies that the complete stack
reconstructs the original `HEAD` exactly, and can materialize the result as ordered local branches.

PR Slicer 0.1.0 is an experimental pre-1.0 release intended for local evaluation and practical use on
non-critical repositories. It does not claim to prove functional correctness or to find a safe split
for every change.

**No AI, cloud service, GitHub API, telemetry, or code upload is required.**

## Highlights in 0.1.0

- one-command analysis with `pr-slicer plan`;
- JavaScript and TypeScript support for `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, and `.cts`;
- exact Git hunk preservation instead of source regeneration;
- AST and TypeScript Compiler API analysis for declarations, imports, exports, symbols, and references;
- hard `must_with` constraints, ordered `before` relations, and soft structural affinity;
- deterministic grouping, topological ordering, candidate generation, and scoring;
- conservative fallback to one group when a safe split cannot be justified;
- exact final-tree reconstruction before a plan is accepted;
- prefix-by-prefix syntax verification and optional TypeScript semantic diagnostics;
- optional local project checks such as tests, lint, or builds, executed only when explicitly authorized;
- bounded repair by merging adjacent groups when an intermediate boundary fails verification;
- deterministic commits and atomic local branch creation through Git plumbing;
- terminal, JSON, and Markdown reports;
- `doctor` and `explain` commands for environment and decision inspection;
- no remote fetch, automatic push, background service, or implicit project-code execution;
- Node.js 22+ and Git 2.38+.

The planner is deliberately conservative: a larger valid group is preferable to a smaller split that
cannot be justified safely.

## Installation

Requirements are Node.js 22+ and Git 2.38+.

From GitHub:

```bash
git clone https://github.com/lucalullo/pr-slicer.git
cd pr-slicer
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

Then, from the repository you want to analyze:

```bash
pr-slicer plan
```

If the npm package is available:

```bash
npm install --global pr-slicer
pr-slicer plan
```

Or without a global installation:

```bash
npx pr-slicer plan
```

The npm installation itself requires network access. PR Slicer does not use the network while
analyzing, verifying, or materializing a repository.

If a `pr-slicer-0.1.0.tgz` asset is attached to the GitHub release:

```bash
npm install --global ./pr-slicer-0.1.0.tgz
pr-slicer --version
```

The runtime package has one dependency: TypeScript 5.9.3.

## Quick start

From a feature branch with committed changes relative to `main`:

```bash
pr-slicer plan
```

By default PR Slicer analyzes:

```text
base = main
head = HEAD
```

A large change can produce a plan like:

```text
34 changed files · 1,842 changed lines
Recommended split: 3 groups

1. Add session expiration model
   5 files

2. Enforce expiration in authentication
   11 files · depends on #1

3. Add expiration state to the UI
   8 files · depends on #2

✓ Exact final tree preserved
✓ No changes lost
✓ No changes invented
```

If the base branch is different:

```bash
pr-slicer plan --base develop
```

For a faster structural pass on a large repository:

```bash
pr-slicer plan --fast
```

`plan` does not run builds, tests, package scripts, hooks, or project code.

## Core workflow

### 1. Plan

Analyze `main..HEAD`:

```bash
pr-slicer plan
```

Use explicit refs when needed:

```bash
pr-slicer plan --base main --head feature/session
```

Save a machine-readable plan:

```bash
pr-slicer plan --format json --output ../plan.json
```

Or a Markdown report:

```bash
pr-slicer plan --format markdown --output ../plan.md
```

PR Slicer always keeps the complete original change. Excluding a path from semantic analysis never
removes it from exact Git reconstruction.

### 2. Verify

Reconstruct every planned prefix and run built-in syntax checks:

```bash
pr-slicer verify ../plan.json --output ../verified.json
```

Add TypeScript semantic diagnostics:

```bash
pr-slicer verify ../plan.json --semantic --output ../verified.json
```

Project-specific commands are never executed implicitly. To run checks declared in
`.pr-slicer.json`, authorize them explicitly:

```bash
pr-slicer verify ../plan.json \
  --semantic \
  --run-checks \
  --output ../verified.json
```

If a configured check needs already-installed project dependencies:

```bash
pr-slicer verify ../plan.json \
  --semantic \
  --run-checks \
  --node-modules ./node_modules \
  --output ../verified.json
```

Passing verification means the requested checks passed for the reconstructed prefixes. It does not
prove absolute functional correctness.

### 3. Preview the stack

```bash
pr-slicer materialize ../verified.json \
  --prefix slice/session \
  --dry-run
```

### 4. Materialize local branches

```bash
pr-slicer materialize ../verified.json \
  --prefix slice/session
```

For three groups, branches look like:

```text
slice/session/01
slice/session/02
slice/session/03
```

PR Slicer does not checkout the branches, overwrite existing branch names, or push anything.

## How it works

At a high level:

```text
base commit + head commit
          ↓
raw Git diff and exact hunks
          ↓
AST and TypeScript symbol analysis
          ↓
change units
          ↓
dependency and affinity graph
          ↓
hard-constraint collapsing
          ↓
stable topological candidates
          ↓
deterministic slice planning
          ↓
exact final-tree reconstruction
          ↓
optional prefix verification
          ↓
local deterministic branches
```

### Git first, AST second

Git hunks are the material unit of reconstruction. PR Slicer does **not** regenerate source code with
an AST printer.

AST analysis adds structural meaning: which declaration changed, which symbols are referenced, which
imports connect files, which changes look like tests, and where a boundary may be unsafe.

That separation is intentional:

- Git preserves the exact original change;
- AST analysis adds structure;
- the planner proposes boundaries;
- reconstruction proves that the full stack reaches the original `HEAD`.

### Relationship types

The planner uses three main relationship classes:

- **must stay together** — splitting would violate a known hard constraint;
- **must come before** — one change provides something another change consumes;
- **affinity** — related changes should preferably stay together, but separation is allowed.

Hard relations are collapsed before planning. Ordering cycles become one component. The remaining
graph is ordered deterministically and segmented into a bounded set of candidate stacks.

PR Slicer does not claim a theoretical global optimum. It uses deterministic heuristics and
conservative constraints designed for reviewable output.

See [docs/algorithm.md](docs/algorithm.md) for the detailed algorithm.

## Exact reconstruction

The central invariant is:

```text
base + every planned group = original head tree
```

Before accepting a plan, PR Slicer reconstructs the complete change using Git objects and requires the
final tree object ID to match the original head tree exactly.

This preserves the Git result across:

- regular files;
- additions and deletions;
- renames;
- binary files;
- file modes;
- CRLF and LF;
- missing final newlines;
- symlinks as Git objects;
- gitlinks/submodule entries.

Exact tree identity proves that the complete stack reproduces the original committed result. It does
not prove that every intermediate program state is semantically or behaviorally correct.

## Verification levels

PR Slicer keeps different kinds of evidence separate instead of collapsing them into an ambiguous
"quality score".

### Reconstruction

The complete planned change reconstructs the original head tree.

### Syntax

Reconstructed JavaScript and TypeScript inputs parse at each required prefix.

### Semantic diagnostics

With `--semantic`, PR Slicer uses the bundled TypeScript compiler and available project configuration
to produce semantic diagnostics.

The report states the compiler version used. To use the project's own TypeScript compiler, configure
an explicit project check.

### Project checks

A project can define local build, test, lint, or other commands:

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "name": "test",
      "command": "npm",
      "args": ["test"],
      "timeoutMs": 300000
    }
  ]
}
```

They run only when explicitly authorized:

```bash
pr-slicer verify ../plan.json --run-checks
```

Review configured commands before running them.

## Configuration

PR Slicer works without a configuration file.

Defaults:

```text
base = main
head = HEAD
max groups = 5
target changed lines per group = 350
```

For project-specific behavior, copy `.pr-slicer.example.json` to `.pr-slicer.json`.

Example:

```json
{
  "schemaVersion": 1,
  "limits": {
    "maxGroups": 5,
    "targetChangedLines": 350,
    "hardMaxChangedLines": 800
  },
  "areas": [
    {
      "name": "Auth",
      "patterns": ["src/auth/**"]
    }
  ],
  "checks": [
    {
      "name": "test",
      "command": "node",
      "args": ["--test"],
      "timeoutMs": 300000
    }
  ]
}
```

JSON and JSONC are supported. JavaScript configuration files are intentionally not executed.

See [docs/configuration.md](docs/configuration.md).

## Useful commands

```bash
# Check the local environment without running project code
pr-slicer doctor

# Analyze main..HEAD
pr-slicer plan

# Use another base branch
pr-slicer plan --base develop

# Limit the number of groups
pr-slicer plan --max-groups 3

# Prefer smaller groups
pr-slicer plan --target-lines 250

# Faster, shallower analysis
pr-slicer plan --fast

# Save JSON or Markdown
pr-slicer plan --format json --output ../plan.json
pr-slicer plan --format markdown --output ../plan.md

# Verify reconstructed prefixes
pr-slicer verify ../plan.json --output ../verified.json
pr-slicer verify ../plan.json --semantic --output ../verified.json

# Explicitly authorize configured project checks
pr-slicer verify ../plan.json --semantic --run-checks --output ../verified.json

# Explain one group or graph edge
pr-slicer explain ../plan.json --group slice-1
pr-slicer explain ../plan.json --edge FROM:TO

# Preview and create local branches
pr-slicer materialize ../verified.json --prefix slice/feature --dry-run
pr-slicer materialize ../verified.json --prefix slice/feature
```

## Programmatic API

```javascript
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

## Safety and privacy

The PR Slicer core is designed to operate locally.

It contains no:

- HTTP client;
- GitHub API integration;
- LLM integration;
- telemetry;
- update checker;
- remote fetch;
- automatic dependency installation;
- automatic push.

Git is invoked with structured arguments. Remote protocols, hooks, external diff, text conversion,
lazy fetch, and filesystem monitoring are disabled where relevant.

`plan` and normal `verify` do not execute project code.

`--run-checks` explicitly authorizes configured local commands. They run with a reduced environment,
timeouts, bounded logs, and no implicit shell, but **they are not a system sandbox**. They retain the
operating-system permissions of the current user.

For untrusted repositories, use an isolated user account, VM, or container before authorizing project
checks.

See [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

## Materialization safety

Before creating branches, PR Slicer revalidates the plan and Git refs, reconstructs verified prefix
trees, and confirms the expected final result.

New Git objects are prepared in private staging storage, checked against their expected object IDs,
and published without blindly overwriting existing objects. Branch refs are created in one Git
reference transaction.

Materialization:

- does not change `HEAD`;
- does not checkout generated branches;
- does not push;
- does not overwrite existing branch names;
- does not intentionally modify the working tree or index;
- uses deterministic commit metadata derived from the plan.

The 0.1.0 release requires a clean working tree as a conservative operational guard.

## Performance

PR Slicer batches Git object reads and uses bounded in-memory caching.

Fast snapshots contain changed files plus the minimum structural context required for direct analysis.
Deep analysis keeps relevant JavaScript, TypeScript, JSON, and configuration context. Full project
snapshots are reserved for project checks explicitly authorized by the user.

For very large graphs, candidate planning is sampled deterministically to keep computation bounded.
This can miss a better split, but it never removes changes from exact reconstruction.

The bundled benchmark measures planner strategies on synthetic graphs:

```bash
npm run benchmark
```

It is a planner benchmark, not a universal repository-performance claim.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run test:package
npm run benchmark
npm pack
```

The test suite covers graph behavior, AST analysis, Git parsing, path safety, hunk reconstruction,
timeouts, configuration validation, deterministic commits, packaging, large files, renames, binary
files, CRLF, Unicode, symlinks, gitlinks, and end-to-end final-tree identity.

CI is configured for Ubuntu, macOS, and Windows on Node.js 22 and 24.

## Documentation

- [Algorithm](docs/algorithm.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Implementation status](docs/implementation-status.md)
- [Security model](docs/security.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Limitations

- JavaScript and TypeScript repositories only in 0.1.0;
- analysis requires local Git commits and a unique merge-base;
- unrelated histories and ambiguous criss-cross merge bases are rejected;
- bare repositories are unsupported;
- Git paths must be valid UTF-8 and representable on the current operating system;
- symlinks and gitlinks are preserved as Git objects but are not dereferenced or semantically analyzed;
- semantic verification can be unavailable when a complete safe analysis snapshot cannot be established;
- PR Slicer does not understand arbitrary business intent;
- it does not prove that a refactoring is behaviorally equivalent;
- it does not guarantee safe deployment ordering for database migrations;
- it does not prove that passing tests are complete;
- configured project checks are local processes, not sandboxed workloads;
- it does not create GitHub pull requests, call the GitHub API, fetch remotes, or push branches;
- materialization currently requires a clean working tree;
- large repositories may use reduced or sampled analysis to remain bounded;
- a single-group result can be the correct result when no safe split is supported by the available evidence.

## Status

PR Slicer 0.1.0 is experimental and pre-1.0. The planner, verification model, and public API may evolve as broader real-world validation continues.

The main correctness target for this release is deliberately narrow and testable:

> **When PR Slicer proposes and materializes a verified stack, the complete stack must reconstruct the
> original Git head tree exactly.**

## License

PR Slicer is created by Luca Lullo and released under the [MIT License](LICENSE).

## Author

Created by [Luca Lullo](https://github.com/lucalullo).

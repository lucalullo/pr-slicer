# Implementation status — 0.1.0

Version 0.1.0 implements the complete local workflow:

```text
plan → verify → materialize
```

It also includes `explain` and `doctor`.

## MVP coverage

| Capability | Status |
|---|---|
| Local/offline core, no account or LLM | Implemented |
| Two local Git refs with unique merge-base | Implemented |
| JS/TS source analysis | Implemented |
| Raw file/hunk/rename/mode handling | Implemented |
| Semantic hunk mapping | Implemented where structurally observable |
| Serializable dependency graph | Implemented |
| Ordered groups | Implemented |
| Hard `must_with` constraints | Implemented |
| Safe single-group fallback | Implemented |
| Exact final head tree | Implemented and integration-tested |
| Terminal/JSON/Markdown reports | Implemented |
| Deterministic planning | Implemented |
| Non-destructive `plan` | Implemented |
| Explicit project checks | Implemented |
| End-to-end Git fixtures | Implemented |
| Path/symlink/timeout/diff hardening | Implemented |
| Deterministic materialized commits | Implemented |
| Atomic local branch ref creation | Implemented |
| Large-file and batch-object handling | Implemented |
| npm/source packaging tests | Implemented |
| Linux/macOS/Windows CI matrix | Configured |

## Conservative behavior

The preview deliberately prefers refusing or merging a boundary over claiming more certainty than the
available evidence supports.

Examples:

- symlinks and gitlinks are preserved but not followed;
- generated files are preserved but not regenerated;
- signature compatibility is structural, not behavioral;
- unchanged consumers are not assumed to be compatible without supporting verification;
- project checks run only when explicitly authorized;
- large graphs can use deterministic sampling;
- a single-group result is valid when no safe split is justified.

## Plan validation

The public JSON plan is versioned and validated recursively.

Validation covers:

- file and hunk references;
- group membership and ordering;
- hard constraints;
- candidate consistency;
- derived statistics and metrics;
- verification metadata;
- prefix trees;
- digest consistency;
- final-tree identity.

The plan digest detects structural modification but is not an authenticity signature.

## Verification scope

`verify` checks the selected plan and bounded adjacent-group repair.

It does not execute build/test commands against every static candidate.

Built-in TypeScript diagnostics use the compiler bundled with PR Slicer. Project-specific compiler,
build, lint, or test commands must be configured explicitly.

## Not implemented in 0.1.0

The following are possible future extensions, not requirements for the Technical Preview:

- persistent/incremental cache;
- Git-history co-change analysis;
- uncommitted working-tree input;
- additional languages;
- database-migration adapters;
- integrated container sandboxing;
- coverage-aware planning;
- terminal UI;
- automatic patch-series export;
- GitHub API or pull-request creation.

The core project intentionally remains useful without any external service.

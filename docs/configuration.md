# Configuration

PR Slicer works without a configuration file.

The loader searches the Git repository root for:

1. `.pr-slicer.json`
2. `.pr-slicer.jsonc`

Use `--config FILE` to select another JSON/JSONC file.

JavaScript configuration files are intentionally unsupported because configuration must not execute
project code.

## Defaults

| Setting | Default | Meaning |
|---|---:|---|
| `schemaVersion` | `1` | Configuration format version |
| `base` | `main` | Base ref |
| `head` | `HEAD` | Head ref |
| `limits.maxGroups` | `5` | Maximum planned groups |
| `limits.targetChangedLines` | `350` | Preferred changed lines per group |
| `limits.hardMaxChangedLines` | `800` | Hard changed-line limit for a normal group |
| `limits.targetFiles` | `12` | Preferred files per group |
| `limits.hardMaxFiles` | `30` | Hard file-count limit for a normal group |

CLI options override the corresponding configuration values.

## Example

```json
{
  "$schema": "./src/config/schema.json",
  "schemaVersion": 1,
  "base": "main",
  "head": "HEAD",
  "limits": {
    "maxGroups": 5,
    "targetChangedLines": 350,
    "hardMaxChangedLines": 800,
    "targetFiles": 12,
    "hardMaxFiles": 30
  },
  "areas": [
    {
      "name": "Core",
      "patterns": ["src/core/**", "src/git/**"]
    },
    {
      "name": "CLI",
      "patterns": ["src/cli/**", "src/report/**"]
    }
  ],
  "relations": {
    "keepTestsWithImplementation": true,
    "generatedFrom": []
  },
  "checks": [
    {
      "name": "build",
      "command": "node",
      "args": ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"],
      "timeoutMs": 300000
    }
  ],
  "environment": {
    "inherit": false,
    "allow": ["CI"]
  }
}
```

## Areas

`areas` associates paths with human-defined structural areas. Area membership can influence affinity
and candidate ordering but does not remove changes from reconstruction.

Patterns are repository-relative.

## Test relationships

`relations.keepTestsWithImplementation` enables test/implementation affinity where the analyzer can
identify a relationship.

This is evidence, not a guarantee that every test is matched to the correct implementation.

## Generated files

`relations.generatedFrom` can describe producer/output relationships that cannot be inferred safely.

Generated files remain part of exact Git reconstruction. PR Slicer does not regenerate them
automatically.

## Project checks

Checks are local commands that may run during `verify` only when `--run-checks` is supplied.

Example:

```json
{
  "name": "test",
  "command": "npm",
  "args": ["test"],
  "timeoutMs": 300000
}
```

The command is executed without an implicit shell.

PR Slicer does not install missing dependencies. If a check requires an already-installed
`node_modules`, share it explicitly with:

```bash
pr-slicer verify plan.json --run-checks --node-modules ./node_modules
```

Configured checks execute project code and are not a system sandbox.

## Environment

By default, project checks receive a reduced environment.

`environment.inherit` controls broad inheritance and `environment.allow` can allow selected variables.
Avoid passing secrets to untrusted project code.

## Analysis limits

Large source files and very large graphs are handled conservatively.

Oversized or opaque source inputs can become atomic changes. Exact Git reconstruction remains the
primary invariant even when semantic analysis is reduced or unavailable.

The plan JSON size limit is 100 MiB. The same bound is applied when writing and reading plans.

## TypeScript compiler

Built-in semantic diagnostics report the TypeScript version bundled with PR Slicer.

They do not automatically load or download the project's compiler.

To verify with the project's own compiler, configure an explicit project check and provide its
already-installed dependencies if needed.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Operation succeeded; for `plan`, a plan was produced |
| `1` | Invalid input/config/plan/Git state or operational error |
| `2` | `verify`: syntax, semantic, configured check failure, or timeout |
| `3` | `verify`: required environment or snapshot unavailable |

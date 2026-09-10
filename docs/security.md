# Security and privacy model

PR Slicer is designed around a local, offline core.

## Network behavior

The core contains no:

- HTTP client;
- GitHub API integration;
- telemetry;
- update checker;
- remote fetch;
- LLM integration.

Git operations disable remote protocols and lazy fetch where relevant.

Installing PR Slicer through npm or cloning it from GitHub naturally requires network access. That is
separate from runtime repository analysis.

## Project code execution

`plan` does not execute project code.

Normal `verify` does not run configured project commands.

Only:

```bash
pr-slicer verify plan.json --run-checks
```

explicitly authorizes configured local processes.

Those commands run:

- without an implicit shell;
- in a temporary directory;
- with a reduced environment;
- with timeouts;
- with bounded logs.

This is **not a system sandbox**. Authorized processes retain the operating-system permissions of the
current user.

For untrusted repositories, use a dedicated user account, VM, or container before running project
checks.

## Git hardening

Git is invoked with structured arguments.

Where relevant, PR Slicer disables or avoids:

- hooks;
- external diff;
- text conversion;
- clean/smudge execution;
- fsmonitor;
- lazy fetch;
- remote protocols;
- automatic checkout.

Source blobs are read directly rather than by executing repository configuration.

## Paths and special entries

PR Slicer rejects unsafe path forms including traversal and NUL-containing paths.

Snapshots do not dereference symlinks.

Binary files, symlinks, and gitlinks are preserved as Git object IDs and modes rather than interpreted
as normal source files.

Unchanged symlinks/gitlinks can coexist with syntax verification of ordinary files. Semantic
verification or project checks may remain unavailable when a complete safe snapshot cannot be
established.

Submodules are never initialized or fetched automatically.

## Plan files

Plan JSON is untrusted input.

Validation rechecks:

- referenced commits;
- diff content;
- hunk coverage;
- graph references;
- groups and candidates;
- derived metrics;
- verification metadata;
- reconstructed prefix trees;
- structural digest.

The digest is not a signature and does not prove who created the plan.

Do not authorize project checks from a plan you have not reviewed.

## Materialization

Materialization requires an unchanged plan with passed verification.

Commit metadata is deterministic and explicit. Automatic commit signing is disabled for generated
commit objects.

New Git objects are created in private same-filesystem staging storage, validated against their
expected object IDs, and published atomically without overwriting a valid existing object.

Local branches are created in one Git reference transaction.

Materialization does not:

- checkout generated branches;
- change `HEAD`;
- push;
- overwrite existing branch names;
- intentionally modify the working tree or index.

Version 0.1.0 requires a clean working tree as a conservative guard.

## Large objects

Object type and size are inspected before source decoding.

Oversized blobs can be handled atomically without semantic parsing. Corrupt objects, invalid zlib
streams, trailing compressed data, or configured object-size violations produce controlled errors.

## Logs and reports

Terminal and Markdown output sanitize ANSI sequences, control characters, bidirectional-control
characters, and dynamic Markdown delimiters where required.

JSON and project-check logs can still contain repository code or test output. Treat saved reports
according to the sensitivity of the analyzed project.

## Temporary files

Snapshots and temporary Git storage are removed in `finally` cleanup paths after normal completion or
handled errors.

A hard process or system termination can leave `pr-slicer-*` directories in the operating-system
temporary directory. They may be removed when no PR Slicer process is running.

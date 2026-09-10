# Contributing

Contributions are welcome.

Use Node.js 22 or 24 and Git 2.38 or newer. From a clean checkout:

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run test:package
npm run benchmark
```

## Project invariants

Keep the core local, deterministic, and offline.

Do not add:

- implicit project-code execution;
- JavaScript configuration files;
- remote fetches or GitHub API calls;
- telemetry;
- LLM dependencies;
- hidden network behavior.

Every new graph rule must produce serializable evidence and include at least one fixture that
demonstrates the intended behavior.

Changes to Git reconstruction or materialization must prove final-tree identity, preserve file bytes,
paths, and modes, and leave the source branch and working tree untouched.

The public plan format is versioned. Do not change its schema or digest contract without documenting
compatibility and adding migration/rejection tests.

For future language adapters, use the existing `AnalysisResult` boundary. Do not mix language-specific
analysis with Git reconstruction.

## Pull requests

Keep pull requests focused. Explain:

1. the concrete problem;
2. the resulting behavior;
3. the tests or fixtures that prove it;
4. any compatibility, safety, or performance trade-off.

For planner or Git changes, include a fixture that demonstrates final-tree identity.

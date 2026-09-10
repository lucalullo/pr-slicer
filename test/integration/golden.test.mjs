import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { goldenNames, goldenScenario } from '../fixtures/goldens.mjs';
for (const name of goldenNames) test(`golden JSON, Markdown and graph: ${name}`, t => {
  const result = goldenScenario(t, name);
  assert.equal(result.json, fs.readFileSync(`test/golden/${name}.json`, 'utf8'));
  assert.equal(result.markdown, fs.readFileSync(`test/golden/${name}.md`, 'utf8'));
  assert.equal(result.edges, fs.readFileSync(`test/golden/${name}.graph.json`, 'utf8'));
});

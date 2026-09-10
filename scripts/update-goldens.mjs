import fs from 'node:fs';
import { goldenNames, goldenScenario } from '../test/fixtures/goldens.mjs';
for (const name of goldenNames) {
  const cleanups = [];
  try {
    const result = goldenScenario({ after: f => cleanups.push(f) }, name);
    fs.writeFileSync(`test/golden/${name}.json`, result.json); fs.writeFileSync(`test/golden/${name}.md`, result.markdown); fs.writeFileSync(`test/golden/${name}.graph.json`, result.edges);
  } finally { cleanups.forEach(f => f()); }
}
console.log('Golden files aggiornati. Esaminare il diff prima del commit.');

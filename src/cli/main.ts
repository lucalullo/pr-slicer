#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TOOL_VERSION, type SlicePlan } from '../core/model.js';
import { SlicerError } from '../core/errors.js';
import { createPlan } from '../core/create-plan.js';
import { validatePlan } from '../core/plan.js';
import { readPlanJson, serializePlan } from '../core/plan-size.js';
import { loadConfig, normalizeConfig } from '../config/index.js';
import { git } from '../git/index.js';
import { verifyPlan } from '../verify/index.js';
import { materializePlan } from '../materialize/index.js';
import { explainGroup, formatPlan } from '../report/index.js';
import { sanitizeText } from '../core/sanitize.js';

const HELP = `PR Slicer ${TOOL_VERSION} — decomposizione locale JavaScript/TypeScript

Uso:
  pr-slicer plan --repo . --base main --head HEAD [--format json|markdown|terminal]
  pr-slicer verify plan.json [--semantic] [--run-checks] [--output verified.json]
  pr-slicer materialize verified.json --prefix slice/feature [--dry-run]
  pr-slicer explain plan.json --group ID
  pr-slicer explain plan.json --edge FROM:TO
  pr-slicer doctor [--repo .]

Opzioni:
  --config FILE          Configurazione JSON/JSONC; default .pr-slicer.json(c)
  --max-groups N         Massimo gruppi (1–20; default 5)
  --target-lines N       Dimensione obiettivo (default 350)
  --fast                 AST e import diretti; default analisi deep con Compiler API
  --output FILE          Salva l'output; default stdout
  --semantic             Verifica TypeScript con tsconfig/jsconfig disponibili
  --run-checks           Autorizza i comandi di progetto configurati
  --node-modules DIR     Condivide esplicitamente dipendenze locali con la verifica
  --no-repair            Non fondere gruppi dopo un errore intermedio
  --dry-run              Mostra branch/commit previsti senza crearli
  --help, -h             Mostra questo aiuto
  --version, -v          Versione

plan non esegue script. verify non installa dipendenze. materialize non fa push.
Exit code: 0 successo; 1 errore input/Git; 2 verifica fallita; 3 verifica indisponibile.
`;
function readPlan(file?: string): SlicePlan {
  if (!file) throw new SlicerError('Specificare il file piano JSON.');
  const plan: unknown = readPlanJson(file);
  validatePlan(plan); return plan;
}
function integer(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new SlicerError(`Atteso intero positivo: ${text}`);
  return Number(text);
}
function available(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command);
  return (process.env.PATH ?? '').split(delimiter).some(dir => ['', ...(process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [])].some(ext => existsSync(join(dir, command + ext))));
}
async function main(): Promise<void> {
  const parsed = parseArgs({ allowPositionals: true, strict: true, options: {
    repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, config: { type: 'string' }, format: { type: 'string' }, output: { type: 'string' },
    'max-groups': { type: 'string' }, 'target-lines': { type: 'string' }, fast: { type: 'boolean' }, semantic: { type: 'boolean' }, 'run-checks': { type: 'boolean' },
    'node-modules': { type: 'string' }, 'no-repair': { type: 'boolean' }, prefix: { type: 'string' }, 'dry-run': { type: 'boolean' }, group: { type: 'string' }, edge: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
  } });
  const v = parsed.values;
  function output(content: string): void {
    if (v.output) { const target = resolve(v.output); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, 'utf8'); }
    else process.stdout.write(content);
  }
  if (v.version) { output(TOOL_VERSION + '\n'); return; }
  const [command, file, ...extra] = parsed.positionals;
  if (v.help || !command) { output(HELP); return; }
  if (extra.length || (file && !['verify', 'materialize', 'explain'].includes(command))) throw new SlicerError('Argomenti posizionali inattesi. Usa --help.');
  if (command === 'plan') {
    const root = git(resolve(v.repo ?? '.'), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    let config = loadConfig(root, v.config);
    config = normalizeConfig({ ...config, limits: { ...config.limits, maxGroups: integer(v['max-groups'], config.limits.maxGroups), targetChangedLines: integer(v['target-lines'], config.limits.targetChangedLines) } });
    const plan = createPlan({ repo: root, base: v.base, head: v.head, config, mode: v.fast ? 'fast' : 'deep' });
    output(formatPlan(plan, v.format ?? 'terminal')); return;
  }
  if (command === 'verify') {
    const result = await verifyPlan(readPlan(file), { runChecks: v['run-checks'], semantic: v.semantic, nodeModules: v['node-modules'], repair: !v['no-repair'] });
    output(formatPlan(result, v.format ?? 'json'));
    process.exitCode = result.verification.status === 'failed' ? 2 : result.verification.status === 'verification-unavailable' ? 3 : 0; return;
  }
  if (command === 'materialize') {
    if (!v.prefix) throw new SlicerError('Specificare --prefix per le nuove branch locali.');
    const plan = readPlan(file);
    process.stderr.write('Branch previste: ' + plan.groups.map((_, i) => sanitizeText(`${v.prefix}/${String(i + 1).padStart(2, '0')}`)).join(', ') + '\n');
    const result = materializePlan(plan, { prefix: v.prefix, dryRun: v['dry-run'] });
    output(serializePlan({ dryRun: !!v['dry-run'], ...result })); return;
  }
  if (command === 'explain') {
    const plan = readPlan(file);
    if (!!v.group === !!v.edge) throw new SlicerError('Specificare esattamente una tra --group e --edge.');
    if (v.group) {
      const group = plan.groups.find(g => g.id === v.group) ?? (/^slice-\d+$/.test(v.group) ? plan.groups[Number(v.group.slice(6)) - 1] : undefined);
      if (!group) throw new SlicerError('Gruppo non trovato.');
      output(explainGroup(plan, group));
    } else {
      const edges = plan.edges.filter(e => e.id === v.edge || `${e.from}:${e.to}` === v.edge);
      if (!edges.length) throw new SlicerError('Arco non trovato.');
      output(serializePlan(edges));
    }
    return;
  }
  if (command === 'doctor') {
    const checks: { name: string; ok: boolean; detail: string }[] = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
    const repo = resolve(v.repo ?? '.');
    try { checks.push({ name: 'Git', ok: true, detail: git(repo, ['--version']).toString().trim() }); } catch (e) { checks.push({ name: 'Git', ok: false, detail: String(e) }); }
    try {
      const root = git(repo, ['rev-parse', '--show-toplevel']).toString().trim();
      checks.push({ name: 'Repository', ok: true, detail: root });
      const tracked = git(root, ['ls-files', '-z']).toString().split('\0');
      const configs = tracked.filter(f => /(?:^|\/)(ts|js)config(?:\.[^/]+)?\.json$/.test(f));
      checks.push({ name: 'Progetti TypeScript/JavaScript', ok: true, detail: configs.join(', ') || 'Nessuna config: analisi AST disponibile' });
      const config = loadConfig(root, v.config);
      for (const check of config.checks) checks.push({ name: `Comando ${check.name}`, ok: available(check.command), detail: check.command + ' (solo presenza; non eseguito)' });
    } catch (e) { checks.push({ name: 'Repository/config', ok: false, detail: String(e) }); }
    try { const dir = mkdtempSync(join(tmpdir(), 'pr-slicer-doctor-')); rmSync(dir, { recursive: true }); checks.push({ name: 'Directory temporanea', ok: true, detail: 'Scrivibile' }); } catch (e) { checks.push({ name: 'Directory temporanea', ok: false, detail: String(e) }); }
    output(v.format === 'json' ? serializePlan(checks) : checks.map(c => `${c.ok ? 'OK' : 'ERRORE'} ${sanitizeText(c.name)}: ${sanitizeText(c.detail)}`).join('\n') + '\n');
    if (checks.some(c => !c.ok)) process.exitCode = 1; return;
  }
  throw new SlicerError(`Comando sconosciuto: ${command}. Usa --help.`);
}
main().catch(error => { process.stderr.write(`pr-slicer: ${sanitizeText(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });

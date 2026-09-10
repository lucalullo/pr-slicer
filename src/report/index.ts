import type { SlicePlan, PlanGroup } from '../core/model.js';
import { serializePlan } from '../core/plan-size.js';
import { sanitizeText as clean, markdownText as escape, markdownCode as code } from './sanitize.js';
const labels: Record<string, string> = { 'single-change': 'Modifica singola', 'split-recommended': 'Suddivisione consigliata (statica)', 'split-unverified': 'Suddivisione da verificare', 'split-verified': 'Suddivisione verificata', 'cannot-safely-split': 'Nessuna suddivisione sicura trovata' };
function verificationSummary(p: SlicePlan): string[] {
  if (p.verification.status === 'not-run') return [];
  const { passed, total } = p.metrics.verificationCoverage;
  const rows = [`Prefissi con tutti i controlli richiesti superati: ${passed}/${total}`, p.config.checks.length ? `Controlli di progetto: ${p.config.checks.length} configurati (comandi ${p.verification.commandsExecuted ? 'eseguiti' : 'non eseguiti'})` : 'Controlli di progetto: non configurati'];
  const results = Object.values(p.checks).flat();
  if (results.length) rows.push('Esiti dei controlli (tutti i prefissi): ' + ['passed', 'failed', 'skipped', 'timeout', 'unavailable'].map(status => `${status} ${results.filter(result => result.status === status).length}`).join(' · '));
  const optionalSemanticSkipped = Object.values(p.checks).some(checks => {
    const semantic = checks[checks[1]?.name === 'dependencies' ? 3 : 2];
    return semantic?.name === 'semantic' && semantic.status === 'skipped';
  });
  if (optionalSemanticSkipped) rows.push('La semantica non richiesta non rientra nei controlli richiesti; i controlli di progetto saltati non sono superati.');
  return rows;
}
export function terminalReport(p: SlicePlan): string {
  const rows = [`PR Slicer · ${clean(labels[p.status] ?? p.status)}`, `${p.files.length} file · ${p.units.length} unità · ${p.groups.length} gruppi`, `Ricostruzione finale: esatta (${clean(p.integrity.finalTreeOid.slice(0, 12))})`, `Verifica: ${clean(p.verification.status)} · livello ${clean(p.verification.level)}`, ...verificationSummary(p).map(clean), ''];
  p.groups.forEach((g, i) => rows.push(`${i + 1}. ${clean(g.title)} [${clean(g.id)}]`, `   ${g.files.length} file · +${clean(g.addedLines)}/-${clean(g.deletedLines)} · dipendenze: ${g.dependsOn.map(clean).join(', ') || 'nessuna'}`, ...g.reasons.slice(0, 3).map(r => `   ${clean(r.message)}`), ''));
  rows.push(`Coesione: ${clean(p.metrics.structuralCohesion)}/100 · integrità dipendenze: ${clean(p.metrics.dependencyIntegrity)}/100 · confidenza confini: ${clean(p.metrics.boundaryConfidence)}`);
  if (p.warnings.length) rows.push('', 'Limiti e incertezze:', ...p.warnings.map(w => `- ${clean(w.message)}`));
  if (p.verification.status === 'not-run') rows.push('', 'Build e test non eseguiti. Usa verify; --run-checks abilita i comandi configurati.');
  return rows.join('\n') + '\n';
}
export function markdownReport(p: SlicePlan): string {
  const lines = ['# Piano PR Slicer', '', `**${escape(labels[p.status] ?? p.status)}**`, '', `Base: ${code(p.repository.mergeBaseOid)}  `, `Head: ${code(p.repository.headOid)}`, '', '## Fatti osservati', '', `- ${p.files.length} file, ${p.units.length} unità, ${p.edges.length} relazioni.`, `- Ricostruzione finale identica al tree head: ${code(p.integrity.finalTreeOid)}.`, `- Analisi: ${escape(p.analysisMode)}.`, '', '## Gruppi e inferenze strutturali', ''];
  for (const [i, g] of p.groups.entries()) {
    lines.push(`### ${i + 1}. ${escape(g.title)}`, '', `ID: ${code(g.id)} · ${g.files.length} file · +${escape(g.addedLines)}/−${escape(g.deletedLines)}`, '', `Dipendenze: ${g.dependsOn.map(code).join(', ') || 'nessuna'}`, '', ...g.files.map(f => '- ' + escape(f)), '', ...g.reasons.map(r => '- ' + escape(r.message)), '');
  }
  const summary = verificationSummary(p);
  lines.push('## Verifiche eseguite', '', `Stato: **${escape(p.verification.status)}** · livello: **${escape(p.verification.level)}**`, '', ...summary.map(row => '- ' + escape(row)), ...(summary.length ? [''] : []), '| Gruppo | Controllo | Esito | Dettaglio |', '|---|---|---|---|');
  for (const [group, checks] of Object.entries(p.checks)) for (const c of checks) lines.push(`| ${escape(group)} | ${escape(c.name)} | ${escape(c.status)} | ${escape(c.message ?? '')} |`);
  if (!Object.keys(p.checks).length) lines.push('| — | Ricostruzione finale | passed | Build, test e diagnostica dei prefissi non eseguiti |');
  lines.push('', '## Metriche', '', '| Metrica | Valore |', '|---|---|', `| Revisionabilità | ${escape(p.metrics.reviewability)}/100 |`, `| Coesione strutturale | ${escape(p.metrics.structuralCohesion)}/100 |`, `| Integrità dipendenze | ${escape(p.metrics.dependencyIntegrity)}/100 |`, `| Confidenza dei confini | ${escape(p.metrics.boundaryConfidence)} |`, '', 'Le metriche sono euristiche strutturali, non probabilità di correttezza.', '', '## Alternative statiche', '', ...p.candidates.map(c => `- ${code(c.id)}: ${c.groups.length} gruppi, costo ${escape(c.cost)}.`), '', '## Limiti e incertezze', '', ...p.warnings.map(w => '- ' + escape(w.message)), '', 'Il superamento dei controlli non dimostra la correttezza assoluta del comportamento.', '');
  return lines.join('\n');
}
export function formatPlan(p: SlicePlan, format: string): string {
  if (format === 'json') return serializePlan(p);
  if (format === 'markdown') return markdownReport(p);
  if (format === 'terminal') return terminalReport(p);
  throw new Error(`Formato non supportato: ${clean(format)}`);
}
export function explainGroup(p: SlicePlan, g: PlanGroup): string {
  const ids = new Set(g.unitIds); return serializePlan({ group: g, units: p.units.filter(u => ids.has(u.id)), edges: p.edges.filter(e => ids.has(e.from) || ids.has(e.to)), alternatives: p.candidates.map(c => ({ id: c.id, groups: c.groups.length, cost: c.cost })) });
}

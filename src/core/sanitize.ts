import type { CheckResult, Evidence, PlanGroup, SlicePlan } from './model.js';

function escapeControl(character: string): string {
  const quoted = JSON.stringify(character).slice(1, -1);
  return quoted === character ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}` : quoted;
}

/** Presentation-only escaping. Never apply this to Git paths or source data. */
export function sanitizeText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, escapeControl);
}

/** Descriptive metadata may retain ordinary multiline diagnostic formatting. */
function sanitizeDescription(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, escapeControl);
}

/** Finalize generated descriptions only, before hashing or writing a plan.
 * Explicit traversal protects raw paths, symbols, hunks, configuration and logs.
 */
export function sanitizePlanDescriptions(plan: SlicePlan): void {
  const seen = new Set<object>();
  const evidence = (items: Evidence[]): void => {
    for (const item of items) if (!seen.has(item)) { seen.add(item); item.message = sanitizeDescription(item.message); }
  };
  const groups = (items: PlanGroup[]): void => {
    for (const group of items) if (!seen.has(group)) { seen.add(group); group.title = sanitizeText(group.title); evidence(group.reasons); }
  };
  const checks = (items: Record<string, CheckResult[]>): void => {
    for (const results of Object.values(items)) for (const result of results) if (!seen.has(result)) {
      seen.add(result); if (result.message !== undefined) result.message = sanitizeDescription(result.message);
    }
  };
  for (const edge of plan.edges) evidence(edge.evidence);
  groups(plan.groups);
  for (const candidate of plan.candidates) { evidence(candidate.reasons); groups(candidate.groups); }
  evidence(plan.warnings);
  checks(plan.checks); checks(plan.verification.checks);
}

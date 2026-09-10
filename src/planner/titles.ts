import { posix } from 'node:path';
import { compare } from '../core/hashing.js';
import type { ChangeUnit } from '../core/model.js';
import { sanitizeText } from '../core/sanitize.js';

export function titleFor(units: ChangeUnit[]): string {
  const areas = [...new Set(units.map(unit => unit.area).filter(Boolean))].sort(), packages = [...new Set(units.map(unit => unit.packageId).filter(Boolean))].sort();
  const files = [...new Set(units.map(unit => unit.newPath ?? unit.oldPath ?? unit.id))].sort(compare);
  const action = units.every(unit => unit.changeKind === 'add') ? 'Aggiungi' : units.every(unit => unit.changeKind === 'delete') ? 'Rimuovi' : units.every(unit => unit.isTest) ? 'Aggiorna i test di' : 'Aggiorna';
  const subject = areas.length === 1 ? areas[0]! : packages.length === 1 ? packages[0]! : posix.basename(files[0] ?? 'modifiche');
  return sanitizeText(`${action} ${subject}${files.length > 1 ? ` (${files.length} file)` : ''}`.replace(/[\r\n\t]/g, ' ')).slice(0, 160);
}

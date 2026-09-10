import { sanitizeText } from '../core/sanitize.js';
export { sanitizeText } from '../core/sanitize.js';

/** Inline text, also safe immediately after a generated Markdown list marker. */
export function markdownText(value: unknown): string {
  return sanitizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_[\]<>|~!]/g, '\\$&')
    .replace(/^#+/, marker => marker.replace(/#/g, '\\#'))
    .replace(/ +#+$/, marker => marker.replace(/#/g, '\\#'))
    .replace(/^ +/g, spaces => '&#32;'.repeat(spaces.length))
    .replace(/^([+-]|\d+[.)])(?= )/, marker => marker.replace(/[+\-.)]/g, '\\$&'));
}

/** Backslash escaping does not protect delimiters inside Markdown code spans. */
export function markdownCode(value: unknown): string {
  const content = sanitizeText(value);
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(1 + runs.reduce((longest, run) => Math.max(longest, run.length), 0));
  const padding = /^`|`$/.test(content) || (/^ .* $/.test(content) && /[^ ]/.test(content)) ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}

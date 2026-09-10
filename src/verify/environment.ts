import type { Config } from '../core/model.js';

const BASE_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);

/** Project commands receive no credentials unless the user explicitly opts in. */
export function createCheckEnvironment(config: Config['environment'], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(config.allow.map(key => process.platform === 'win32' ? key.toUpperCase() : key));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (value !== undefined && (config.inherit || BASE_ENV.has(name.toUpperCase()) || allowed.has(name))) result[key] = value;
  }
  return { ...result, CI: result.CI ?? 'true', NO_COLOR: '1', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
}

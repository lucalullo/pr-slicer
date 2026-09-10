import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { Check, CheckResult } from '../core/model.js';

export const MAX_LOG_BYTES = 64 * 1024;

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The process group may already have exited. */ }
  }
}

/** No shell expansion, bounded combined logs, and a timeout covering descendants. */
export function runCheck(check: Check, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  return new Promise(resolve => {
    const started = performance.now();
    let bytes = 0, truncated = false, timedOut = false, finished = false;
    const chunks: Buffer[] = [];
    const child = spawn(check.command, check.args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
      const room = MAX_LOG_BYTES - bytes;
      if (chunk.length > room) truncated = true;
      if (room > 0) { const part = chunk.subarray(0, room); chunks.push(part); bytes += part.length; }
    };
    const finish = (status: CheckResult['status'], exitCode?: number, message?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killProcessTree(child.pid);
      const log = Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[log truncated at 65536 bytes]' : '');
      resolve({ name: check.name, status, ...(exitCode === undefined ? {} : { exitCode }), durationMs: Math.round(performance.now() - started), ...(log ? { log } : {}), ...(message ? { message } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      child.kill('SIGKILL');
      // Do not depend on descendants closing inherited pipes on unsupported systems.
      child.stdout.destroy(); child.stderr.destroy();
      finish('timeout', undefined, `Command exceeded ${check.timeoutMs} ms; process tree terminated.`);
    }, check.timeoutMs);
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', error => finish('unavailable', undefined, `Cannot start ${check.command}: ${error.message}`));
    child.once('close', (code, signal) => finish(timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed', code ?? undefined, signal && !timedOut ? `Terminated by signal ${signal}.` : undefined));
  });
}

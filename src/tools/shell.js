/**
 * Shell tools: Bash (POSIX shell / Git Bash on Windows) and PowerShell.
 *
 * Output is captured, capped and returned with the exit code. A non-zero exit
 * code is reported as a normal tool result (not a thrown error) so the model can
 * read the failure and adapt, exactly like Claude Code does.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_OUTPUT_CAP = 30_000;

let cachedBash;

/** Locate a usable bash, preferring a real install over PATH on Windows. */
export function findBash() {
  if (cachedBash !== undefined) return cachedBash;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
        ]
      : [process.env.SHELL || '/bin/bash', '/bin/sh'];

  cachedBash = null;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedBash = candidate;
      break;
    } catch {
      /* keep looking */
    }
  }
  return cachedBash;
}

function shellInvocation(kind, command) {
  if (kind === 'powershell') {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    return { file: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  const bash = findBash();
  if (!bash) return null;
  return { file: bash, args: ['-lc', command] };
}

function clip(text, cap) {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.7));
  const tail = text.slice(-Math.floor(cap * 0.2));
  return `${head}\n... [${text.length - head.length - tail.length} characters omitted] ...\n${tail}`;
}

/** Spawn a command and capture its output. */
export function runProcess({
  file,
  args,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  cap = DEFAULT_OUTPUT_CAP,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: `Failed to start ${file}: ${error.message}`, spawnError: true });
      return;
    }

    const streams = { stdout: '', stderr: '' };
    let overflow = 0;
    let timedOut = false;
    let settled = false;

    const onData = (key) => (chunk) => {
      const text = chunk.toString('utf8');
      const room = cap * 4 - streams[key].length;
      if (room > 0) streams[key] += text.slice(0, room);
      overflow += Math.max(0, text.length - Math.max(room, 0));
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      } else {
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      }
    }, timeoutMs);

    const onAbort = () => child.kill('SIGTERM');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const finish = (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, signal: closeSignal, ...streams, timedOut, overflow });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `${file}: ${error.message}`, spawnError: true });
    });

    child.on('close', (code, closeSignal) => finish(code ?? 0, closeSignal));
  });
}

function formatResult(result, cap) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
  const text = clip(combined, cap);
  const notes = [];
  if (result.timedOut) notes.push('Command timed out and was terminated.');
  if (result.overflow > 0) notes.push(`${result.overflow} characters of output were dropped.`);
  if (result.signal && !result.timedOut) notes.push(`Killed by signal ${result.signal}.`);

  const body = text || '(no output)';
  const header = result.code === 0 ? 'exit 0' : `exit ${result.code}`;
  return {
    output: `${body}\n[${header}]${notes.length ? ` ${notes.join(' ')}` : ''}`,
    isError: result.code !== 0,
  };
}

const shellSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to run.' },
    description: { type: 'string', description: 'Short description of what the command does (5-10 words).' },
    timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).' },
    run_in_background: {
      type: 'boolean',
      description: 'Run detached and return immediately with a log file path instead of waiting.',
    },
  },
  required: ['command'],
};

function makeShellTool(name, kind) {
  return {
    name,
    description:
      kind === 'powershell'
        ? 'Run a PowerShell command in the working directory and return stdout, stderr and the exit code.'
        : 'Run a shell command in the working directory (bash, or PowerShell as a fallback on Windows) ' +
          'and return stdout, stderr and the exit code. Use it for git, package managers, builds and ' +
          'tests. Do not use it for file reads or edits that Read/Edit/Write can do.',
    readOnly: false,
    inputSchema: shellSchema,
    async run(input, ctx) {
      const invocation = shellInvocation(kind, String(input.command ?? ''));
      if (!invocation) {
        return { isError: true, output: 'No bash found on this machine. Use the PowerShell tool instead.' };
      }
      const cap = ctx.config.maxToolOutput ?? DEFAULT_OUTPUT_CAP;
      const timeoutMs = Math.min(Math.max(Number(input.timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

      if (input.run_in_background) {
        const logFile = path.join(os.tmpdir(), `deepseek-code-${Date.now()}.log`);
        const out = fs.openSync(logFile, 'a');
        const child = spawn(invocation.file, invocation.args, {
          cwd: ctx.cwd,
          env: { ...process.env, ...ctx.config.env },
          detached: true,
          windowsHide: true,
          stdio: ['ignore', out, out],
        });
        child.unref();
        return {
          output: `Started in background (pid ${child.pid}). Output is appended to ${logFile}`,
          meta: { pid: child.pid, logFile },
        };
      }

      const result = await runProcess({
        ...invocation,
        cwd: ctx.cwd,
        env: ctx.config.env,
        timeoutMs,
        signal: ctx.signal,
        cap,
      });
      if (result.spawnError) return { isError: true, output: result.stderr };
      return formatResult(result, cap);
    },
  };
}

export const bashTool = makeShellTool('Bash', 'bash');
export const powershellTool = makeShellTool('PowerShell', 'powershell');


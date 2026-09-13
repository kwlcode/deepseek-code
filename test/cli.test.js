/**
 * Black-box tests for the CLI itself.
 *
 * Every case spawns the real bin/deepseek-code.js as a child process, so it
 * exercises argument parsing, the streaming parser, tool execution, the
 * permission prompt and process teardown for real — only the model endpoint is
 * stubbed. Each child gets its own HOME, so transcripts and persisted rules
 * never touch the developer's ~/.deepseek-code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockApi } from './helpers/mock-api.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'deepseek-code.js');
const FAKE_TTY = path.join(REPO_ROOT, 'test', 'helpers', 'fake-tty.mjs');

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const strip = (text) => String(text ?? '').replace(ANSI, '');

/** A scratch project directory plus an isolated home directory. */
async function scratch() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-cli-'));
  const dir = path.join(root, 'project');
  const home = path.join(root, 'home');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  return { root, dir, home };
}

/** A stub conversation that writes note.txt and then reports success. */
function writeScript() {
  return [
    {
      toolCalls: [
        {
          id: 'call_1',
          name: 'Write',
          arguments: JSON.stringify({ file_path: 'note.txt', content: 'hello from the stub' }),
        },
      ],
    },
    { content: ['Wrote note.txt.'] },
  ];
}

/**
 * Spawn the CLI. `input` scripts stdin; `keepStdinOpen` leaves the pipe open,
 * which proves a one-shot run exits on its own rather than waiting for EOF.
 */
function runCli(api, options) {
  const {
    cwd,
    home,
    args = [],
    input = null,
    keepStdinOpen = false,
    tty = false,
    timeoutMs = 30_000,
  } = options;

  const child = spawn(process.execPath, [tty ? FAKE_TTY : CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: api.url,
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_SMALL_MODEL: 'deepseek-flash',
      DEEPSEEK_THINKING: 'enabled',
      DEEPSEEK_PERMISSION_MODE: 'default',
      DEEPSEEK_MAX_STEPS: '6',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  if (input !== null) child.stdin.end(input);
  else if (!keepStdinOpen) child.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        out: strip(stdout),
        err: strip(stderr),
        report: () => `\n--- stdout ---\n${strip(stdout)}\n--- stderr ---\n${strip(stderr)}`,
      });
    });
  });
}

test('a one-shot run prints its answer and exits while stdin is still open', async () => {
  const api = await startMockApi([
    { content: ['PONG'], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
  ]);
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      args: ['--json', '-p', 'reply with PONG'],
      keepStdinOpen: true,
    });

    assert.equal(run.timedOut, false, `the CLI never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.type, 'result');
    assert.equal(payload.subtype, 'success');
    assert.equal(payload.is_error, false);
    assert.equal(payload.result, 'PONG');
    assert.equal(payload.usage.output, 3);
    assert.ok(payload.session_id, 'a session id is reported');
  } finally {
    await api.close();
  }
});

test('acceptEdits lets a one-shot run call a tool', async () => {
  const api = await startMockApi(writeScript());
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      args: ['--json', '--permission-mode', 'acceptEdits', '-p', 'create note.txt'],
    });

    assert.equal(run.timedOut, false, `the CLI never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());
    assert.equal(JSON.parse(run.stdout).result, 'Wrote note.txt.');
    assert.equal(await fsp.readFile(path.join(dir, 'note.txt'), 'utf8'), 'hello from the stub');

    const requests = api.chatRequests();
    assert.equal(requests.length, 2, 'the tool result was fed back to the model');
    const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'a tool message was sent');
    assert.match(toolMessage.content, /Wrote 1 line .* to .*note\.txt/);
  } finally {
    await api.close();
  }
});

test('a non-interactive run denies a tool instead of waiting for approval', async () => {
  const api = await startMockApi(writeScript());
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      args: ['--json', '-p', 'create note.txt'],
    });

    assert.equal(run.timedOut, false, `the CLI never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());
    await assert.rejects(fsp.stat(path.join(dir, 'note.txt')), 'nothing was written without approval');

    const toolMessage = api.chatRequests()[1].messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'the denial was reported back to the model');
    assert.match(toolMessage.content, /permission denied/i);
  } finally {
    await api.close();
  }
});

test('a non-interactive run without a prompt fails fast', async () => {
  const api = await startMockApi([{ content: ['unused'] }]);
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, { cwd: dir, home, args: [] });

    assert.equal(run.timedOut, false, `the CLI never exited.${run.report()}`);
    assert.equal(run.code, 2);
    assert.match(run.err, /no prompt given/);
    assert.equal(api.chatRequests().length, 0, 'the API was never called');
  } finally {
    await api.close();
  }
});

test('the REPL answers a prompt and exits on /exit', async () => {
  const api = await startMockApi([{ content: ['PONG'] }]);
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      tty: true,
      args: ['--no-color'],
      input: 'reply with PONG\n/exit\n',
    });

    assert.equal(run.timedOut, false, `the REPL never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());
    assert.match(run.out, /PONG/);
    assert.match(run.out, /Session saved:/);
    assert.equal(api.chatRequests().length, 1);
  } finally {
    await api.close();
  }
});

test('the REPL asks before writing and a one-off approval is not remembered', async () => {
  const api = await startMockApi(writeScript());
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      tty: true,
      args: ['--no-color'],
      input: 'create note.txt\ny\n/exit\n',
    });

    assert.equal(run.timedOut, false, `the REPL never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());
    assert.match(run.out, /Write needs your approval/);
    assert.match(run.out, /\[y\] allow once/);
    assert.equal(await fsp.readFile(path.join(dir, 'note.txt'), 'utf8'), 'hello from the stub');

    const settings = path.join(dir, '.deepseek-code', 'settings.local.json');
    await assert.rejects(fsp.stat(settings), 'allow-once must not persist a rule');
  } finally {
    await api.close();
  }
});

test('the REPL "always allow" writes the rule into the project settings', async () => {
  const api = await startMockApi(writeScript());
  try {
    const { dir, home } = await scratch();
    const run = await runCli(api, {
      cwd: dir,
      home,
      tty: true,
      args: ['--no-color'],
      input: 'create note.txt\na\n/exit\n',
    });

    assert.equal(run.timedOut, false, `the REPL never exited.${run.report()}`);
    assert.equal(run.code, 0, run.report());
    assert.equal(await fsp.readFile(path.join(dir, 'note.txt'), 'utf8'), 'hello from the stub');

    const settings = JSON.parse(
      await fsp.readFile(path.join(dir, '.deepseek-code', 'settings.local.json'), 'utf8'),
    );
    assert.deepEqual(settings.permissions.allow, ['Write']);
  } finally {
    await api.close();
  }
});

test('--resume and -c replay the transcript from an earlier process', async () => {
  const api = await startMockApi([{ content: ['PONG'] }, { content: ['42'] }, { content: ['43'] }]);
  try {
    const { dir, home } = await scratch();
    const first = await runCli(api, { cwd: dir, home, args: ['--json', '-p', 'remember 42'] });
    assert.equal(first.code, 0, first.report());
    const { session_id: id } = JSON.parse(first.stdout);

    const second = await runCli(api, {
      cwd: dir,
      home,
      args: ['--json', '--resume', id, '-p', 'which number?'],
    });
    assert.equal(second.code, 0, second.report());
    const resumed = JSON.parse(second.stdout);
    assert.match(second.err, /Resumed session/, 'the resume notice is a diagnostic, not JSON output');
    assert.equal(resumed.subtype, 'success');
    assert.equal(resumed.session_id, id, 'the requested session was resumed');
    assert.equal(resumed.result, '42');

    const replayed = api.chatRequests().at(-1).messages;
    assert.ok(
      replayed.some((message) => message.role === 'user' && message.content === 'remember 42'),
      'the earlier user turn was replayed',
    );
    assert.ok(
      replayed.some((message) => message.role === 'assistant' && message.content === 'PONG'),
      'the earlier answer was replayed',
    );

    const third = await runCli(api, { cwd: dir, home, args: ['--json', '-c', '-p', 'and now?'] });
    assert.equal(third.code, 0, third.report());
    assert.equal(JSON.parse(third.stdout).session_id, id, '-c picked the latest session for this project');
  } finally {
    await api.close();
  }
});

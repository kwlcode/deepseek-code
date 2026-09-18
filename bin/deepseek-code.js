#!/usr/bin/env node
/**
 * deepseek-code — an agentic coding CLI for DeepSeek's OpenAI-compatible API,
 * with the same tool names, settings files and permission modes as Claude Code.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadConfig, permissionModes, normalizePermissionMode, CONFIG_DIR } from '../src/config.js';
import { loadCommands, renderCommand, describeCommands } from '../src/commands.js';
import { Agent } from '../src/agent.js';
import { createSession, loadSession, listSessions, projectDir } from '../src/session.js';
import { buildRegistry } from '../src/tools/index.js';
import { loadMemoryFiles, titleFor } from '../src/prompt.js';
import { listModels } from '../src/api.js';
import { findBash } from '../src/tools/shell.js';
import { createColors, createLineReader, createRenderer, shouldUseColor } from '../src/ui.js';
import { Screen, InputBox } from '../src/terminal.js';
import { registerSession, touchSession, unregisterSession, generateToken, claimName } from '../src/registry.js';
import { autoName, normalizeName } from '../src/names.js';
import { createMessageServer, socketAddressFor } from '../src/transport.js';
import { createInbox } from '../src/inbox.js';
import { formatCost } from '../src/cost.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const STRING_FLAGS = new Map([
  ['--model', 'model'], ['-m', 'model'],
  ['--api-key', 'apiKey'],
  ['--base-url', 'baseUrl'],
  ['--permission-mode', 'permissionMode'],
  ['--allowed-tools', 'allowedTools'],
  ['--allowedTools', 'allowedTools'],
  ['--disallowed-tools', 'disallowedTools'],
  ['--disallowedTools', 'disallowedTools'],
  ['--append-system-prompt', 'appendSystemPrompt'],
  ['--max-steps', 'maxSteps'],
  ['--max-tokens', 'maxTokens'],
  ['--effort', 'effort'],
  ['--output-format', 'outputFormat'],
  ['--cwd', 'cwd'],
  ['--name', 'name'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--verbose', 'verbose'],
  ['--no-color', 'noColor'],
  ['--no-thinking', 'noThinking'],
  ['--dangerously-skip-permissions', 'skipPermissions'],
  ['--yolo', 'skipPermissions'],
  ['--json', 'json'],
  ['--continue', 'continue'], ['-c', 'continue'],
  ['--help', 'help'], ['-h', 'help'],
  ['--version', 'version'], ['-v', 'version'],
]);

const OPTIONAL_VALUE_FLAGS = new Map([
  ['-p', 'print'],
  ['--print', 'print'],
  ['-r', 'resume'],
  ['--resume', 'resume'],
]);

const SUBCOMMANDS = ['doctor', 'models', 'sessions', 'help', 'version'];

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('-') && token !== '-') {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      const inlineValue = equals === -1 ? null : token.slice(equals + 1);

      if (STRING_FLAGS.has(name)) {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new Error(`${name} needs a value`);
        flags[STRING_FLAGS.get(name)] = value;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags[BOOLEAN_FLAGS.get(name)] = inlineValue === null ? true : inlineValue !== 'false';
        continue;
      }
      if (OPTIONAL_VALUE_FLAGS.has(name)) {
        const next = inlineValue ?? argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[OPTIONAL_VALUE_FLAGS.get(name)] = next;
          i += 1;
        } else {
          flags[OPTIONAL_VALUE_FLAGS.get(name)] = true;
        }
        continue;
      }
      throw new Error(`unknown option: ${name}`);
    }

    if (!command && positionals.length === 0 && SUBCOMMANDS.includes(token)) {
      command = token;
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals, command };
}

export function usageText() {
  return `deepseek-code ${VERSION} — agentic coding CLI on DeepSeek

Usage
  deepseek-code [options]                 start an interactive session
  deepseek-code [options] "prompt"        run one prompt and exit
  deepseek-code -p [prompt]               print mode (prompt from stdin when omitted)
  deepseek-code doctor                    check config, credentials and API reachability
  deepseek-code models                    list models available on the account
  deepseek-code sessions                  list saved sessions for this directory

Options
  -m, --model <name>              model to use (default: deepseek-flash)
      --name <name>               name this session answers to as @name
      --effort <low|medium|high>  reasoning effort when thinking is on
      --no-thinking               disable thinking mode
      --permission-mode <mode>    ${permissionModes().join(' | ')}
      --dangerously-skip-permissions
                                  alias for --permission-mode bypassPermissions
      --allowed-tools <list>      comma-separated allowlist of tools
      --disallowed-tools <list>   comma-separated denylist of tools
      --append-system-prompt <t>  extra instructions appended to the system prompt
      --max-steps <n>             max agent steps per turn (default: 60)
      --max-tokens <n>            max output tokens per response
      --api-key <key>             override DEEPSEEK_API_KEY
      --base-url <url>            override the API base URL
  -r, --resume [id]               resume a session (latest in this directory if omitted)
  -c, --continue                  resume the most recent session
      --output-format <fmt>       text | json (json prints the final result as JSON)
      --verbose                   show token usage and timings after each step
      --no-color                  disable ANSI colour
  -h, --help                      show this help
  -v, --version                   print the version

Permission modes
  plan               read-only; the agent researches and proposes a plan
  default            read-only tools run freely, everything else asks
  acceptEdits        file edits run freely, shell commands still ask
  bypassPermissions  nothing asks (use only in a sandbox)

Files
  settings   ${CONFIG_DIR}/config.json, then .claude/settings.json,
             .claude/settings.local.json, .deepseek-code/settings.json
  memory     CLAUDE.md, AGENTS.md, CLAUDE.local.md (user and project level)
  commands   .claude/commands/*.md (invoked as /name)`;
}

/** `deepseek-code doctor` — verify the environment end to end. */
export async function runDoctor(config) {
  const colors = createColors(shouldUseColor(process.stdout));
  const results = [];
  const record = (label, ok, detail) => {
    results.push({ label, ok });
    const mark = ok === 'warn' ? colors.yellow('!') : ok ? colors.green('\u2713') : colors.red('\u2717');
    process.stdout.write(`${mark} ${label}${detail ? colors.dim(` — ${detail}`) : ''}\n`);
  };

  const [major, minor] = process.versions.node.split('.').map(Number);
  record('Node.js >= 18.17', major > 18 || (major === 18 && minor >= 17), `found ${process.version}`);
  record('API key', Boolean(config.apiKey),
    config.apiKey ? `from ${config.apiKeySource}` : 'set DEEPSEEK_API_KEY or pass --api-key');
  record('Base URL', true, config.baseUrl);
  record('Working directory', true, config.cwd);
  record('Bash available', Boolean(findBash()), findBash() ?? 'not found; the Bash tool will be unavailable');

  const memory = loadMemoryFiles(config.cwd);
  record('Memory files', true, memory.length ? memory.map((entry) => path.basename(entry.file)).join(', ') : 'none found');
  const commands = await loadCommands(config.cwd);
  record('Custom commands', true, commands.size ? `${commands.size} in .claude/commands` : 'none');
  record('Settings files', true,
    config.sources.length ? config.sources.map((file) => path.relative(config.cwd, file) || file).join(', ') : 'defaults only');
  record('Session storage', true, projectDir(config.cwd));
  record('Tool set', true, [...buildRegistry(config).keys()].join(', '));
  record('Memory', true, memory.length ? `${memory.length} file(s) loaded` : 'no CLAUDE.md or AGENTS.md found');

  if (!config.apiKey) {
    record('API reachability', false, 'skipped: no API key');
    return false;
  }
  try {
    const models = await listModels(config);
    record('API reachability', true,
      `GET /models returned ${models.length} model(s)${models.length ? `: ${models.slice(0, 6).join(', ')}` : ''}`);
    const known = models.length === 0 || models.includes(config.model);
    record('Configured model', known ? true : 'warn',
      known ? `${config.model} is available` : `${config.model} was not in the model list`);
  } catch (error) {
    record('API reachability', false, error.message);
    return false;
  }
  return results.every((entry) => entry.ok !== false);
}

const INIT_PROMPT = [
  'Analyse this repository and write a CLAUDE.md file at the repository root.',
  '',
  'Cover: what the project is and what it is for; the tech stack and framework versions; the layout of the main directories;',
  'the build, test, lint and run commands (read package.json, Makefile, CI config and lockfiles rather than guessing);',
  'the code conventions a new contributor must follow; and any non-obvious setup step such as required environment variables.',
  '',
  'Read the relevant files first, then use the Write tool. Keep it under 120 lines and never invent commands you have not verified.',
].join('\n');

/** Split a comma-separated CLI list, e.g. --allowed-tools "Read,Grep". */
function splitList(value) {
  if (value === undefined || value === null || value === '') return null;
  const parts = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

/** Load the session named by --resume/--continue, if either was passed. */
async function resolveResumeSession(config, flags) {
  // `--resume` with no id means "the latest session in this directory".
  const wantsResume = Boolean(flags.continue) || Boolean(flags.resume);
  if (!wantsResume) return null;
  const id = typeof flags.resume === 'string' ? flags.resume : undefined;
  try {
    return await loadSession(config.cwd, id);
  } catch (error) {
    process.stderr.write(`error: could not load the session: ${error.message}\n`);
    return null;
  }
}

/** Build an agent sharing this session's registry, renderer and permission mode. */
function buildAgent({ config, registry, renderer, interactive, session, allowedTools, inbox }) {
  return new Agent({
    config,
    registry,
    renderer,
    interactive,
    session,
    allowedTools,
    inbox,
    permissionMode: config.permissionMode,
    memoryFiles: loadMemoryFiles(config.cwd),
    customPrompt: config.appendSystemPrompt ?? null,
  });
}

/** Renderer that swallows the stream and hands the text back for --output-format json. */
function createCaptureRenderer() {
  const chunks = [];
  const noop = () => {};
  return {
    renderer: {
      startAssistant: noop,
      reasoning: noop,
      text: (chunk) => chunks.push(chunk),
      endAssistant: noop,
      toolStart: noop,
      toolEnd: noop,
      todos: noop,
      notice: noop,
      warn: (message) => process.stderr.write(`warning: ${message}\n`),
      error: (message) => process.stderr.write(`error: ${message}\n`),
      askPermission: async () => 'deny',
    },
    text: () => chunks.join(''),
  };
}

/** One prompt, then exit. Used by `-p` and by piped stdin. */
async function runSingleShot({ agent, prompt, session, config, flags }) {
  const capture = flags.json || flags.outputFormat === 'json' ? createCaptureRenderer() : null;
  if (capture) agent.renderer = capture.renderer;

  const startedAt = Date.now();
  const outcome = await agent.runTurn(prompt);
  const elapsedMs = Date.now() - startedAt;
  const text = capture ? capture.text() : outcome.text;

  if (capture) {
    process.stdout.write(
      `${JSON.stringify(
        {
          type: 'result',
          subtype: outcome.error ? 'error' : outcome.aborted ? 'interrupted' : 'success',
          session_id: session.id,
          result: text,
          num_turns: agent.tracker.turns,
          duration_ms: elapsedMs,
          usage: agent.tracker.totals,
          total_cost_usd: Number(agent.tracker.usd.toFixed(6)),
          model: session.model ?? config.model,
          is_error: Boolean(outcome.error),
        },
        null,
        2,
      )}\n`,
    );
  } else if (flags.verbose) {
    process.stderr.write(`session ${session.id} \u00b7 ${formatCost(agent.tracker.usd)} \u00b7 ${(elapsedMs / 1000).toFixed(1)}s\n`);
  }

  if (outcome.aborted) return 130;
  if (outcome.error) {
    process.stderr.write(`error: ${outcome.error}\n`);
    return 1;
  }
  return 0;
}

/**
 * Handle one `/command` line.
 * @returns {Promise<{action: 'handled'|'exit'|'prompt', text?: string}|null>} null when the line is not a command.
 */
export async function handleSlashCommand(line, ctx) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = /^\/([A-Za-z0-9_:-]+)\s*([\s\S]*)$/.exec(trimmed);
  const name = match ? match[1] : trimmed.slice(1);
  const args = match ? match[2].trim() : '';
  const { renderer, config, agent } = ctx;
  const colors = renderer.colors ?? createColors(false);

  switch (name) {
    case 'help':
      renderer.write(`${describeCommands(ctx.commands)}\n`);
      return { action: 'handled' };

    case 'init':
      return { action: 'prompt', text: INIT_PROMPT };

    case 'memory': {
      const files = loadMemoryFiles(config.cwd);
      if (!files.length) {
        renderer.write('No memory files found (looked for CLAUDE.md, AGENTS.md and CLAUDE.local.md).\n');
      } else {
        for (const entry of files) {
          renderer.write(`${colors.bold(entry.file)} ${colors.dim(`(${entry.scope}, ${entry.text.length} chars)`)}\n`);
        }
      }
      return { action: 'handled' };
    }

    case 'status': {
      const session = agent.session;
      const rows = [
        ['session', session.id],
        ['transcript', session.file ?? '(not saved yet)'],
        ['cwd', config.cwd],
        ['model', session.model ?? config.model],
        ['permission mode', agent.permissions.mode],
        ['settings', config.sources.length ? config.sources.join(', ') : 'defaults only'],
        ['messages', String(session.messages.length)],
        ['tools', [...agent.registry.keys()].join(', ')],
      ];
      for (const [label, value] of rows) renderer.write(`${label.padEnd(16)} ${value}\n`);
      renderer.write(`${agent.tracker.summary()}\n`);
      return { action: 'handled' };
    }

    case 'cost':
      renderer.write(`${agent.tracker.summary()}\n`);
      return { action: 'handled' };

    case 'todos': {
      const todos = agent.session.todos ?? [];
      if (!todos.length) renderer.write('No tasks tracked.\n');
      else renderer.todos?.(todos);
      return { action: 'handled' };
    }

    case 'model': {
      if (!args) {
        renderer.write(`model: ${colors.bold(agent.session.model ?? config.model)}\n`);
        try {
          const models = await listModels(config);
          if (models.length) renderer.write(`available: ${models.join(', ')}\n`);
        } catch (error) {
          renderer.write(colors.dim(`could not list models: ${error.message}\n`));
        }
        return { action: 'handled' };
      }
      const previous = agent.session.model ?? config.model;
      agent.session.model = args;
      config.model = args;
      await agent.persist();
      renderer.write(`model: ${previous} \u2192 ${colors.bold(args)}\n`);
      return { action: 'handled' };
    }

    case 'mode': {
      if (!args) {
        renderer.write(`permission mode: ${colors.bold(agent.permissions.mode)}\n`);
        renderer.write(colors.dim(`  options: ${permissionModes().join(', ')}\n`));
        return { action: 'handled' };
      }
      const mode = normalizePermissionMode(args);
      if (!mode) {
        renderer.error(`unknown permission mode "${args}" (expected ${permissionModes().join(', ')})`);
        return { action: 'handled' };
      }
      agent.setPermissionMode(mode);
      await agent.persist();
      renderer.write(`permission mode: ${colors.bold(mode)}\n`);
      return { action: 'handled' };
    }

    case 'compact':
      await agent.compact();
      return { action: 'handled' };

    case 'clear':
      ctx.replaceSession(createSession({
        cwd: config.cwd,
        model: agent.session.model ?? config.model,
        permissionMode: agent.permissions.mode,
        name: agent.session.name,
      }));
      renderer.write('Started a fresh conversation.\n');
      return { action: 'handled' };

    case 'resume':
      return { action: 'resume' };

    case 'rename': {
      const next = normalizeName(args);
      if (!next) {
        renderer.error('usage: /rename <name>  (letters, digits, "-", "_", "."; max 32)');
        return { action: 'handled' };
      }
      const claimed = await claimName(next, { excludeIds: [agent.session.id] });
      const taken = claimed !== next;
      agent.session.name = claimed;
      await agent.persist();
      await ctx.refreshRegistration?.(agent.session);
      renderer.write('session name: @' + claimed + (taken ? '  ("' + next + '" was taken)' : '') + '\n');
      return { action: 'handled' };
    }

    case 'exit':
    case 'quit':
      return { action: 'exit' };

    default:
      break;
  }

  const custom = ctx.commands.get(name);
  if (custom) {
    if (custom.model) {
      agent.session.model = custom.model;
      renderer.write(colors.dim(`using model ${custom.model} for this command\n`));
    }
    return { action: 'prompt', text: renderCommand(custom, args), allowedTools: custom.allowedTools };
  }

  renderer.error(`unknown command "/${name}" (try /help)`);
  return { action: 'handled' };
}

/** `/resume` — list this directory's sessions and load the one the user picks. */
async function pickSession(ctx) {
  const { renderer, config } = ctx;
  const sessions = await listSessions(config.cwd, 15);
  if (!sessions.length) {
    renderer.write(`No saved sessions for ${config.cwd} yet.\n`);
    return;
  }
  renderer.write('\nSaved sessions:\n');
  sessions.forEach((entry, index) => {
    const when = String(entry.updatedAt).replace('T', ' ').slice(0, 16);
    renderer.write(`  ${String(index + 1).padStart(2)}. ${when}  ${entry.id}  ${entry.model ?? ''}  ${entry.title}\n`);
  });
  renderer.write('Pick a number or paste a session id (blank to cancel) \u203a ');
  const answer = await ctx.reader.next();
  renderer.write('\n');
  const value = String(answer.value ?? '').trim();
  if (answer.done || !value) return;

  const chosen = /^\d+$/.test(value) ? sessions[Number(value) - 1]?.id : value;
  const loaded = await loadSession(config.cwd, chosen);
  if (!loaded) {
    renderer.error(`no session matched "${value}"`);
    return;
  }
  ctx.replaceSession(loaded);
  renderer.write(`Resumed ${loaded.id} (${loaded.messages?.length ?? 0} messages) \u2014 ${loaded.title}\n`);
}

function printBanner(ctx) {
  const { renderer, config, agent } = ctx;
  const colors = renderer.colors ?? createColors(false);
  renderer.write(`${colors.bold('deepseek-code')} ${colors.dim(`v${VERSION}`)} ${colors.dim('\u00b7')} ${agent.session.model ?? config.model} ${colors.dim('\u00b7')} ${agent.permissions.mode}\n`);
  renderer.write(`${colors.dim(config.cwd)}\n`);
  if (config.apiKeySource && config.apiKeySource !== 'DEEPSEEK_API_KEY') {
    renderer.write(`${colors.dim(`api key from ${config.apiKeySource}`)}\n`);
  }
  renderer.write(`${colors.dim('/help for commands, /exit to quit, Ctrl+C to interrupt')}\n\n`);
}

/** Read all of a piped stdin, used for `deepseek-code -p < file`. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Release stdin once a run is over. The REPL attaches a flowing `data` listener
 * and `-p` can leave a pipe unread; either one keeps Node's event loop alive, so
 * without this the CLI prints its answer and then hangs instead of exiting.
 */
function releaseStdin() {
  try {
    process.stdin.pause();
  } catch {
    /* stdin may already be closed */
  }
  try {
    if (!process.stdin.destroyed) process.stdin.destroy?.();
  } catch {
    /* nothing left to do; the process is on its way out */
  }
}

/** The interactive REPL. */
async function runRepl(ctx, seedPrompt) {
  const { renderer, screen } = ctx;
  const colors = renderer.colors ?? createColors(false);
  const config = ctx.config;
  const pending = seedPrompt ? [seedPrompt] : [];
  let interruptArmed = false;
  let box = null;

  const interrupt = () => {
    if (ctx.busy) {
      renderer.write('\n');
      renderer.warn('interrupting the current turn...');
      ctx.agent.abort();
      return;
    }
    if (interruptArmed) {
      renderer.write('\n');
      process.exit(0);
    }
    interruptArmed = true;
    renderer.write('\n');
    renderer.notice('Press Ctrl+C again to exit, or use /exit.');
  };

  if (screen) {
    box = new InputBox({
      input: process.stdin,
      screen,
      onInterrupt: interrupt,
      onEof: () => {},
    });
    ctx.reader = box;
    renderer.reader = box;
    ctx.box = box;
  }

  const refreshStatus = () => {
    if (!screen) return;
    const model = ctx.agent.session.model ?? config.model;
    screen.setStatus(`${model} \u00b7 ${ctx.agent.permissions.mode} \u00b7 ${formatCost(ctx.agent.tracker.usd)}`);
  };

  printBanner(ctx);
  refreshStatus();

  const heartbeat = setInterval(() => touchSession(ctx.agent.session.id).catch(() => {}), 30_000);
  heartbeat.unref?.();

  ctx.inbox.onHold = async (entry) => {
    const decision = await renderer.askPermission({
      summary: 'incoming message from @' + (entry.from ?? 'unknown'),
      tool: 'SendMessage',
      detail: { from: entry.from, message: entry.text },
      preview: entry.text,
      mode: ctx.agent.permissions.mode,
    });
    return decision === 'allow' || decision === 'allow-always';
  };

  let messageServer = null;
  const startTransport = async (session) => {
    if (messageServer) await messageServer.stop().catch(() => {});
    const server = createMessageServer({
      address: socketAddressFor(session.id),
      token: session.token,
      handler: async (request) => {
        const outcome = ctx.inbox.submit({
          id: request.id,
          from: request.from,
          text: request.text,
          reply_to: request.reply_to,
        });
        if (outcome.disposition === 'refused') {
          return { ok: false, disposition: 'refused', id: outcome.id, error: outcome.reason };
        }
        return { ok: true, disposition: outcome.disposition, id: outcome.id };
      },
    });
    const actual = await server.start();
    messageServer = server;
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = actual;
    if (actual !== socketAddressFor(session.id)) registerSession(session, { socket: actual, token: session.token }).catch(() => {});
  };
  try {
    await startTransport(ctx.agent.session);
  } catch (error) {
    renderer.warn('could not start the message socket: ' + error.message);
  }
  ctx.onSessionSwap.push((session) => {
    startTransport(session).catch((error) => renderer.warn('could not restart the message socket: ' + error.message));
  });
  ctx.refreshRegistration = (session) => {
    const address = messageServer ? messageServer.boundAddress : socketAddressFor(session.id);
    return registerSession(session, { socket: address, token: session.token }).catch(() => {});
  };

  const onSigint = () => interrupt();
  process.on('SIGINT', onSigint);

  try {
    for (;;) {
      let line;
      if (pending.length) {
        line = pending.shift();
        renderer.write(`${colors.cyan('> ')}${line}\n`);
      } else {
        if (!box) renderer.write(`${colors.cyan('> ')}`);
        // Wait for the user or for an inbound message, whichever comes first.
        const raced = await Promise.race([
          ctx.reader.next().then((value) => ({ answer: value })),
          ctx.inbox.waitForWork().then(() => ({ work: true })),
        ]);
        if (raced.work) {
          const message = await ctx.agent.readQueuedMessage();
          if (message) {
            ctx.busy = true;
            if (screen) screen.startThinking();
            try {
              const outcome = await ctx.agent.runTurn(message.text, { origin: 'peer' });
              if (outcome.error) renderer.error(outcome.error);
            } catch (error) {
              renderer.error(error.message);
            } finally {
              ctx.busy = false;
              if (screen) screen.stopThinking();
              ctx.agent.renderer.endAssistant?.({});
              refreshStatus();
            }
          }
          continue;
        }
        const answer = raced.answer;
        if (answer.done) {
          if (!box) renderer.write('\n');
          break;
        }
        line = answer.value;
        if (box) renderer.write(`${colors.cyan('> ')}${line}\n`);
      }

      const trimmed = String(line ?? '').trim();
      if (!trimmed) continue;
      interruptArmed = false;
      if (trimmed === 'exit' || trimmed === 'quit') break;

      let promptText = trimmed;
      let commandOutcome = null;
      try {
        commandOutcome = await handleSlashCommand(trimmed, ctx);
      } catch (error) {
        renderer.error(error.message);
        continue;
      }
      if (commandOutcome) {
        if (commandOutcome.action === 'exit') break;
        if (commandOutcome.action === 'handled') continue;
        if (commandOutcome.action === 'resume') {
          try {
            await pickSession(ctx);
          } catch (error) {
            renderer.error(`could not resume: ${error.message}`);
          }
          continue;
        }
        promptText = commandOutcome.text;
      }

      ctx.busy = true;
      if (screen) screen.startThinking();
      try {
        const outcome = await ctx.agent.runTurn(promptText);
        if (outcome.error) renderer.error(outcome.error);
      } catch (error) {
        renderer.error(error.message);
      } finally {
        ctx.busy = false;
        if (screen) screen.stopThinking();
        ctx.agent.renderer.endAssistant?.({});
        refreshStatus();
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    renderer.spinner?.stop();
  }
  renderer.write(`${colors.dim(`\nSession saved: ${ctx.agent.session.file ?? '(unsaved)'}`)}\n`);
  if (screen) screen.dispose();
  if (box) box.dispose();
  clearInterval(heartbeat);
  if (messageServer) await messageServer.stop().catch(() => {});
  unregisterSession(ctx.agent.session.id).catch(() => {});
  return 0;
}

export async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${usageText()}\n`);
    return 2;
  }

  const { flags, positionals, command } = parsed;
  if (flags.help || command === 'help') {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  if (flags.version || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.skipPermissions) flags.permissionMode = 'bypassPermissions';

  let config;
  try {
    config = loadConfig({ flags, cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd() });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }
  if (flags.noThinking) config.thinking = false;
  if (flags.appendSystemPrompt) config.appendSystemPrompt = flags.appendSystemPrompt;

  const allowedTools = splitList(flags.allowedTools);
  const disallowedTools = splitList(flags.disallowedTools);
  if (disallowedTools) config.disabledTools = disallowedTools;

  if (flags.cwd) process.chdir(config.cwd);

  if (command === 'doctor') return (await runDoctor(config)) ? 0 : 1;

  if (command === 'models') {
    if (!config.apiKey) {
      process.stderr.write('error: no API key. Set DEEPSEEK_API_KEY or pass --api-key.\n');
      return 2;
    }
    try {
      const models = await listModels(config);
      process.stdout.write(models.length ? `${models.join('\n')}\n` : 'no models returned\n');
      return 0;
    } catch (error) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
  }

  if (command === 'sessions') {
    const sessions = await listSessions(config.cwd, 30);
    if (!sessions.length) {
      process.stdout.write(`No saved sessions for ${config.cwd}.\n`);
      return 0;
    }
    for (const entry of sessions) {
      process.stdout.write(`${entry.id}  ${String(entry.updatedAt).slice(0, 16)}  ${entry.model ?? ''}  ${entry.turns} turns  ${entry.title}\n`);
    }
    return 0;
  }

  if (!config.apiKey) {
    process.stderr.write(
      'error: no API key found.\n' +
      'Set DEEPSEEK_API_KEY, put it in ~/.deepseek-code/config.json, or pass --api-key.\n' +
      'Paste a key from https://platform.deepseek.com/api_keys.\n',
    );
    return 2;
  }

  const registry = buildRegistry(config, { only: allowedTools ?? undefined, disabled: disallowedTools ?? [] });

  // A positional prompt is a seed for the REPL when attached to a terminal, and
  // a one-shot run when piped. `-p` always means one-shot.
  let promptText = typeof flags.print === 'string' ? flags.print : positionals.join(' ').trim();
  const piped = !process.stdin.isTTY;
  if (!promptText && piped && !process.stdout.isTTY) promptText = await readStdin();

  const interactive = !flags.print && !piped && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !promptText) {
    process.stderr.write(`error: no prompt given.\n\n${usageText()}\n`);
    return 2;
  }

  // Only the REPL needs a line reader. In one-shot mode attaching a flowing
  // listener to stdin would keep the process alive after the answer is printed.
  const colors = createColors(shouldUseColor(process.stdout) && !flags.noColor);
  const useRaw = interactive && typeof process.stdin.setRawMode === 'function';
  const screen = useRaw ? new Screen(process.stdout, { colors }) : null;
  const reader = interactive && !screen ? createLineReader(process.stdin) : null;
  const renderer = createRenderer({
    reader,
    screen,
    verbose: Boolean(flags.verbose),
    quiet: !interactive,
    colors,
  });

  const resumed = await resolveResumeSession(config, flags);
  const session = resumed ?? createSession({
    cwd: config.cwd,
    model: config.model,
    permissionMode: config.permissionMode,
    title: titleFor(promptText || 'untitled session'),
    name: flags.name,
  });
  if (resumed) {
    renderer.notice(`Resumed session ${resumed.id} (${resumed.messages?.length ?? 0} messages, ${resumed.model ?? config.model}).`);
  }

  // One inbox per process: it outlives individual sessions, and the inbound gate
  // reads the live permission mode each time a message arrives.
  const inbox = createInbox({
    permissionMode: () => ctx.agent?.permissions.mode ?? config.permissionMode,
  });

  const ctx = {
    config,
    registry,
    renderer,
    reader,
    commands: await loadCommands(config.cwd),
    screen,
    allowedTools,
    inbox,
    onSessionSwap: [],
    busy: false,
    agent: null,
    replaceSession(newSession) {
      const previousId = ctx.agent?.session?.id;
      ctx.agent = buildAgent({
        config,
        registry,
        renderer,
        interactive,
        session: newSession,
        allowedTools,
        inbox,
      });
      ctx.agent.setPermissionMode(normalizePermissionMode(newSession.permissionMode) ?? config.permissionMode);
      if (interactive) {
        newSession.token = newSession.token ?? generateToken();
        process.env.CLAUDE_CODE_MESSAGING_TOKEN = newSession.token;
        (async () => {
          if (previousId && previousId !== newSession.id) await unregisterSession(previousId);
          newSession.name = await claimName(normalizeName(newSession.name) ?? autoName(), {
            excludeIds: [newSession.id, previousId],
          });
          await registerSession(newSession, { socket: socketAddressFor(newSession.id), token: newSession.token });
        })().catch(() => {});
      }
      for (const callback of ctx.onSessionSwap) callback(newSession);
    },
  };
  ctx.replaceSession(session);

  if (interactive) return runRepl(ctx, promptText || null);

  const code = await runSingleShot({
    agent: ctx.agent,
    prompt: promptText,
    session: ctx.agent.session,
    config,
    flags,
  });
  return code;
}

/**
 * Start the CLI only when this file is the program entry point. Importing the
 * module (as the test suite does) must not run anything.
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const from = fs.realpathSync(path.resolve(entry));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    if (from === self) return true;
    return process.platform === 'win32' && from.toLowerCase() === self.toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`fatal: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    })
    .finally(releaseStdin);
}




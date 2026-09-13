/**
 * Terminal rendering.
 *
 * Everything the agent says to the user goes through a renderer, so the same
 * agent can drive an interactive REPL, a single-shot `-p` run, or a subagent
 * whose output is collapsed to one line. Colours are dropped when the stream
 * is not a TTY, when NO_COLOR is set, or when the user passes --no-color.
 */

import readline from 'node:readline';

const CODES = {
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, white: 97,
};

export function createColors(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
  const api = {};
  for (const [name, code] of Object.entries(CODES)) api[name] = wrap(code);
  api.enabled = enabled;
  return api;
}

export function shouldUseColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream?.isTTY);
}

/** Visible width, ignoring ANSI escape sequences. */
export function visibleWidth(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function truncate(text, width) {
  const value = String(text);
  if (visibleWidth(value) <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}\u2026`;
}

/**
 * Line-oriented stdin reader.
 *
 * Both the REPL and the permission prompt pull from the same instance, so lines
 * typed while the agent is working are queued instead of being swallowed.
 */
export function createLineReader(input = process.stdin) {
  const queue = [];
  const waiting = [];
  let buffer = '';
  let closed = false;

  const deliver = (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter({ value: line, done: false });
    else queue.push(line);
  };

  if (!input.isTTY) input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      deliver(buffer.slice(0, index).replace(/\r$/, ''));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  input.on('end', () => {
    if (buffer.length) deliver(buffer);
    buffer = '';
    closed = true;
    while (waiting.length) waiting.shift()({ value: undefined, done: true });
  });
  input.on('error', () => {
    closed = true;
    while (waiting.length) waiting.shift()({ value: undefined, done: true });
  });

  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    close() {
      closed = true;
    },
  };
}

/** Braille spinner; writes to the same stream as the conversation. */
export class Spinner {
  constructor(out, colors) {
    this.out = out;
    this.colors = colors;
    this.frames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
    this.index = 0;
    this.timer = null;
    this.label = '';
    this.active = false;
  }

  start(label = '') {
    if (this.active || !this.out.isTTY) return;
    this.label = label;
    this.active = true;
    this.render();
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.render();
    }, 90);
  }

  render() {
    if (!this.active) return;
    const frame = this.colors.cyan(this.frames[this.index]);
    readline.clearLine(this.out, 0);
    readline.cursorTo(this.out, 0);
    this.out.write(`${frame} ${this.colors.dim(truncate(this.label, 60))}`);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    readline.clearLine(this.out, 0);
    readline.cursorTo(this.out, 0);
  }
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}


export function formatTokensShort(count) {
  if (!count) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

const MAX_TOOL_LINES = 12;
const MAX_TOOL_LINE_CHARS = 200;

export class TerminalRenderer {
  constructor(options = {}) {
    this.out = options.out ?? process.stdout;
    this.err = options.err ?? process.stderr;
    this.colors = options.colors ?? createColors(shouldUseColor(this.out));
    this.reader = options.reader ?? null;
    this.quiet = Boolean(options.quiet);
    this.verbose = Boolean(options.verbose);
    this.spinner = new Spinner(this.out, this.colors);
    this.state = { reasoning: false, text: false, streaming: false };
  }

  write(text) {
    this.out.write(text);
  }

  /** One line for a tool invocation, e.g. `● Edit(src/api.js)`. */
  toolStart({ name, summary }) {
    this.spinner.stop();
    this.endStreamingBlocks();
    if (this.quiet) return;
    const badge = this.colors.magenta('\u25cf');
    this.write(`\n${badge} ${this.colors.bold(truncate(summary, 160))}\n`);
  }

  /** Indented output preview, capped so a huge command cannot flood the log. */
  toolEnd({ name, output, isError, durationMs, denied }) {
    if (this.quiet) return;
    const glyph = this.colors.gray('\u23bf');
    const lines = String(output ?? '').split('\n');
    const shown = lines.slice(0, MAX_TOOL_LINES);
    const body = shown
      .map((line) => `  ${glyph} ${truncate(line, MAX_TOOL_LINE_CHARS)}`)
      .join('\n');
    const color = isError ? this.colors.red : this.colors.dim;
    this.write(`${color(body)}\n`);
    if (lines.length > shown.length) {
      this.write(`${this.colors.dim(`  ${glyph} \u2026 ${lines.length - shown.length} more line(s)`)}\n`);
    }
    if (durationMs > 1500 && this.verbose) {
      this.write(`${this.colors.dim(`  ${glyph} took ${formatDuration(durationMs)}`)}\n`);
    }
    if (denied) this.write(`${this.colors.yellow(`  ${glyph} denied`)}\n`);
  }

  startAssistant() {
    this.state = { reasoning: false, text: false, streaming: true };
    this.spinner.start('thinking');
  }

  reasoning(chunk) {
    this.spinner.stop();
    if (!this.state.reasoning) {
      this.state.reasoning = true;
      this.write(`\n${this.colors.dim('\u258e thinking')}\n`);
    }
    this.write(this.colors.dim(chunk));
  }

  text(chunk) {
    this.spinner.stop();
    if (this.state.reasoning && !this.state.text) {
      this.state.reasoning = false;
      this.write('\n');
    }
    if (!this.state.text) this.write('\n');
    this.state.text = true;
    this.write(chunk);
  }

  endStreamingBlocks() {
    if (this.state.text || this.state.reasoning) this.write('\n');
    this.state.text = false;
    this.state.reasoning = false;
  }

  endAssistant({ usage, tracker, truncated, finishReason } = {}) {
    this.spinner.stop();
    this.endStreamingBlocks();
    if (this.quiet || !this.verbose || !tracker) return;
    const parts = [];
    if (usage) {
      const cached = usage.prompt_tokens ? Math.round(((usage.prompt_cache_hit_tokens ?? 0) / usage.prompt_tokens) * 100) : 0;
      parts.push(`${formatTokensShort(usage.prompt_tokens)} in${usage.prompt_tokens ? ` (${cached}% cached)` : ''}`);
      parts.push(`${formatTokensShort(usage.completion_tokens)} out`);
    }
    if (tracker.usd > 0) parts.push(`$${tracker.usd.toFixed(4)}`);
    if (truncated) parts.push('output truncated');
    if (parts.length) this.write(`${this.colors.dim(`  ${parts.join(' \u00b7 ')}`)}\n`);
    if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
      this.write(`${this.colors.dim(`  finish: ${finishReason}`)}\n`);
    }
  }

  todos(list) {
    if (this.quiet || !list?.length) return;
    const glyph = { pending: '\u25a1', in_progress: '\u25a0', completed: '\u2714' };
    const body = list
      .map((todo) => {
        const mark = todo.status === 'completed' ? this.colors.green(glyph.completed)
          : todo.status === 'in_progress' ? this.colors.cyan(glyph.in_progress)
            : this.colors.dim(glyph.pending);
        const text = todo.status === 'completed' ? this.colors.dim(todo.content) : todo.content;
        return `  ${mark} ${text}`;
      })
      .join('\n');
    this.write(`\n${this.colors.bold('Tasks')}\n${body}\n`);
  }

  /**
   * Informational line. A quiet renderer (one-shot `-p` / `--json` runs) keeps
   * stdout machine-readable by sending diagnostics to stderr instead.
   */
  notice(message) {
    if (this.quiet) {
      this.err.write(`${message}\n`);
      return;
    }
    this.write(`${this.colors.dim(message)}\n`);
  }

  warn(message) {
    if (this.quiet) {
      this.err.write(`warning: ${message}\n`);
      return;
    }
    this.write(`${this.colors.yellow(`warning: ${message}`)}\n`);
  }

  error(message) {
    if (this.quiet) {
      this.err.write(`error: ${message}\n`);
      return;
    }
    this.write(`${this.colors.red(`error: ${message}`)}\n`);
  }

  /** Ask the user to approve a tool call. Returns a permission answer string. */
  async askPermission({ summary, preview, tool }) {
    if (!this.reader) return 'deny';
    this.spinner.stop();
    this.endStreamingBlocks();

    const header = this.colors.yellow(`${tool} needs your approval`);
    this.write(`\n\u250c\u2500 ${header}\n`);
    this.write(`\u2502 ${this.colors.bold(truncate(summary, 150))}\n`);
    if (preview) {
      const lines = String(preview).split('\n').slice(0, 40);
      for (const line of lines) {
        const color = line.startsWith('+') ? this.colors.green : line.startsWith('-') ? this.colors.red : this.colors.dim;
        this.write(`${color(`\u2502 ${truncate(line, 150)}`)}\n`);
      }
    }
    this.write('\u2514\u2500 ');

    for (;;) {
      this.write(this.colors.dim('[y] allow once  [a] always allow  [n] deny  [d] never allow \u203a '));
      const answer = await this.reader.next();
      const value = String(answer.value ?? '').trim().toLowerCase();
      this.write('\n');
      if (answer.done) return 'deny';
      if (['y', 'yes', '1', ''].includes(value)) return 'allow';
      if (['a', 'always', '2'].includes(value)) return 'allow-always';
      if (['n', 'no', '3'].includes(value)) return 'deny';
      if (['d', 'never', '4'].includes(value)) return 'deny-always';
      this.write(this.colors.dim('  please answer y, a, n or d\n'));
    }
  }
}

/** Build the renderer for a normal session. */
export function createRenderer(options = {}) {
  return new TerminalRenderer(options);
}

/**
 * Renderer for a subagent: silent except for problems, so a chatty child cannot
 * drown the parent's transcript. Permission prompts are refused by construction
 * because no reader is attached.
 */
export function createSubagentRenderer({ parent, description }) {
  const label = `subagent:${description ?? 'task'}`;
  const relay = parent ?? { notice() {}, warn() {}, error() {} };
  const noop = () => {};
  return {
    isSubagentRenderer: true,
    startAssistant: noop,
    reasoning: noop,
    text: noop,
    endAssistant: noop,
    toolStart: noop,
    toolEnd: noop,
    todos: noop,
    notice: (message) => relay.notice?.(`[${label}] ${message}`),
    warn: (message) => relay.warn?.(`[${label}] ${message}`),
    error: (message) => relay.error?.(`[${label}] ${message}`),
    askPermission: async () => 'deny',
  };
}

/** Renderer for non-interactive runs: answer text only, diagnostics to stderr. */
export function createPrintRenderer({ stream = process.stdout, colors } = {}) {
  const palette = colors ?? createColors(false);
  return {
    startAssistant() {},
    reasoning() {},
    text(chunk) {
      stream.write(chunk);
    },
    endAssistant() {
      stream.write('\n');
    },
    toolStart() {},
    toolEnd() {},
    todos() {},
    notice() {},
    warn(message) {
      process.stderr.write(`warning: ${message}\n`);
    },
    error(message) {
      process.stderr.write(`error: ${message}\n`);
    },
    askPermission: async () => 'deny',
    // Kept so bin/ can reuse one renderer shape for both modes.
    colors: palette,
  };
}



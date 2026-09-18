/**
 * Interactive terminal layer: a pinned footer (status line + input box) with
 * the conversation streaming above it, plus a raw-mode line editor and a
 * "thinking" status ticker that rotates AI news the way Claude Code rotates
 * tips above its input line.
 *
 * Everything here is only used when the CLI is attached to a real terminal
 * (raw mode is available). Non-TTY runs, tests and subagents keep the plain
 * renderer in ui.js, so the machine-readable stdout contract is untouched.
 */

import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/** Display width of one code point, per the usual wcwidth approximation. */
function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 0) return 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

/** Visible width of a string, ignoring ANSI escapes and counting CJK as 2. */
export function stringWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

/** Clip the input buffer to the available columns, keeping the caret visible. */
function fitLine(prompt, value, caret, columns) {
  const promptWidth = stringWidth(prompt);
  const available = Math.max(1, columns - promptWidth);
  if (stringWidth(value) <= available) return { text: value, caret };

  const ellipsis = '\u2026';
  const target = available - 1;
  let text = value;
  let newCaret = caret;
  while (stringWidth(text) > target && text.length > 0) {
    const removed = text.codePointAt(0) > 0xffff ? 2 : 1;
    text = text.slice(removed);
    newCaret = Math.max(0, newCaret - removed);
  }
  if (newCaret > text.length) newCaret = text.length;
  return { text: ellipsis + text, caret: newCaret + 1 };
}

/**
 * One-line "AI news" items shown above the input box while the agent thinks.
 * These are illustrative and rotate the way Claude Code rotates tips; swap in
 * a live feed later by replacing this array (or the NewsTicker source).
 */
export const AI_NEWS = [
  "DeepSeek's R1 showed reasoning models can be trained for a fraction of US frontier cost.",
  "Alibaba's Qwen family now spans 0.5B to 72B params and tops several open leaderboards.",
  "Moonshot's Kimi k2 pushes 1M-token context into production workloads.",
  "Zhipu's GLM-4.5 claims bilingual parity with GPT-4-class models.",
  "MiniMax's speech models hit near-human latency for live voice agents.",
  "ByteDance's Doubao serves tens of millions of daily active users in China.",
  "Huawei Ascend 910B chips now train trillion-parameter models domestically.",
  "DeepSeek API pricing undercuts GPT-4o by roughly 20x while matching it on many tasks.",
  "StepFun's Step-2 is among the largest open MoE models ever released.",
  "Baidu's ERNIE 4.5 dropped a fully open-source release.",
  "Tencent's Hunyuan Turbo is now the default for WeChat search AI.",
  "Ant Group claims a 20% inference-cost cut from custom serving stacks.",
  "Kuaishou's Kling leads Chinese text-to-video generation benchmarks.",
  "SenseTime's SenseNova 5.5 targets enterprise multimodal RAG.",
  "01.AI's Yi models are tuned for Chinese legal and medical text.",
  "Xiaomi's MiLM powers on-device assistants across its phone lineup.",
  "Alibaba's Tongyi Qianwen now runs fully on-premises for banks.",
  "DeepSeek open-sourced its MLA attention and Multi-Token Prediction.",
  "Chinese labs are converging on MoE plus long context as the default recipe.",
  "Moore Threads and Huawei push domestic GPU training toward exaflop scale.",
];

/** Rotates through a list, firing onTick on start and on every interval. */
export class NewsTicker {
  constructor(items, { intervalMs = 3500, onTick } = {}) {
    this.items = items?.length ? items : [''];
    this.intervalMs = intervalMs;
    this.onTick = onTick ?? (() => {});
    this.index = 0;
    this.timer = null;
    this.running = false;
  }

  current() {
    return this.items[this.index] ?? '';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.onTick(this.current());
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.items.length;
      this.onTick(this.current());
    }, this.intervalMs);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Pins a two-line footer to the bottom of the terminal: a status line and an
 * input line. The body streams above it. Cursor position is tracked so the
 * footer is cleared before each body write and repainted afterwards, always
 * ending with the caret back on the input line.
 */
export class Screen {
  constructor(out, { colors } = {}) {
    this.out = out;
    this.colors = colors ?? null;
    this.statusLine = '';
    this.idleStatus = '';
    this.thinking = false;
    this.painted = false;
    this.cursorCol = 0;
    this.inputPrompt = '> ';
    this.inputValue = '';
    this.inputCaret = 0;
    this.ticker = new NewsTicker(AI_NEWS, {
      intervalMs: 3500,
      onTick: (item) => this.setStatusText(`\u2726  ${item}`),
    });
    this._onResize = () => this.redraw();
    if (out && typeof out.on === 'function') out.on('resize', this._onResize);
  }

  get columns() {
    return this.out?.columns || process.stdout.columns || 80;
  }

  /** Set the status shown when the agent is idle (thinking overrides it). */
  setStatus(text) {
    this.idleStatus = text ?? '';
    if (!this.thinking) this.setStatusText(this.idleStatus);
  }

  setStatusText(text) {
    const dim = this.colors?.dim ?? ((value) => value);
    this.statusLine = dim(text);
    this.redraw();
  }

  startThinking() {
    if (this.thinking) return;
    this.thinking = true;
    this.ticker.start();
  }

  stopThinking() {
    if (!this.thinking) return;
    this.thinking = false;
    this.ticker.stop();
    this.setStatusText(this.idleStatus);
  }

  setInput(prompt, value, caret) {
    this.inputPrompt = prompt ?? '> ';
    this.inputValue = value ?? '';
    this.inputCaret = caret ?? 0;
    this.redraw();
  }

  /** Write conversation content above the footer. */
  writeBody(text) {
    if (!String(text)) return;
    this._clearFooter();
    this.out.write(text);
    this._track(String(text));
    this._drawFooter();
  }

  redraw() {
    if (!this.painted) return;
    this._clearFooter();
    this._drawFooter();
  }

  _clearFooter() {
    if (!this.painted) return;
    readline.moveCursor(this.out, 0, -1);
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    this.out.write('\n');
    readline.clearLine(this.out, 0);
    this.out.write('\n');
    readline.moveCursor(this.out, 0, -2);
    readline.cursorTo(this.out, 0);
    this.painted = false;
    this.cursorCol = 0;
  }

  _drawFooter() {
    if (this.cursorCol !== 0) {
      this.out.write('\n');
      this.cursorCol = 0;
    }
    this.out.write(`${this.statusLine}\n`);
    const { text, caret } = fitLine(this.inputPrompt, this.inputValue, this.inputCaret, this.columns);
    this.out.write(`${this.inputPrompt}${text}\n`);
    readline.moveCursor(this.out, 0, -1);
    const col = stringWidth(this.inputPrompt) + stringWidth(text.slice(0, caret));
    readline.cursorTo(this.out, col);
    this.painted = true;
    this.cursorCol = col;
  }

  _track(text) {
    let col = this.cursorCol;
    for (const ch of stripAnsi(text)) {
      if (ch === '\n' || ch === '\r') col = 0;
      else col += charWidth(ch);
    }
    this.cursorCol = col;
  }

  dispose() {
    this.ticker.stop();
    if (this.out && typeof this.out.off === 'function') this.out.off('resize', this._onResize);
    if (this.painted) {
      this._clearFooter();
      this.out.write('\n');
    }
  }
}

const SS3_KEYS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };

function csiToKey(params, final) {
  switch (final) {
    case 'A': return 'up';
    case 'B': return 'down';
    case 'C': return 'right';
    case 'D': return 'left';
    case 'H': return 'home';
    case 'F': return 'end';
    case 'Z': return 'shift-tab';
    case '~':
      if (params === '3') return 'delete';
      if (params === '1' || params === '7') return 'home';
      if (params === '4' || params === '8') return 'end';
      return 'unknown';
    default:
      return 'unknown';
  }
}

function codePointAt(s, index) {
  const cp = s.codePointAt(index);
  return { char: String.fromCodePoint(cp), length: cp > 0xffff ? 2 : 1 };
}

/**
 * Match the next key at the start of `s`.
 * @returns {{key: string|{text: string}, length: number}|null} null when the
 *          sequence is incomplete and the caller should wait for more input.
 */
export function matchKey(s) {
  if (!s) return null;
  const c = s[0];

  if (c === '\r' || c === '\n') return { key: 'enter', length: 1 };
  if (c === '\x03') return { key: 'ctrl-c', length: 1 };
  if (c === '\x04') return { key: 'ctrl-d', length: 1 };
  if (c === '\x7f' || c === '\x08') return { key: 'backspace', length: 1 };
  if (c === '\t') return { key: 'tab', length: 1 };
  if (c === '\x01') return { key: 'home', length: 1 };
  if (c === '\x05') return { key: 'end', length: 1 };
  if (c === '\x15') return { key: 'kill-line', length: 1 };
  if (c === '\x0b') return { key: 'kill-to-end', length: 1 };
  if (c === '\x17') return { key: 'kill-word', length: 1 };

  if (c === '\x1b') {
    if (s.length < 2) return null;
    const rest = s.slice(1);
    if (rest[0] === 'O') {
      if (rest.length < 2) return null;
      const key = SS3_KEYS[rest[1]];
      return key ? { key, length: 3 } : { key: 'unknown', length: 3 };
    }
    if (rest[0] === '[') {
      let i = 1;
      while (i < rest.length && /[0-9;?]/.test(rest[i])) i += 1;
      if (i >= rest.length) return rest.length <= 12 ? null : { key: 'unknown', length: 2 };
      const key = csiToKey(rest.slice(1, i), rest[i]);
      return { key, length: i + 2 };
    }
    return { key: 'unknown', length: 2 };
  }

  const cp = codePointAt(s, 0);
  return { key: { text: cp.char }, length: cp.length };
}

/** Raw-mode line editor with history, wired into a Screen's input line. */
export class InputBox {
  constructor({ input, screen, history = [], onInterrupt, onEof }) {
    this.input = input;
    this.screen = screen;
    this.history = history.slice();
    this.historyIndex = -1;
    this.buffer = '';
    this.caret = 0;
    this.onInterrupt = onInterrupt ?? (() => {});
    this.onEof = onEof ?? (() => {});
    this.waiters = [];
    this.queue = [];
    this.closed = false;
    this.pending = '';
    this.decoder = new StringDecoder('utf8');

    this.screen.setInput('> ', '', 0);
    try {
      this.input.setRawMode?.(true);
    } catch {
      /* not a real TTY; the plain line reader path is used instead */
    }
    this.input.resume?.();
    this.input.on('data', (chunk) => this._onData(chunk));
    this.input.on('end', () => this._end());
    this.input.on('error', () => this._end());
  }

  _onData(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this._feed(text);
  }

  _end() {
    const tail = this.decoder.end();
    if (tail) this._feed(tail);
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  _feed(text) {
    this.pending += text;
    for (;;) {
      const matched = matchKey(this.pending);
      if (matched === null) return; // wait for the rest of an escape sequence
      this.pending = this.pending.slice(matched.length);
      if (matched.key === 'unknown') continue;
      this._apply(matched.key);
    }
  }

  _apply(key) {
    switch (key) {
      case 'enter': this._submit(); return;
      case 'ctrl-c': this.onInterrupt(); return;
      case 'ctrl-d': if (this.buffer.length === 0) this._eof(); else this._deleteForward(); return;
      case 'backspace': this._deleteBackward(); return;
      case 'delete': this._deleteForward(); return;
      case 'left': if (this.caret > 0) this.caret -= 1; break;
      case 'right': if (this.caret < this.buffer.length) this.caret += 1; break;
      case 'home': this.caret = 0; break;
      case 'end': this.caret = this.buffer.length; break;
      case 'up': this._history(-1); return;
      case 'down': this._history(1); return;
      case 'kill-line':
      case 'kill-to-end': this.buffer = this.buffer.slice(0, this.caret); break;
      case 'kill-word': this._killWord(); return;
      case 'tab': return;
      default:
        if (key && typeof key.text === 'string') {
          this.buffer = this.buffer.slice(0, this.caret) + key.text + this.buffer.slice(this.caret);
          this.caret += key.text.length;
          break;
        }
        return;
    }
    this.render();
  }

  _submit() {
    const line = this.buffer;
    this.buffer = '';
    this.caret = 0;
    this.historyIndex = -1;
    if (line.trim() !== '' && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > 200) this.history.shift();
    }
    this.render();
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.queue.push(line);
  }

  _deleteBackward() {
    if (this.caret === 0) return;
    const removed = this.buffer.codePointAt(this.caret - 1) > 0xffff ? 2 : 1;
    this.buffer = this.buffer.slice(0, this.caret - removed) + this.buffer.slice(this.caret);
    this.caret -= removed;
    this.render();
  }

  _deleteForward() {
    if (this.caret >= this.buffer.length) return;
    const removed = this.buffer.codePointAt(this.caret) > 0xffff ? 2 : 1;
    this.buffer = this.buffer.slice(0, this.caret) + this.buffer.slice(this.caret + removed);
    this.render();
  }

  _killWord() {
    const before = this.buffer.slice(0, this.caret);
    const match = before.match(/(\S+\s*|\s+)$/);
    const start = match ? this.caret - match[0].length : 0;
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.caret);
    this.caret = start;
    this.render();
  }

  _history(direction) {
    if (this.history.length === 0) return;
    if (direction < 0) {
      if (this.historyIndex === -1) this.historyIndex = this.history.length - 1;
      else if (this.historyIndex > 0) this.historyIndex -= 1;
    } else if (this.historyIndex !== -1) {
      if (this.historyIndex < this.history.length - 1) this.historyIndex += 1;
      else this.historyIndex = -1;
    } else {
      return;
    }
    this.buffer = this.historyIndex === -1 ? '' : (this.history[this.historyIndex] ?? '');
    this.caret = this.buffer.length;
    this.render();
  }

  _eof() {
    this.onEof();
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  render() {
    this.screen.setInput('> ', this.buffer, this.caret);
  }

  /** Same shape as createLineReader, so the REPL and prompts can share it. */
  next() {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  dispose() {
    try {
      this.input.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }
}

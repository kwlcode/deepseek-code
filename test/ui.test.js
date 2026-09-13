/** Terminal primitives: colour handling, the shared line reader and the renderers. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  TerminalRenderer,
  createColors,
  createLineReader,
  createPrintRenderer,
  createSubagentRenderer,
  formatDuration,
  shouldUseColor,
  truncate,
  visibleWidth,
} from '../src/ui.js';

/** In-memory stream shaped like process.stdout. */
function fakeOut({ isTTY = false } = {}) {
  return {
    isTTY,
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    get text() {
      return this.chunks.join('');
    },
  };
}

/** Reader stub that replays preset answers. */
function fakeReader(answers) {
  const remaining = [...answers];
  return {
    next: async () => (remaining.length ? { value: remaining.shift(), done: false } : { value: undefined, done: true }),
  };
}

test('colours are dropped for non-TTY streams and when NO_COLOR is set', () => {
  const previous = { ...process.env };
  try {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    assert.equal(shouldUseColor({ isTTY: true }), true);
    assert.equal(shouldUseColor({ isTTY: false }), false);

    process.env.NO_COLOR = '1';
    assert.equal(shouldUseColor({ isTTY: true }), false);

    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    assert.equal(shouldUseColor({ isTTY: false }), true);

    delete process.env.FORCE_COLOR;
    process.env.TERM = 'dumb';
    assert.equal(shouldUseColor({ isTTY: true }), false);
  } finally {
    process.env = previous;
  }
});

test('createColors wraps only when enabled', () => {
  assert.equal(createColors(false).red('x'), 'x');
  assert.equal(createColors(true).red('x'), '\u001b[31mx\u001b[0m');
  assert.equal(createColors(true).enabled, true);
});

test('width and truncation ignore ANSI escapes', () => {
  const colored = createColors(true).green('abcdef');
  assert.equal(visibleWidth(colored), 6);
  assert.equal(truncate(colored, 10), colored);
  assert.equal(visibleWidth(truncate('abcdefghij', 5)), 5);
  assert.match(truncate('abcdefghij', 5), /\u2026$/);
});

test('formatDuration scales from milliseconds to minutes', () => {
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65_000), '1m5s');
});

test('the line reader queues lines and resolves them in order', async () => {
  const reader = createLineReader(Readable.from(['hel', 'lo\nwor', 'ld\r\n', 'tail']));
  assert.deepEqual(await reader.next(), { value: 'hello', done: false });
  assert.deepEqual(await reader.next(), { value: 'world', done: false });
  // The final chunk has no newline, so it is delivered when the stream ends.
  assert.deepEqual(await reader.next(), { value: 'tail', done: false });
  assert.deepEqual(await reader.next(), { value: undefined, done: true });
});

test('collected lines are drained in order', async () => {
  const reader = createLineReader(Readable.from(['a\nb\nc\n']));
  const lines = [];
  for await (const line of reader) {
    if (line === undefined) break;
    lines.push(line);
  }
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('the renderer shows tool calls, caps long output and reports denials', () => {
  const out = fakeOut();
  const renderer = new TerminalRenderer({ out, colors: createColors(false) });

  renderer.toolStart({ name: 'Read', summary: 'Read(src/api.js)' });
  assert.match(out.text, /\u25cf Read\(src\/api\.js\)/);

  const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
  renderer.toolEnd({ name: 'Bash', output: long, durationMs: 10 });
  assert.match(out.text, /line 12/);
  assert.doesNotMatch(out.text, /line 13/);
  assert.match(out.text, /\u2026 8 more line\(s\)/);

  renderer.toolEnd({ name: 'Bash', output: 'nope', isError: true, denied: true });
  assert.match(out.text, /denied/);
});

test('the renderer labels reasoning separately from the answer', () => {
  const out = fakeOut();
  const renderer = new TerminalRenderer({ out, colors: createColors(false) });
  renderer.startAssistant();
  renderer.reasoning('weighing options');
  renderer.text('the answer');
  renderer.endAssistant();
  assert.match(out.text, /thinking/);
  assert.match(out.text, /weighing options/);
  assert.match(out.text, /the answer/);
});

test('todos are listed with a status glyph', () => {
  const out = fakeOut();
  const renderer = new TerminalRenderer({ out, colors: createColors(false) });
  renderer.todos([
    { content: 'read the code', status: 'completed' },
    { content: 'write the fix', status: 'in_progress' },
    { content: 'run the tests', status: 'pending' },
  ]);
  assert.match(out.text, /Tasks/);
  assert.match(out.text, /\u2714 read the code/);
  assert.match(out.text, /\u25a0 write the fix/);
  assert.match(out.text, /\u25a1 run the tests/);
});

test('quiet mode stays silent about tools', () => {
  const out = fakeOut();
  const renderer = new TerminalRenderer({ out, colors: createColors(false), quiet: true });
  renderer.toolStart({ name: 'Read', summary: 'Read(a)' });
  renderer.toolEnd({ name: 'Read', output: 'x' });
  renderer.todos([{ content: 'a', status: 'pending' }]);
  assert.equal(out.text, '');
});

test('a quiet renderer keeps stdout clean and sends diagnostics to stderr', () => {
  const out = fakeOut();
  const err = fakeOut();
  const renderer = new TerminalRenderer({ out, err, colors: createColors(false), quiet: true });

  renderer.notice('Resumed session abc');
  renderer.warn('sandbox disabled');
  renderer.error('boom');

  assert.equal(out.text, '', 'stdout must stay machine-readable for --json');
  assert.match(err.text, /Resumed session abc/);
  assert.match(err.text, /warning: sandbox disabled/);
  assert.match(err.text, /error: boom/);

  // An interactive renderer still writes everything to stdout.
  const liveOut = fakeOut();
  const liveErr = fakeOut();
  const live = new TerminalRenderer({ out: liveOut, err: liveErr, colors: createColors(false) });
  live.notice('hello');
  assert.match(liveOut.text, /hello/);
  assert.equal(liveErr.text, '');
});

test('permission prompts map answers to the four decisions', async () => {
  const out = fakeOut();
  const attempt = async (answers) => {
    const renderer = new TerminalRenderer({ out, colors: createColors(false), reader: fakeReader(answers) });
    return renderer.askPermission({ summary: 'Bash: npm test', tool: 'Bash' });
  };

  assert.equal(await attempt(['y']), 'allow');
  assert.equal(await attempt(['']), 'allow');
  assert.equal(await attempt(['a']), 'allow-always');
  assert.equal(await attempt(['n']), 'deny');
  assert.equal(await attempt(['d']), 'deny-always');
  assert.equal(await attempt(['maybe', 'y']), 'allow');
  assert.match(out.text, /please answer y, a, n or d/);
  // A closed stdin denies rather than hanging.
  assert.equal(await attempt([]), 'deny');
  assert.equal(await new TerminalRenderer({ out, colors: createColors(false) }).askPermission({ summary: 'x', tool: 'Bash' }), 'deny');
});

test('subagent and print renderers never prompt', async () => {
  const parent = { notices: [], notice(message) { this.notices.push(message); } };
  const subagent = createSubagentRenderer({ parent, description: 'explore' });
  subagent.text('noise');
  subagent.toolStart({ name: 'Read', summary: 'Read(a)' });
  subagent.notice('using Read');
  assert.deepEqual(parent.notices, ['[subagent:explore] using Read']);
  assert.equal(await subagent.askPermission({ summary: 'Bash: rm -rf /', tool: 'Bash' }), 'deny');

  const out = fakeOut();
  const print = createPrintRenderer({ stream: out });
  print.toolStart({ name: 'Read', summary: 'Read(a)' });
  print.text('hello');
  print.endAssistant({});
  assert.equal(out.text, 'hello\n');
  assert.equal(await print.askPermission({ summary: 'x', tool: 'Bash' }), 'deny');
});


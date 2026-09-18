/** The interactive terminal layer: width, key parsing and the news ticker. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_NEWS, NewsTicker, matchKey, stringWidth, stripAnsi } from '../src/terminal.js';

test('stringWidth counts CJK as 2 columns and ignores ANSI', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('你好'), 4);
  assert.equal(stringWidth('a你b'), 4);
  assert.equal(stringWidth('\u001b[31mhi\u001b[0m'), 2);
  assert.equal(stringWidth(''), 0);
});

test('stripAnsi removes colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('matchKey parses control keys, arrows and printable text', () => {
  assert.deepEqual(matchKey('\r'), { key: 'enter', length: 1 });
  assert.deepEqual(matchKey('\n'), { key: 'enter', length: 1 });
  assert.deepEqual(matchKey('\x7f'), { key: 'backspace', length: 1 });
  assert.deepEqual(matchKey('\x08'), { key: 'backspace', length: 1 });
  assert.deepEqual(matchKey('\x03'), { key: 'ctrl-c', length: 1 });
  assert.deepEqual(matchKey('\x04'), { key: 'ctrl-d', length: 1 });
  assert.deepEqual(matchKey('\x01'), { key: 'home', length: 1 });
  assert.deepEqual(matchKey('\x05'), { key: 'end', length: 1 });
  assert.deepEqual(matchKey('\x15'), { key: 'kill-line', length: 1 });
  assert.deepEqual(matchKey('\x1b[A'), { key: 'up', length: 3 });
  assert.deepEqual(matchKey('\x1b[D'), { key: 'left', length: 3 });
  assert.deepEqual(matchKey('\x1bOH'), { key: 'home', length: 3 });
  assert.deepEqual(matchKey('\x1b[3~'), { key: 'delete', length: 4 });
  assert.deepEqual(matchKey('\x1b[1~'), { key: 'home', length: 4 });
  assert.deepEqual(matchKey('\x1b[1;5D'), { key: 'left', length: 6 });
  assert.deepEqual(matchKey('a'), { key: { text: 'a' }, length: 1 });
  assert.deepEqual(matchKey('你'), { key: { text: '你' }, length: 1 });
  assert.deepEqual(matchKey('\u{1f600}'), { key: { text: '\u{1f600}' }, length: 2 });
});

test('matchKey waits for an incomplete escape sequence', () => {
  assert.equal(matchKey('\x1b'), null);
  assert.equal(matchKey('\x1b['), null);
  assert.equal(matchKey('\x1bO'), null);
});

test('NewsTicker emits on start and stops cleanly', () => {
  const seen = [];
  const ticker = new NewsTicker(['a', 'b'], { intervalMs: 10, onTick: (item) => seen.push(item) });
  assert.equal(ticker.current(), 'a');
  ticker.start();
  assert.deepEqual(seen, ['a']);
  ticker.stop();
  assert.equal(ticker.running, false);
});

test('AI_NEWS is a non-empty list of strings', () => {
  assert.ok(AI_NEWS.length > 0);
  for (const item of AI_NEWS) assert.equal(typeof item, 'string');
});

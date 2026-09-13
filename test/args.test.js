/** CLI argument parsing and help text. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, usageText } from '../bin/deepseek-code.js';

test('parses string flags in both spellings', () => {
  const { flags, positionals } = parseArgs(['-m', 'deepseek-v4-pro', '--effort=low', 'explain src']);
  assert.equal(flags.model, 'deepseek-v4-pro');
  assert.equal(flags.effort, 'low');
  assert.deepEqual(positionals, ['explain src']);
});

test('parses boolean flags, including --flag=false', () => {
  assert.equal(parseArgs(['--json']).flags.json, true);
  assert.equal(parseArgs(['--json=false']).flags.json, false);
  assert.equal(parseArgs(['--dangerously-skip-permissions']).flags.skipPermissions, true);
  assert.equal(parseArgs(['--yolo']).flags.skipPermissions, true);
  assert.equal(parseArgs(['-c']).flags.continue, true);
});

test('--resume takes an optional id', () => {
  assert.equal(parseArgs(['-r']).flags.resume, true);
  assert.equal(parseArgs(['--resume', 'abc123']).flags.resume, 'abc123');
});

test('-p takes an optional prompt', () => {
  const bare = parseArgs(['-p']);
  assert.equal(bare.flags.print, true);
  assert.deepEqual(bare.positionals, []);

  const withPrompt = parseArgs(['-p', 'fix the tests']);
  assert.equal(withPrompt.flags.print, 'fix the tests');
  assert.deepEqual(withPrompt.positionals, []);

  const withFlag = parseArgs(['-p', '--json']);
  assert.equal(withFlag.flags.print, true);
  assert.equal(withFlag.flags.json, true);
});

test('recognises a subcommand only in the first position', () => {
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.equal(parseArgs(['--json', 'models']).command, 'models');
  const later = parseArgs(['explain', 'doctor']);
  assert.equal(later.command, null);
  assert.deepEqual(later.positionals, ['explain', 'doctor']);
});

test('-- passes everything after it through as positional text', () => {
  const { flags, positionals } = parseArgs(['-p', '--', '--not-a-flag', 'and this']);
  assert.equal(flags.print, true);
  assert.deepEqual(positionals, ['--not-a-flag', 'and this']);
});

test('rejects unknown options and missing values', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option: --nope/);
  assert.throws(() => parseArgs(['--model']), /--model needs a value/);
  // `--flag=` keeps an explicit empty value rather than swallowing the next token.
  assert.equal(parseArgs(['--api-key=', 'hello']).flags.apiKey, '');
  assert.deepEqual(parseArgs(['--api-key=', 'hello']).positionals, ['hello']);
});

test('help text documents every permission mode and the settings files', () => {
  const text = usageText();
  for (const mode of ['plan', 'default', 'acceptEdits', 'bypassPermissions']) {
    assert.match(text, new RegExp(mode));
  }
  assert.match(text, /DEEPSEEK_API_KEY/);
  assert.match(text, /CLAUDE\.md|AGENTS\.md/);
  assert.match(text, /deepseek-code \d+\.\d+\.\d+/);
});

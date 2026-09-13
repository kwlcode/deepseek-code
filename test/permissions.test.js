/** Permission rules, matching, and the four permission modes. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PermissionEngine,
  parseRule,
  ruleFor,
  ruleMatches,
  ruleSubject,
  describeCall,
} from '../src/permissions.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

const BASH = { name: 'Bash', readOnly: false, planModeSafe: false };
const READ = { name: 'Read', readOnly: true, planModeSafe: true };
const EDIT = { name: 'Edit', readOnly: false, planModeSafe: false };
const TASK = { name: 'Task', readOnly: true, planModeSafe: true };

test('parses Claude Code rule syntax', () => {
  assert.deepEqual(parseRule('Read'), { tool: 'Read', specifier: null, raw: 'Read' });
  assert.deepEqual(parseRule(' Edit(/src/**) '), { tool: 'Edit', specifier: '/src/**', raw: 'Edit(/src/**)' });
  assert.equal(parseRule('Bash(git commit:*)').specifier, 'git commit:*');
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('not a rule!'), null);
});

test('compares bash rules against the command prefix', () => {
  assert.equal(ruleMatches('Bash(git commit:*)', 'Bash', { command: 'git commit -m "x"' }, CWD), true);
  assert.equal(ruleMatches('Bash(git commit:*)', 'Bash', { command: 'git status' }, CWD), false);
  assert.equal(ruleMatches('Bash', 'Bash', { command: 'anything' }, CWD), true);
  assert.equal(ruleMatches('Bash(npm run test)', 'Bash', { command: 'npm run test' }, CWD), true);
});

test('compares file rules against project-relative paths', () => {
  const input = { file_path: 'src/api.js' };
  assert.equal(ruleSubject('Read', input, CWD), 'src/api.js');
  assert.equal(ruleMatches('Read(src/**)', 'Read', input, CWD), true);
  assert.equal(ruleMatches('Read(api.js)', 'Read', input, CWD), true);
  assert.equal(ruleMatches('Read(tests/**)', 'Read', input, CWD), false);
  assert.equal(ruleMatches('Edit(src/**)', 'Read', input, CWD), false);
});

test('supports WebFetch domain rules', () => {
  const input = { url: 'https://docs.deepseek.com/api' };
  assert.equal(ruleMatches('WebFetch(domain:deepseek.com)', 'WebFetch', input, CWD), true);
  assert.equal(ruleMatches('WebFetch(domain:example.com)', 'WebFetch', input, CWD), false);
});

test('suggests a sensible remember-rule', () => {
  assert.equal(ruleFor('Bash', { command: 'git commit -m "x"' }, CWD), 'Bash(git commit:*)');
  assert.equal(ruleFor('Bash', { command: 'ls -la' }, CWD), 'Bash(ls:*)');
  assert.equal(ruleFor('Bash', { command: 'curl http://example.com' }, CWD), 'Bash(curl:*)');
  assert.equal(ruleFor('Bash', { command: 'node ./scripts/build.js' }, CWD), 'Bash(node:*)');
  assert.equal(ruleFor('Edit', { file_path: 'src/tools/fs.js' }, CWD), 'Edit(src/tools/**)');
  assert.equal(ruleFor('Read', { file_path: 'package.json' }, CWD), 'Read');
});

test('describes calls for the approval prompt', () => {
  assert.equal(describeCall('Bash', { command: 'npm test\nrm -rf /' }), 'Bash: npm test');
  assert.equal(describeCall('Write', { file_path: 'a.txt' }), 'Write a.txt');
  assert.equal(describeCall('Grep', { pattern: 'TODO', path: 'src' }), 'Grep TODO in src');
});


function engine(options = {}) {
  const notices = [];
  const remembered = [];
  const instance = new PermissionEngine({
    cwd: options.cwd ?? CWD,
    mode: options.mode ?? 'default',
    allow: options.allow ?? [],
    deny: options.deny ?? [],
    ask: options.ask ?? null,
    nonInteractive: options.nonInteractive ?? false,
    onNotice: (message) => notices.push(message),
    rememberRule: (rule) => remembered.push(rule),
  });
  return { engine: instance, notices, remembered };
}

test('read-only tools never ask, in every mode', () => {
  for (const mode of ['plan', 'default', 'acceptEdits', 'bypassPermissions']) {
    const { engine: permissions } = engine({ mode });
    assert.equal(permissions.evaluate(READ, { file_path: 'a.js' }).behavior, 'allow');
    assert.equal(permissions.evaluate({ name: 'TodoWrite', readOnly: false }, {}).behavior, 'allow');
  }
});

test('plan mode denies anything that changes the project', () => {
  const { engine: permissions } = engine({ mode: 'plan' });
  const decision = permissions.evaluate(EDIT, { file_path: 'a.js' });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.reason, /plan mode is read-only/);
  assert.equal(permissions.evaluate(BASH, { command: 'touch x' }).behavior, 'deny');
  assert.equal(permissions.evaluate(TASK, { prompt: 'look around' }).behavior, 'allow');
});

test('acceptEdits allows file edits but still asks for shell commands', () => {
  const { engine: permissions } = engine({ mode: 'acceptEdits', ask: async () => 'allow' });
  assert.equal(permissions.evaluate(EDIT, { file_path: 'a.js' }).behavior, 'allow');
  assert.equal(permissions.evaluate(BASH, { command: 'npm test' }).behavior, 'ask');
  // Task is never silently allowed: a subagent can edit files on its own.
  assert.equal(permissions.evaluate(TASK, { prompt: 'x' }).behavior, 'ask');
});

test('default mode asks for writes and never prompts when there is no reader', () => {
  const { engine: prompting } = engine({ mode: 'default', ask: async () => 'allow' });
  assert.equal(prompting.evaluate(EDIT, { file_path: 'a.js' }).behavior, 'ask');

  const { engine: silent } = engine({ mode: 'default', nonInteractive: true, ask: async () => 'allow' });
  const decision = silent.evaluate(EDIT, { file_path: 'a.js' });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.reason, /no interactive prompt/);
});

test('deny rules beat allow rules', () => {
  const { engine: permissions } = engine({
    allow: ['Bash'],
    deny: ['Bash(rm:*)'],
    mode: 'bypassPermissions',
  });
  assert.equal(permissions.evaluate(BASH, { command: 'npm test' }).behavior, 'allow');
  const blocked = permissions.evaluate(BASH, { command: 'rm -rf build' });
  assert.equal(blocked.behavior, 'deny');
  assert.match(blocked.reason, /Bash\(rm:\*\)/);
});

test('"always allow" remembers a rule and applies it to later calls', async () => {
  const { engine: permissions, notices, remembered } = engine({
    mode: 'default',
    ask: async () => 'allow-always',
  });
  const first = await permissions.request(BASH, { command: 'git commit -m "x"' });
  assert.equal(first.behavior, 'allow');
  assert.deepEqual(remembered, ['Bash(git commit:*)']);
  assert.deepEqual(permissions.allow, ['Bash(git commit:*)']);
  assert.match(notices.join('\n'), /Saved allow rule/);

  // A second, similar command no longer prompts.
  const second = permissions.evaluate(BASH, { command: 'git commit --amend' });
  assert.equal(second.behavior, 'allow');
  assert.match(second.reason, /allowed by rule/);
});

test('"never allow" saves a deny rule', async () => {
  const { engine: permissions } = engine({ mode: 'default', ask: async () => 'deny-always' });
  await permissions.request(BASH, { command: 'curl http://example.com' });
  // The URL is dropped: `curl:*` is the rule the user will expect.
  assert.deepEqual(permissions.deny, ['Bash(curl:*)']);
  assert.equal(permissions.evaluate(BASH, { command: 'curl http://evil' }).behavior, 'deny');
});

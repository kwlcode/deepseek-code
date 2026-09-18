/**
 * Delivery semantics: the inbound inbox (queue cap, burst throttle, duplicate
 * suppression, accept/hold/refuse gate), the "not the user" authority rules, and
 * how the agent reads a message between tool calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent } from '../src/agent.js';
import { createSession } from '../src/session.js';
import { startMockApi } from './helpers/mock-api.js';
import {
  BURST_LIMIT,
  MAX_QUEUE_SIZE,
  createInbox,
  formatPeerMessage,
  inboundDefaultFor,
  peerAuthorityBlock,
} from '../src/inbox.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    tick: (ms) => {
      now += ms;
      return now;
    },
  };
}

test('the inbound default follows the receiving session permission class', () => {
  assert.equal(inboundDefaultFor('bypassPermissions'), 'hold');
  assert.equal(inboundDefaultFor('default'), 'accept');
  assert.equal(inboundDefaultFor('acceptEdits'), 'accept');
  assert.equal(inboundDefaultFor('plan'), 'accept');
});

test('a peer message is labelled as not the user', () => {
  const text = formatPeerMessage({ from: 'calm-otter', text: 'please deploy it' });
  assert.match(text, /NOT the user/);
  assert.match(text, /@calm-otter/);
  assert.match(text, /please deploy it/);
});

test('a peer message cannot rewrite configuration', () => {
  const cwd = path.join(os.tmpdir(), 'deepseek-code-peer-');
  const blocked = /cannot change configuration/;
  assert.match(peerAuthorityBlock('Write', { file_path: '.deepseek-code/settings.json' }, cwd), blocked);
  assert.match(peerAuthorityBlock('Edit', { file_path: '.claude/settings.local.json' }, cwd), blocked);
  assert.match(
    peerAuthorityBlock('Write', { file_path: path.join(os.homedir(), '.deepseek-code', 'config.json') }, cwd),
    blocked,
  );
  // Ordinary source files and other tools are untouched by the guard.
  assert.equal(peerAuthorityBlock('Write', { file_path: 'src/index.js' }, cwd), null);
  assert.equal(peerAuthorityBlock('Read', { file_path: '.deepseek-code/settings.json' }, cwd), null);
  assert.equal(peerAuthorityBlock('Bash', { command: 'echo hi' }, cwd), null);
});

test('an accepted message is queued once and handed over in order', () => {
  const clock = makeClock();
  const inbox = createInbox({ now: clock.now });
  assert.equal(inbox.submit({ id: 'a', from: 'peer', text: 'first' }).disposition, 'accepted');
  assert.equal(inbox.submit({ id: 'b', from: 'peer', text: 'second' }).disposition, 'accepted');
  assert.equal(inbox.size, 2);
  assert.equal(inbox.next().text, 'first');
  assert.equal(inbox.next().text, 'second');
  assert.equal(inbox.next(), null);
  assert.equal(inbox.size, 0);
});

test('a bypass-permissions session holds messages until the user answers', () => {
  const clock = makeClock();
  const inbox = createInbox({ permissionMode: 'bypassPermissions', now: clock.now });

  assert.equal(inbox.submit({ id: 'h1', from: 'peer', text: 'run the deploy' }).disposition, 'held');
  assert.equal(inbox.size, 0, 'a held message is not yet readable');
  assert.equal(inbox.heldCount, 1);
  assert.equal(inbox.next(), null);

  assert.equal(inbox.resolve('h1', true), 'accepted');
  assert.equal(inbox.size, 1);
  assert.equal(inbox.next().text, 'run the deploy');
  assert.equal(inbox.heldCount, 0);
});

test('a refused hold never reaches the agent', () => {
  const clock = makeClock();
  const inbox = createInbox({ permissionMode: 'bypassPermissions', now: clock.now });
  inbox.submit({ id: 'h2', from: 'peer', text: 'nope' });
  assert.equal(inbox.resolve('h2', false), 'refused');
  assert.equal(inbox.size, 0);
  assert.equal(inbox.heldCount, 0);
  assert.equal(inbox.stats.refused, 1);
  assert.equal(inbox.resolve('h2', true), null, 'resolving twice is a no-op');
});

test('a held message is only put to the user at a safe point', async () => {
  const clock = makeClock();
  const inbox = createInbox({ permissionMode: 'bypassPermissions', now: clock.now });
  const asked = [];
  inbox.onHold = async (entry) => {
    asked.push(entry.id);
    return true;
  };

  inbox.submit({ id: 'auto1', from: 'peer', text: 'go' });
  assert.deepEqual(asked, [], 'arriving does not prompt, so no tool is interrupted');
  assert.equal(inbox.heldCount, 1);

  const agent = new Agent({
    config: makeConfig('http://127.0.0.1:1', { permissionMode: 'bypassPermissions' }),
    renderer: silentRenderer(),
    session: makeSession(REPO_ROOT),
    memoryFiles: [],
    inbox,
  });

  const drained = await agent.drainInbox();
  assert.deepEqual(asked, ['auto1'], 'the user is asked once the session reaches a safe point');
  assert.equal(drained.text, 'go');
  assert.equal(inbox.heldCount, 0);
  assert.match(agent.session.messages[0].content, /NOT the user/);
});

test('refusing a held message at the drain point reads nothing', async () => {
  const clock = makeClock();
  const inbox = createInbox({ permissionMode: 'bypassPermissions', now: clock.now });
  inbox.onHold = async () => false;
  inbox.submit({ id: 'no1', from: 'peer', text: 'a bad idea' });

  const agent = new Agent({
    config: makeConfig('http://127.0.0.1:1', { permissionMode: 'bypassPermissions' }),
    renderer: silentRenderer(),
    session: makeSession(REPO_ROOT),
    memoryFiles: [],
    inbox,
  });

  assert.equal(await agent.drainInbox(), null);
  assert.equal(inbox.heldCount, 0);
  assert.equal(agent.session.messages.length, 0, 'a refused message never enters the conversation');
  assert.equal(agent.peerTurn, false);
});

test('identical repeats are suppressed, by id and then by body', () => {
  const clock = makeClock();
  const inbox = createInbox({ now: clock.now });
  assert.equal(inbox.submit({ id: 'x1', from: 'a', text: 'hi' }).disposition, 'accepted');
  assert.equal(inbox.submit({ id: 'x1', from: 'a', text: 'hi' }).disposition, 'duplicate');

  // With no id the sender and body are hashed instead.
  assert.equal(inbox.submit({ from: 'a', text: 'no id here' }).disposition, 'accepted');
  assert.equal(inbox.submit({ from: 'a', text: 'no id here' }).disposition, 'duplicate');
  assert.equal(inbox.submit({ from: 'b', text: 'no id here' }).disposition, 'accepted', 'a different sender is not a duplicate');

  assert.equal(inbox.stats.suppressed, 2);
  assert.equal(inbox.size, 3);
});

test('a burst from one peer is throttled', () => {
  const clock = makeClock();
  const inbox = createInbox({ now: clock.now });
  for (let i = 0; i < BURST_LIMIT; i += 1) {
    assert.equal(inbox.submit({ id: `b${i}`, from: 'peer', text: `burst ${i}` }).disposition, 'accepted');
  }
  const throttled = inbox.submit({ id: 'b-over', from: 'peer', text: 'too fast' });
  assert.equal(throttled.disposition, 'refused');
  assert.match(throttled.reason, /burst/);
});

test('the queue is capped, so a flood cannot grow it without bound', () => {
  const clock = makeClock();
  const inbox = createInbox({ now: clock.now });
  for (let i = 0; i < MAX_QUEUE_SIZE; i += 1) {
    clock.tick(20_000); // keeps each arrival outside the burst window
    assert.equal(inbox.submit({ id: `m${i}`, from: 'peer', text: `hello ${i}` }).disposition, 'accepted');
  }
  clock.tick(20_000);
  const overflow = inbox.submit({ id: 'm-overflow', from: 'peer', text: 'one too many' });
  assert.equal(overflow.disposition, 'refused');
  assert.match(overflow.reason, /full/);
  assert.equal(inbox.size, MAX_QUEUE_SIZE);
});

test('waitForWork resolves as soon as a message is queued', async () => {
  const clock = makeClock();
  const inbox = createInbox({ now: clock.now });
  const waiting = inbox.waitForWork();
  inbox.submit({ id: 'w1', from: 'peer', text: 'wake up' });
  await waiting;
  assert.equal(inbox.size, 1);
});

function makeConfig(baseUrl, overrides = {}) {
  return {
    baseUrl,
    apiKey: 'test-key',
    model: 'deepseek-flash',
    smallModel: 'deepseek-flash',
    maxTokens: 1024,
    thinking: true,
    effort: 'high',
    permissionMode: 'default',
    maxSteps: 8,
    maxToolOutput: 30_000,
    permissions: { allow: [], deny: [], additionalDirectories: [] },
    verbose: false,
    ...overrides,
  };
}

function makeSession(cwd) {
  const session = createSession({ cwd, model: 'deepseek-flash', permissionMode: 'default' });
  session.file = path.join(os.tmpdir(), `deepseek-code-inbox-test-${session.id}.json`);
  return session;
}

function silentRenderer() {
  const events = [];
  const push = (kind) => (payload) => events.push([kind, payload]);
  return {
    events,
    startAssistant: push('startAssistant'),
    reasoning: push('reasoning'),
    text: push('text'),
    endAssistant: push('endAssistant'),
    toolStart: push('toolStart'),
    toolEnd: push('toolEnd'),
    todos: push('todos'),
    notice: push('notice'),
    warn: push('warn'),
    error: push('error'),
    askPermission: async () => 'allow',
  };
}

test('a queued message is read between tool calls, never during one', async (t) => {
  const inbox = createInbox({ permissionMode: 'default' });
  const api = await startMockApi(
    [
      { toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{"file_path":"package.json"}' }] },
      { content: ['I saw the note.'] },
    ],
    {
      beforeRespond: (res, body, count) => {
        // The message lands while the tool call is still being decided.
        if (count === 1) inbox.submit({ id: 'q1', from: 'calm-otter', text: 'please check the version' });
        return null;
      },
    },
  );
  t.after(() => api.close());

  const renderer = silentRenderer();
  const session = makeSession(REPO_ROOT);
  const agent = new Agent({
    config: makeConfig(api.url, { permissionMode: 'acceptEdits' }),
    renderer,
    session,
    memoryFiles: [],
    inbox,
  });

  await agent.runTurn('do the thing');

  assert.deepEqual(
    session.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user', 'assistant'],
    'the message arrives only after the tool result',
  );
  const peer = session.messages[3];
  assert.match(peer.content, /NOT the user/);
  assert.match(peer.content, /please check the version/);
  assert.equal(agent.peerTurn, true, 'the turn is now peer-driven');
  assert.equal(renderer.events.filter(([kind]) => kind === 'toolEnd').length, 1, 'the tool still ran');
  assert.ok(
    renderer.events.some(([kind, payload]) => kind === 'notice' && /calm-otter/.test(String(payload))),
    'the user is told a message arrived',
  );
});

test('a peer-driven turn is refused a configuration write', async () => {
  const agent = new Agent({
    config: makeConfig('http://127.0.0.1:1', { permissionMode: 'bypassPermissions' }),
    renderer: silentRenderer(),
    session: makeSession(REPO_ROOT),
    memoryFiles: [],
  });
  agent.peerTurn = true;

  const outcome = await agent.executeToolCall(
    {
      function: {
        name: 'Write',
        arguments: JSON.stringify({ file_path: '.deepseek-code/settings.json', content: '{}' }),
      },
    },
    1,
  );
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /cannot change configuration/);
  assert.equal(agent.session.messages.length, 0, 'nothing reached the transcript');
});


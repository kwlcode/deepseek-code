/**
 * End-to-end tests for the agent loop, driven by the stub API in
 * test/helpers/mock-api.js. These exercise streaming, tool execution, the
 * permission engine and transcript persistence without touching the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Agent } from '../src/agent.js';
import { createSession } from '../src/session.js';
import { startMockApi } from './helpers/mock-api.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function makeSession(cwd, overrides = {}) {
  const session = createSession({ cwd, model: 'deepseek-flash', permissionMode: 'default' });
  // Keep transcripts out of the user's real project directory.
  session.file = path.join(os.tmpdir(), `deepseek-code-test-${session.id}.json`);
  return Object.assign(session, overrides);
}

/** Renderer that records calls instead of writing to a terminal. */
function recordingRenderer(answer = 'allow') {
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
    askPermission: async (request) => {
      events.push(['askPermission', request]);
      return answer;
    },
    textSoFar: () => events.filter(([kind]) => kind === 'text').map(([, chunk]) => chunk).join(''),
  };
}

test('streams reasoning, runs a tool call and feeds the result back', async (t) => {
  const api = await startMockApi([
    {
      reasoning: ['I need to read package.json first.'],
      toolCalls: [{ id: 'call_a', name: 'Read', arguments: ['{"file_pa', 'th":"package.json"}'] }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      },
    },
    {
      content: ['The package is ', 'deepseek-code.'],
      usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 },
    },
  ]);
  t.after(() => api.close());

  const config = makeConfig(api.url, { permissionMode: 'bypassPermissions' });
  const session = makeSession(REPO_ROOT);
  const renderer = recordingRenderer();
  const agent = build(config, session, renderer);

  const outcome = await agent.runTurn('what is this package?');

  assert.equal(outcome.text, 'The package is deepseek-code.');
  assert.equal(outcome.steps, 2);
  assert.equal(outcome.stopped, null);

  // The transcript is user -> assistant(tool_calls) -> tool -> assistant.
  assert.deepEqual(
    session.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  const toolMessage = session.messages[2];
  assert.equal(toolMessage.tool_call_id, 'call_a');
  assert.match(toolMessage.content, /deepseek-code/);
  assert.doesNotMatch(toolMessage.content, /^Error:/);

  // Fragmented tool-call arguments were reassembled.
  const followUp = api.requests[1];
  const assistant = followUp.messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, 'Read');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"file_path":"package.json"}');
  // DeepSeek loses the chain of thought unless it is echoed back.
  assert.equal(assistant.reasoning_content, 'I need to read package.json first.');

  assert.ok(followUp.tools.some((entry) => entry.function.name === 'Read'));
  assert.equal(followUp.stream, true);
  assert.deepEqual(followUp.thinking, { type: 'enabled' });

  // Usage is tracked across both steps.
  assert.equal(agent.tracker.turns, 2);
  assert.equal(agent.tracker.totals.input, 300);
  assert.ok(agent.tracker.usd > 0);

  // Streaming reached the renderer.
  assert.equal(renderer.textSoFar(), 'The package is deepseek-code.');
  assert.ok(renderer.events.some(([kind, payload]) => kind === 'toolStart' && payload.summary.startsWith('Read')));

  const persistence = await fsp.readFile(session.file, 'utf8');
  assert.match(persistence, /what is this package\?/);
});

test('reports unknown tools, malformed arguments and missing parameters back to the model', async (t) => {
  const api = await startMockApi([
    {
      toolCalls: [
        { id: 'call_unknown', name: 'NotATool', arguments: '{}' },
        { id: 'call_broken', name: 'Read', arguments: '{"file_path":' },
        { id: 'call_missing', name: 'Read', arguments: '{}' },
      ],
    },
    { content: ['ok'] },
  ]);
  t.after(() => api.close());

  const session = makeSession(REPO_ROOT);
  const agent = build(makeConfig(api.url, { permissionMode: 'bypassPermissions' }), session, recordingRenderer());
  await agent.runTurn('go');

  const results = session.messages.filter((message) => message.role === 'tool');
  assert.equal(results.length, 3);
  assert.match(results[0].content, /unknown tool "NotATool"/);
  assert.match(results[1].content, /could not parse tool arguments/);
  assert.match(results[2].content, /file_path/);
});

test('permission engine refuses non read-only tools when no prompt is available', async (t) => {
  const api = await startMockApi([
    { toolCalls: [{ id: 'call_bash', name: 'Bash', arguments: '{"command":"echo hi > /tmp/blocked.txt"}' }] },
    { content: ['understood'] },
  ]);
  t.after(() => api.close());

  const session = makeSession(REPO_ROOT);
  const renderer = recordingRenderer('deny');
  const agent = new Agent({
    config: makeConfig(api.url, { permissionMode: 'default' }),
    session,
    renderer,
    interactive: false,
    permissionMode: 'default',
    memoryFiles: [],
  });
  const outcome = await agent.runTurn('run a command');

  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /denied/i);
  assert.equal(renderer.events.filter(([kind]) => kind === 'askPermission').length, 0);
  assert.equal(outcome.text, 'understood');
});

test('an interactive deny stops the command but not the turn', async (t) => {
  const api = await startMockApi([
    { toolCalls: [{ id: 'call_bash', name: 'Bash', arguments: '{"command":"git push"}' }] },
    { content: ['I did not run it.'] },
  ]);
  t.after(() => api.close());

  const session = makeSession(REPO_ROOT);
  const renderer = recordingRenderer('deny');
  const agent = build(makeConfig(api.url, { permissionMode: 'default' }), session, renderer);
  const outcome = await agent.runTurn('push');

  assert.equal(renderer.events.filter(([kind]) => kind === 'askPermission').length, 1);
  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /denied by user/);
  assert.equal(outcome.text, 'I did not run it.');
});

test('plan mode refuses writes, acceptEdits performs them', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-mode-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'note.txt');
  const args = JSON.stringify({ file_path: filePath, content: 'hello' });

  const planApi = await startMockApi([
    { toolCalls: [{ id: 'call_write', name: 'Write', arguments: args }] },
    { content: ['blocked'] },
  ]);
  t.after(() => planApi.close());

  const planSession = makeSession(directory);
  const planAgent = build(makeConfig(planApi.url, { permissionMode: 'plan' }), planSession, recordingRenderer());
  await planAgent.runTurn('write a file');
  assert.match(planSession.messages.find((message) => message.role === 'tool').content, /plan mode is read-only/);
  await assert.rejects(() => fsp.readFile(filePath, 'utf8'));

  const editApi = await startMockApi([
    { toolCalls: [{ id: 'call_write', name: 'Write', arguments: args }] },
    { content: ['written'] },
  ]);
  t.after(() => editApi.close());

  const editSession = makeSession(directory);
  const editAgent = build(makeConfig(editApi.url, { permissionMode: 'acceptEdits' }), editSession, recordingRenderer());
  const outcome = await editAgent.runTurn('write a file');
  assert.equal(outcome.text, 'written');
  assert.equal(await fsp.readFile(filePath, 'utf8'), 'hello');
});

test('retries a transient server error instead of failing the turn', async (t) => {
  const api = await startMockApi([{ content: ['recovered'] }], {
    beforeRespond(res, body, count) {
      if (count > 1) return null;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporarily overloaded' } }));
      return 'handled';
    },
  });
  t.after(() => api.close());

  const session = makeSession(REPO_ROOT);
  const agent = build(makeConfig(api.url, { permissionMode: 'bypassPermissions' }), session, recordingRenderer());
  const outcome = await agent.runTurn('hello');

  assert.equal(outcome.text, 'recovered');
  assert.equal(api.requests.length, 2);
});


function build(config, session, renderer) {
  return new Agent({
    config,
    session,
    renderer,
    interactive: true,
    permissionMode: config.permissionMode,
    memoryFiles: [],
  });
}

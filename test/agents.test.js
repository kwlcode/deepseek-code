/** Agent discovery and messaging tools: ListAgents and SendMessage. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listReachableAgents, resolveTarget, listAgentsTool, sendMessageTool } from '../src/tools/agents.js';
import { listAgentDefinitions } from '../src/tools/task.js';
import { registerSession } from '../src/registry.js';

async function scratchWithAgents() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-agents-'));
  const agentsDir = path.join(dir, '.claude', 'agents');
  await fsp.mkdir(agentsDir, { recursive: true });
  await fsp.writeFile(
    path.join(agentsDir, 'reviewer.md'),
    '---\ndescription: Reviews code for bugs\ntools: [Read, Grep]\n---\nFind bugs and report them.\n',
  );
  return dir;
}

test('listAgentDefinitions reads every subagent definition on disk', async () => {
  const dir = await scratchWithAgents();
  const definitions = await listAgentDefinitions(dir);
  const reviewer = definitions.find((d) => d.name === 'reviewer');
  assert.ok(reviewer, 'reviewer definition found');
  assert.equal(reviewer.description, 'Reviews code for bugs');
  assert.deepEqual(reviewer.tools, ['Read', 'Grep']);
  assert.match(reviewer.systemPrompt, /Find bugs/);
});

test('ListAgents surfaces subagents by name and kind', async () => {
  const dir = await scratchWithAgents();
  const agents = await listReachableAgents(dir);
  const reviewer = agents.find((a) => a.name === 'reviewer');
  assert.ok(reviewer, 'reviewer listed');
  assert.equal(reviewer.kind, 'subagent');
  assert.equal(reviewer.description, 'Reviews code for bugs');
});

test('resolveTarget matches a subagent by name and rejects unknowns', async () => {
  const dir = await scratchWithAgents();
  const target = await resolveTarget(dir, 'reviewer');
  assert.equal(target.kind, 'subagent');
  assert.equal(await resolveTarget(dir, 'no-such-agent'), null);
  assert.equal(await resolveTarget(dir, ''), null);
});

test('SendMessage and ListAgents declare the expected contracts', () => {
  assert.equal(listAgentsTool.name, 'ListAgents');
  assert.equal(listAgentsTool.readOnly, true);
  assert.equal(sendMessageTool.name, 'SendMessage');
  assert.equal(sendMessageTool.readOnly, false);
  assert.equal(sendMessageTool.planModeSafe, true);
  assert.deepEqual(sendMessageTool.inputSchema.required, ['name', 'text']);
});

test('live sessions are addressed by name and disambiguated by id', async () => {
  const dir = await scratchWithAgents();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-home-'));
  const registry = path.join(home, '.deepseek-code', 'registry');
  const previousHome = process.env.DEEPSEEK_HOME;
  process.env.DEEPSEEK_HOME = home;
  try {
    await registerSession({ id: 'aaa11111-0001', name: 'calm-otter', title: 'writer', cwd: dir }, {}, registry);
    assert.equal((await resolveTarget(dir, 'calm-otter'))?.id, 'aaa11111-0001');
    assert.equal((await resolveTarget(dir, '@calm-otter'))?.id, 'aaa11111-0001');

    // A second session claiming the same name forces `#id` disambiguation.
    await registerSession({ id: 'bbb22222-0002', name: 'calm-otter', title: 'tester', cwd: dir }, {}, registry);
    const names = (await listReachableAgents(dir))
      .filter((agent) => agent.kind === 'session')
      .map((agent) => agent.name)
      .sort();
    assert.deepEqual(names, ['calm-otter#aaa111', 'calm-otter#bbb222']);

    assert.equal(await resolveTarget(dir, 'calm-otter'), null, 'an ambiguous stem resolves to nothing');
    assert.equal((await resolveTarget(dir, 'calm-otter#bbb222'))?.id, 'bbb22222-0002');
    assert.equal((await resolveTarget(dir, 'bbb222'))?.id, 'bbb22222-0002');
  } finally {
    if (previousHome === undefined) delete process.env.DEEPSEEK_HOME;
    else process.env.DEEPSEEK_HOME = previousHome;
  }
});


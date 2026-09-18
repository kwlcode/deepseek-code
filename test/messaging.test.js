/**
 * End-to-end messaging over the real wire: registry discovery, name resolution,
 * the socket handshake with its per-session token, and the inbox gate on the
 * receiving side. No model calls are involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listReachableAgents, resolveTarget, sendMessageTool } from '../src/tools/agents.js';
import { registerSession, generateToken } from '../src/registry.js';
import { createMessageServer, sendMessageTo, socketAddressFor } from '../src/transport.js';
import { createInbox } from '../src/inbox.js';

/** A session that listens on a socket and feeds an inbox, the way the REPL does. */
async function startLiveSession({ id, permissionMode = 'default' }) {
  const inbox = createInbox({ permissionMode });
  const token = generateToken();
  const server = createMessageServer({
    address: socketAddressFor(id),
    token,
    handler: async (request) => {
      const outcome = inbox.submit({ id: request.id, from: request.from, text: request.text });
      if (outcome.disposition === 'refused') {
        return { ok: false, disposition: 'refused', id: outcome.id, error: outcome.reason };
      }
      return { ok: true, disposition: outcome.disposition, id: outcome.id };
    },
  });
  const address = await server.start();
  return { inbox, server, address, token };
}

/** Isolate the registry in a scratch home so nothing touches the real one. */
async function withScratchHome(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-msg-'));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-msg-proj-'));
  const previous = process.env.DEEPSEEK_HOME;
  process.env.DEEPSEEK_HOME = home;
  try {
    return await fn({ home, cwd, registry: path.join(home, '.deepseek-code', 'registry') });
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_HOME;
    else process.env.DEEPSEEK_HOME = previous;
  }
}

const senderCtx = (cwd) => ({ cwd, session: { id: 'sender-1', name: 'bold-wren' } });

test('a message travels registry -> socket -> inbox and is acknowledged', async () => {
  await withScratchHome(async ({ cwd, registry }) => {
    const id = '20260101-aaa111';
    const receiver = await startLiveSession({ id });
    try {
      await registerSession(
        { id, name: 'calm-otter', title: 'writer', cwd },
        { socket: receiver.address, token: receiver.token },
        registry,
      );

      const discovered = await listReachableAgents(cwd);
      assert.ok(
        discovered.some((agent) => agent.kind === 'session' && agent.name === 'calm-otter'),
        'the live session is discoverable by name',
      );
      assert.equal((await resolveTarget(cwd, '@calm-otter'))?.id, id);

      const result = await sendMessageTool.run(
        { name: 'calm-otter', text: 'is the build green?' },
        senderCtx(cwd),
      );
      assert.equal(result.isError, undefined, JSON.stringify(result.meta));
      assert.match(result.output, /Delivered to @calm-otter/);
      assert.equal(result.meta.disposition, 'accepted');

      const delivered = receiver.inbox.next();
      assert.equal(delivered.text, 'is the build green?');
      assert.equal(delivered.from, 'bold-wren', 'the reply address travels with the message');
    } finally {
      await receiver.server.stop();
    }
  });
});

test('the token is required: a caller without it is rejected', async () => {
  await withScratchHome(async ({ cwd, registry }) => {
    const id = '20260101-bbb222';
    const receiver = await startLiveSession({ id });
    try {
      await registerSession(
        { id, name: 'calm-otter', title: 'writer', cwd },
        { socket: receiver.address, token: receiver.token },
        registry,
      );

      const target = await resolveTarget(cwd, 'calm-otter');
      const refused = await sendMessageTo(target.socket, { text: 'let me in', auth: 'not-the-token' });
      assert.equal(refused.ok, false);
      assert.equal(refused.error, 'unauthorized');
      assert.equal(receiver.inbox.size, 0, 'nothing reaches the inbox');
    } finally {
      await receiver.server.stop();
    }
  });
});

test('a bypassPermissions receiver holds the message instead of accepting it', async () => {
  await withScratchHome(async ({ cwd, registry }) => {
    const id = '20260101-ccc333';
    const receiver = await startLiveSession({ id, permissionMode: 'bypassPermissions' });
    try {
      await registerSession(
        { id, name: 'calm-otter', title: 'writer', cwd },
        { socket: receiver.address, token: receiver.token },
        registry,
      );

      const result = await sendMessageTool.run({ name: 'calm-otter', text: 'deploy it' }, senderCtx(cwd));
      assert.equal(result.meta.disposition, 'held');
      assert.match(result.output, /held the message/);
      assert.equal(receiver.inbox.size, 0, 'a held message is not readable yet');
      assert.equal(receiver.inbox.heldCount, 1);
    } finally {
      await receiver.server.stop();
    }
  });
});

test('a repeat of the same message is suppressed, not delivered twice', async () => {
  await withScratchHome(async ({ cwd, registry }) => {
    const id = '20260101-ddd444';
    const receiver = await startLiveSession({ id });
    try {
      await registerSession(
        { id, name: 'calm-otter', title: 'writer', cwd },
        { socket: receiver.address, token: receiver.token },
        registry,
      );

      const first = await sendMessageTo(receiver.address, { id: 'same-id', text: 'ping', auth: receiver.token });
      const second = await sendMessageTo(receiver.address, { id: 'same-id', text: 'ping', auth: receiver.token });

      assert.equal(first.disposition, 'accepted');
      assert.equal(second.disposition, 'duplicate');
      assert.equal(receiver.inbox.size, 1, 'only one copy was queued');
    } finally {
      await receiver.server.stop();
    }
  });
});


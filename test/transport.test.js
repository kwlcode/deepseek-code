/** Per-session socket transport: server answers, client receives. */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { createMessageServer, sendMessageTo, socketAddressFor, socketsDir, fallbackSocketDir } from '../src/transport.js';

function testAddress() {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\deepseek-code-${id}` : path.join(os.tmpdir(), `dsc-${id}.sock`);
}

test('a socket server answers one request per connection', async () => {
  const address = testAddress();
  const server = createMessageServer({
    address,
    handler: async (request) => ({ ok: true, text: `echo:${request.text}` }),
  });
  await server.start();
  try {
    const reply = await sendMessageTo(address, { text: 'hello' });
    assert.deepEqual(reply, { ok: true, text: 'echo:hello' });
  } finally {
    await server.stop();
  }
});

test('a throwing handler becomes an error reply', async () => {
  const address = testAddress();
  const server = createMessageServer({
    address,
    handler: async () => {
      throw new Error('boom');
    },
  });
  await server.start();
  try {
    const reply = await sendMessageTo(address, { text: 'x' });
    assert.deepEqual(reply, { ok: false, error: 'boom' });
  } finally {
    await server.stop();
  }
});

test('sendMessageTo rejects when nothing is listening', async () => {
  const address = testAddress();
  await assert.rejects(sendMessageTo(address, { text: 'x' }, { timeoutMs: 2000 }));
});

test('a token-protected server rejects a bad token and accepts the right one', async () => {
  const address = testAddress();
  const server = createMessageServer({ address, token: 'secret', handler: async () => ({ ok: true, text: 'hi' }) });
  await server.start();
  try {
    assert.deepEqual(await sendMessageTo(address, { text: 'x', auth: 'wrong' }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(await sendMessageTo(address, { text: 'x', auth: 'secret' }), { ok: true, text: 'hi' });
  } finally {
    await server.stop();
  }
});

test('socketAddressFor yields a namespace-scoped address', () => {
  const address = socketAddressFor('abc123');
  assert.ok(address.endsWith('deepseek-code-abc123'));
  if (process.platform !== 'win32') {
    assert.equal(address, path.join(socketsDir(), 'abc123.sock'));
  }
});

test('socketAddressFor falls back to /tmp when the home path is too long', () => {
  if (process.platform === 'win32') return; // named pipes have no path limit
  const previous = process.env.DEEPSEEK_HOME;
  try {
    process.env.DEEPSEEK_HOME = path.join('/very', 'deep', 'x'.repeat(140));
    const address = socketAddressFor('abc123');
    assert.ok(address.startsWith(fallbackSocketDir()), `used the /tmp fallback: ${address}`);
    assert.ok(address.endsWith('abc123.sock'));
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_HOME;
    else process.env.DEEPSEEK_HOME = previous;
  }
});

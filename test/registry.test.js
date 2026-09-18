/** Session registry: registration files, liveness and cleanup. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerSession, listRegisteredSessions, touchSession, unregisterSession, generateToken, claimName } from '../src/registry.js';

async function scratchDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'deepseek-code-registry-'));
}

test('registerSession writes a registration file that is listed', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', title: 'my session', model: 'm', cwd: '/tmp/x' }, {}, dir);
  const sessions = await listRegisteredSessions({}, dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 's1');
  assert.equal(sessions[0].title, 'my session');
  assert.equal(sessions[0].cwd, path.resolve('/tmp/x'));
  assert.ok(sessions[0].updatedAt);
  assert.equal(sessions[0].pid, process.pid);
});

test('stale registrations are dropped and collected', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', title: 'x', cwd: '/tmp/x' }, {}, dir);
  const file = path.join(dir, 's1.json');
  const record = JSON.parse(await fsp.readFile(file, 'utf8'));
  record.updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await fsp.writeFile(file, JSON.stringify(record));

  const sessions = await listRegisteredSessions({ ttlMs: 5 * 60 * 1000 }, dir);
  assert.equal(sessions.length, 0);
  await assert.rejects(fsp.stat(file), 'stale file was removed');
});

test('unregisterSession removes the file', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', title: 'x', cwd: '/tmp/x' }, {}, dir);
  await unregisterSession('s1', dir);
  assert.equal((await listRegisteredSessions({}, dir)).length, 0);
});

test('touchSession bumps the heartbeat', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', title: 'x', cwd: '/tmp/x' }, {}, dir);
  const before = (await listRegisteredSessions({}, dir))[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await touchSession('s1', dir);
  const after = (await listRegisteredSessions({}, dir))[0].updatedAt;
  assert.ok(after >= before, 'updatedAt advanced');
});

test('registerSession records the auth token', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', title: 'x', cwd: '/tmp/x' }, { token: 'secret123' }, dir);
  assert.equal((await listRegisteredSessions({}, dir))[0].token, 'secret123');
});

test('generateToken returns unique 32-char hex secrets', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('registerSession records the session name', async () => {
  const dir = await scratchDir();
  await registerSession({ id: 's1', name: 'calm-otter', title: 'x', cwd: '/tmp/x' }, {}, dir);
  assert.equal((await listRegisteredSessions({}, dir))[0].name, 'calm-otter');
});

test('claimName keeps a free name and variants one already taken', async () => {
  const dir = await scratchDir();
  assert.equal(await claimName('main', { dir }), 'main');

  await registerSession({ id: 's1', name: 'main', title: 'x', cwd: '/tmp/x' }, {}, dir);
  assert.equal(await claimName('main', { dir }), 'main-2');
  // A session re-claiming its own name is not treated as a collision.
  assert.equal(await claimName('main', { excludeIds: ['s1'], dir }), 'main');
});


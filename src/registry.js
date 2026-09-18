/**
 * Session registry: a directory of registration files on the local filesystem.
 *
 * Every session that supports messaging writes one file here while it is
 * alive, and touches it on a heartbeat. ListAgents/SendMessage read these
 * files to find live sessions instead of talking to any daemon. Because the
 * registry lives on the user's filesystem, two sessions can only see each
 * other when they share that filesystem — a container or WSL2 distro has its
 * own namespace and therefore its own registry.
 */

import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { uniqueName } from './names.js';

export function registryDir() {
  const base = process.env.DEEPSEEK_HOME || os.homedir();
  return path.join(base, '.deepseek-code', 'registry');
}

/** A registration older than this is considered dead and is collected. */
export const LIVE_TTL_MS = 5 * 60 * 1000;

export function registrationFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

/** A per-session secret proving a socket client can read this user's registry. */
export function generateToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Pick a name no other live session is using, so the first claimant keeps the
 * plain name and a newcomer gets `name-2`, `name-3`, and so on.
 */
export async function claimName(baseName, { excludeIds = [], dir = registryDir() } = {}) {
  const exclude = new Set(excludeIds.filter(Boolean));
  const live = await listRegisteredSessions({}, dir);
  const taken = live
    .filter((session) => !exclude.has(session.id))
    .map((session) => session.name)
    .filter(Boolean);
  return uniqueName(baseName, taken);
}

/** Write (or refresh) the registration record for a live session. */
export async function registerSession(session, meta = {}, dir = registryDir()) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
  const now = new Date().toISOString();
  const record = {
    id: session.id,
    title: session.title ?? 'untitled session',
    model: session.model ?? null,
    name: session.name ?? null,
    cwd: path.resolve(session.cwd),
    socket: meta.socket ?? null,
    token: meta.token ?? null,
    pid: process.pid,
    startedAt: meta.startedAt ?? now,
    updatedAt: now,
  };
  await fsp.writeFile(registrationFile(dir, session.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** Heartbeat: bump `updatedAt` so the session stays live. */
export async function touchSession(id, dir = registryDir()) {
  const file = registrationFile(dir, id);
  try {
    const record = JSON.parse(await fsp.readFile(file, 'utf8'));
    record.updatedAt = new Date().toISOString();
    await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    /* registration already gone */
  }
}

/** Remove a session's registration on clean exit. */
export async function unregisterSession(id, dir = registryDir()) {
  try {
    await fsp.unlink(registrationFile(dir, id));
  } catch {
    /* already gone */
  }
}

/**
 * Live sessions, newest first. Stale files (a session that died without
 * cleaning up) are removed as they are found.
 */
export async function listRegisteredSessions({ now = Date.now(), ttlMs = LIVE_TTL_MS } = {}, dir = registryDir()) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    try {
      const record = JSON.parse(await fsp.readFile(file, 'utf8'));
      const updatedAt = Date.parse(record.updatedAt ?? '');
      if (Number.isNaN(updatedAt) || now - updatedAt > ttlMs) {
        await fsp.unlink(file).catch(() => {});
        continue;
      }
      sessions.push({ ...record, updatedAt, file });
    } catch {
      /* skip unreadable records */
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

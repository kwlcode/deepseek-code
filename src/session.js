/**
 * Session transcripts.
 *
 * Layout mirrors Claude Code: one project directory per working directory,
 * keyed by a slug of the path, holding one JSON file per session. The
 * transcript is append-written after every step so `--resume` can pick a
 * session back up exactly where it stopped.
 */

import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { autoName, normalizeName } from './names.js';

export const PROJECTS_DIR = path.join(os.homedir(), '.deepseek-code', 'projects');

/** Filesystem-safe key for a working directory. */
export function slugFor(cwd) {
  return path.resolve(cwd).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export function projectDir(cwd) {
  return path.join(PROJECTS_DIR, slugFor(cwd));
}

export function newSessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function createSession({ cwd, model, permissionMode, title, name }) {
  const now = new Date().toISOString();
  return {
    id: newSessionId(),
    title: title ?? 'untitled session',
    name: normalizeName(name) ?? autoName(),
    cwd: path.resolve(cwd),
    model,
    permissionMode,
    createdAt: now,
    updatedAt: now,
    todos: [],
    messages: [],
    usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, total: 0, reasoning: 0, usd: 0, turns: 0 },
    file: null,
  };
}

/**
 * Write the transcript. Only shareable state is serialised: the messages that
 * actually went to the API, the todo list, and the running usage totals.
 */
export async function saveSession(session) {
  const directory = projectDir(session.cwd);
  await fsp.mkdir(directory, { recursive: true });
  const file = session.file ?? path.join(directory, `${session.id}.json`);
  session.file = file;
  session.updatedAt = new Date().toISOString();

  const payload = {
    id: session.id,
    title: session.title,
    name: session.name ?? null,
    cwd: session.cwd,
    model: session.model,
    permissionMode: session.permissionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    todos: session.todos ?? [],
    usage: session.usage ?? {},
    messages: session.messages,
  };
  await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/** Sessions for a working directory, newest first. */
export async function listSessions(cwd, limit = 20) {
  const directory = projectDir(cwd);
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(directory, entry);
    try {
      const stat = await fsp.stat(file);
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      sessions.push({
        id: parsed.id ?? entry.replace(/\.json$/, ''),
        title: parsed.title ?? 'untitled session',
        name: parsed.name ?? null,
        updatedAt: parsed.updatedAt ?? stat.mtime.toISOString(),
        model: parsed.model,
        turns: parsed.usage?.turns ?? 0,
        file,
      });
    } catch {
      /* skip unreadable transcripts */
    }
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return sessions.slice(0, limit);
}

/** Load a session by id, or the most recent one when id is omitted. */
export async function loadSession(cwd, id) {
  const sessions = await listSessions(cwd, 100);
  const match = id ? sessions.find((entry) => entry.id === id) ?? sessions.find((entry) => entry.id.startsWith(id)) : sessions[0];
  if (!match) return null;
  const parsed = JSON.parse(await fsp.readFile(match.file, 'utf8'));
  return { ...parsed, file: match.file, todos: parsed.todos ?? [] };
}

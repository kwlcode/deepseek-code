/**
 * Per-session socket transport for agent-to-agent messaging.
 *
 * Discovery is files on disk (registry.js); delivery is a point-to-point socket
 * owned by each live session — no message bus, no daemon. A session listens on
 * a socket whose address is recorded in its registration file. SendMessage
 * connects to that address, sends one newline-delimited JSON request, and reads
 * one reply. The address lives in the same filesystem/namespace as the registry,
 * so two sessions can only talk when they can already see each other.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function socketsDir() {
  const base = process.env.DEEPSEEK_HOME || os.homedir();
  return path.join(base, '.deepseek-code', 'sockets');
}

/** Unix domain socket paths are limited to about this many bytes. */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 104 : 108;

/**
 * uid-scoped directory under /tmp, used when the home socket dir is unusable
 * (path too long, or a filesystem that cannot host Unix sockets). Scoped to the
 * uid and forced to mode 0700 so another user cannot squat the name in a
 * world-writable /tmp.
 */
export function fallbackSocketDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join('/tmp', `cc-socks-${uid}`);
}

/** The socket address a session with `id` listens on. */
export function socketAddressFor(id) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\deepseek-code-${id}`;
  const primary = path.join(socketsDir(), `${id}.sock`);
  if (Buffer.byteLength(primary) >= SOCKET_PATH_MAX) return path.join(fallbackSocketDir(), `${id}.sock`);
  return primary;
}

async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`refusing to use a symlinked socket directory: ${dir}`);
  await fsp.chmod(dir, 0o700).catch(() => {});
}

/**
 * A socket server answering one message per connection. `handler(request)`
 * returns a reply object (or throws, which becomes `{ ok: false, error }`).
 */
export function createMessageServer({ address, handler, token }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');

    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1 || handled) return;
      handled = true;
      const line = buffer.slice(0, index);

      (async () => {
        let reply;
        let request;
        try {
          request = JSON.parse(line || '{}');
        } catch {
          request = {};
        }
        if (token && request.auth !== token) {
          reply = { ok: false, error: 'unauthorized' };
        } else {
          try {
            reply = await handler(request);
          } catch (error) {
            reply = { ok: false, error: error?.message ?? String(error) };
          }
        }
        if (socket.destroyed) return;
        socket.write(`${JSON.stringify(reply)}\n`);
        socket.end();
      })();
    });
  });

  let boundAddress = address;

  const listenOn = (addr) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(addr, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

  const prepareDir = async (addr) => {
    await ensurePrivateDir(path.dirname(addr));
    await fsp.unlink(addr).catch(() => {});
  };

  return {
    address,
    get boundAddress() {
      return boundAddress;
    },
    async start() {
      if (process.platform === 'win32') {
        await listenOn(address);
        boundAddress = address;
        return boundAddress;
      }
      await prepareDir(address);
      try {
        await listenOn(address);
        boundAddress = address;
      } catch {
        // The normal dir cannot host a Unix socket (e.g. unsupported filesystem).
        const fallback = path.join(fallbackSocketDir(), path.basename(address));
        await prepareDir(fallback);
        await listenOn(fallback);
        boundAddress = fallback;
      }
      return boundAddress;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== 'win32') await fsp.unlink(boundAddress).catch(() => {});
    },
  };
}

/** Connect to a session's socket, send a request, resolve with the reply. */
export function sendMessageTo(address, request, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    socket.setEncoding('utf8');
    // Every message carries an id so the receiver can suppress exact repeats.
    const payload = { id: request?.id ?? randomBytes(8).toString('hex'), ...request };
    let buffer = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('timed out waiting for a reply')), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        const line = buffer.slice(0, index);
        try {
          finish(null, JSON.parse(line));
        } catch {
          finish(new Error('invalid reply from the target session'));
        }
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('the target session closed the connection before replying'));
    });
  });
}

/**
 * Agent-to-agent messaging: ListAgents and SendMessage.
 *
 * These mirror the two internal orchestration tools Claude Code uses to drive
 * multi-agent work — the model calls them itself, the user never types them.
 *
 *   ListAgents   discover who is reachable right now
 *   SendMessage  deliver plain text to one target by name and return its reply
 *
 * Subagents resolve from `.claude/agents` (plus `.deepseek-code/agents` and
 * `~/.claude/agents`); live sessions resolve from the registry of registration
 * files that every running session writes. Team, cloud and remote-control
 * channels have no transport here yet, so they are reported as unavailable.
 */

import { listAgentDefinitions } from './task.js';
import { listRegisteredSessions } from '../registry.js';
import { sendMessageTo } from '../transport.js';

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Every agent reachable from `cwd`, subagents first, then local sessions. */
export async function listReachableAgents(cwd) {
  const agents = [];

  for (const definition of await listAgentDefinitions(cwd)) {
    agents.push({
      name: definition.name,
      kind: 'subagent',
      title: definition.title,
      description: definition.description,
      model: definition.model,
      definition,
    });
  }

  for (const session of await listRegisteredSessions()) {
    if (!session.id) continue;
    agents.push({
      name: session.name ?? session.id,
      kind: 'session',
      title: session.title ?? 'untitled session',
      model: session.model,
      id: session.id,
      cwd: session.cwd,
      socket: session.socket,
      token: session.token,
    });
  }

  return disambiguate(agents);
}

/**
 * Two live sessions can still share a name — a registration race, or machines
 * writing to the same shared home. Suffix each colliding entry with a short id
 * so every one of them stays separately addressable from ListAgents.
 */
function disambiguate(agents) {
  const counts = new Map();
  for (const agent of agents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
  for (const agent of agents) {
    if (counts.get(agent.name) > 1) {
      agent.name = `${agent.name}#${agent.id ? agent.id.slice(0, 6) : 'dup'}`;
    }
  }
  return agents;
}

/**
 * Resolve a target: a subagent stem, a session name, a session id (or unique id
 * prefix), a title slug, or an `name#id` address handed out by ListAgents.
 */
export async function resolveTarget(cwd, name) {
  const normalized = String(name ?? '').trim().replace(/^@/, '');
  if (!normalized) return null;

  const hash = normalized.indexOf('#');
  const base = hash === -1 ? normalized : normalized.slice(0, hash);
  const idHint = hash === -1 ? null : normalized.slice(hash + 1);
  const agents = await listReachableAgents(cwd);
  const sessions = agents.filter((agent) => agent.kind === 'session');

  if (idHint) {
    const hinted = sessions.find((agent) => agent.id?.startsWith(idHint));
    if (hinted) return hinted;
  }

  const exact = agents.find((agent) => agent.name === base);
  if (exact) return exact;

  // A disambiguated entry keeps its stem in the address, so `name` still works
  // as long as only one session answers to it.
  const byStem = sessions.filter((agent) => agent.name.startsWith(`${base}#`));
  if (byStem.length === 1) return byStem[0];

  const byId = sessions.filter((agent) => agent.id?.startsWith(base));
  if (byId.length === 1) return byId[0];

  const bySlug = sessions.filter((agent) => slugify(agent.title) === slugify(base));
  if (bySlug.length === 1) return bySlug[0];
  return null;
}

function formatAgentList(agents) {
  const lines = agents.map((agent) => {
    if (agent.kind === 'subagent') {
      const detail = agent.description ? ` \u2014 ${agent.description}` : '';
      return `- @${agent.name} (subagent)${detail}`;
    }
    const model = agent.model ? ` (${agent.model})` : '';
    return `- @${agent.name} (session) \u2014 "${agent.title ?? 'untitled'}"${model}`;
  });
  return `Reachable agents (${agents.length}):\n${lines.join('\n')}`;
}

export const listAgentsTool = {
  name: 'ListAgents',
  description:
    'Discover the agents reachable right now: subagents defined in .claude/agents (also .deepseek-code/agents ' +
    'and ~/.claude/agents), and other live sessions on this machine. Address one as @name; if two sessions share ' +
    'a name it is listed as @name#id, and that exact address works with SendMessage. Call this before SendMessage ' +
    'so you address a real target. Team, cloud and remote agents appear here once those transports exist.',
  readOnly: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  async run(input, ctx) {
    const agents = await listReachableAgents(ctx.cwd);
    if (!agents.length) return { output: 'No other agents reachable from this session.' };
    return { output: formatAgentList(agents), meta: { count: agents.length } };
  },
};

export const sendMessageTool = {
  name: 'SendMessage',
  description:
    'Deliver plain text to one agent by name and return a delivery acknowledgement. Targets are those reported ' +
    'by ListAgents: a subagent (@<name>), which answers inline, or another live session (@<name>, @<id>, or the ' +
    '@<name>#<id> form shown when names collide), which reads the message between tool calls or as its next turn ' +
    'and replies later as an incoming message. The message carries no files and no history.',
  readOnly: false,
  // Like Task: the subagent/session inherits this session's permission mode, so
  // sending a message can never escalate what the user has already allowed.
  planModeSafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Target agent name, with or without a leading @.' },
      text: { type: 'string', description: 'Plain-text message to deliver.' },
    },
    required: ['name', 'text'],
  },
  async run(input, ctx) {
    const name = String(input.name ?? '').trim().replace(/^@/, '');
    const text = String(input.text ?? '');
    if (!name) return { isError: true, output: 'SendMessage needs a target name.' };
    if (!text) return { isError: true, output: 'SendMessage needs message text.' };

    const target = await resolveTarget(ctx.cwd, name);
    if (!target) {
      return {
        isError: true,
        output: `No reachable agent named "@${name}". Run ListAgents to see what is available.`,
      };
    }

    if (target.kind === 'subagent') {
      if (typeof ctx.spawnSubagent !== 'function') {
        return { isError: true, output: 'Subagents are not available in this session.' };
      }
      const result = await ctx.spawnSubagent({ description: target.name, prompt: text, definition: target.definition });
      return {
        output: result.text || '(the subagent produced no reply)',
        meta: { agent: target.name, kind: 'subagent', steps: result.steps },
      };
    }

    if (target.kind === 'session') {
      if (!target.socket) {
        return { isError: true, output: `Session "@${target.name}" has no socket (it may not support messaging).` };
      }
      const ack = await sendMessageTo(target.socket, {
        text,
        from: ctx.session?.name ?? ctx.session?.id ?? null,
        reply_to: ctx.session?.name ?? ctx.session?.id ?? null,
        auth: target.token,
      });
      if (!ack?.ok) {
        return { isError: true, output: `@${target.name} refused the message: ${ack?.error ?? 'no reply'}` };
      }
      const disposition = ack.disposition ?? 'accepted';
      const note =
        disposition === 'held'
          ? `@${target.name} held the message for its user to approve.`
          : disposition === 'duplicate'
            ? `@${target.name} already had that message, so the repeat was suppressed.`
            : `Delivered to @${target.name}; it is read between tool calls, or as its next turn when idle.`;
      return {
        output: `${note} Any reply arrives later as an incoming message in this session.`,
        meta: { session: target.id, name: target.name, disposition },
      };
    }

    return { isError: true, output: `Cannot message ${target.kind} agents yet.` };
  },
};

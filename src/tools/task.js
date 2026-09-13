/**
 * Task tool: run a focused subagent in its own context window.
 *
 * The subagent gets a fresh message history, its own system prompt (from
 * `.claude/agents/<type>.md` when that file exists) and every tool except Task
 * itself, so it cannot recurse. It inherits the session's permission mode, so a
 * subagent can never escalate what the user has allowed.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontMatter } from '../frontmatter.js';

const AGENT_DIRECTORIES = ['.claude/agents', '.deepseek-code/agents'];

/** Look up a subagent definition by type, e.g. "code-reviewer". */
export async function loadAgentDefinition(cwd, type) {
  if (!type) return null;
  const candidates = [
    ...AGENT_DIRECTORIES.map((dir) => path.join(cwd, dir, `${type}.md`)),
    path.join(os.homedir(), '.claude', 'agents', `${type}.md`),
    path.join(os.homedir(), '.deepseek-code', 'agents', `${type}.md`),
  ];
  for (const file of candidates) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const { data, body } = parseFrontMatter(raw);
      return {
        file,
        name: data.name ?? type,
        description: data.description ?? '',
        tools: Array.isArray(data.tools) ? data.tools : null,
        model: typeof data.model === 'string' ? data.model : null,
        systemPrompt: body.trim(),
      };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export const taskTool = {
  name: 'Task',
  description:
    'Launch a subagent that works in its own context window and reports back a single final ' +
    'message. Use it for open-ended research ("where is X handled?") or for reviewing a change ' +
    'you just made, so the exploration does not fill your own context. The subagent has the same ' +
    'tools and permission mode as you. Give it a self-contained prompt: it cannot see this ' +
    'conversation.',
  readOnly: false,
  // A subagent inherits this session's permission mode, so running one is safe
  // in plan mode: it can research, but its own writes are still refused.
  planModeSafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-5 word) description of the task.' },
      prompt: { type: 'string', description: 'The full, self-contained task for the subagent.' },
      subagent_type: {
        type: 'string',
        description: 'Definition to use from .claude/agents/<type>.md. Use "general-purpose" for a default agent.',
      },
    },
    required: ['description', 'prompt'],
  },
  async run(input, ctx) {
    if (typeof ctx.spawnSubagent !== 'function') {
      return { isError: true, output: 'Subagents are not available in this session.' };
    }
    const definition = await loadAgentDefinition(ctx.cwd, input.subagent_type);
    try {
      const result = await ctx.spawnSubagent({
        description: input.description,
        prompt: input.prompt,
        definition,
      });
      const header = `Subagent "${input.description ?? input.subagent_type ?? 'general-purpose'}" finished after ${result.steps} step(s).`;
      return {
        output: `${header}\n\n${result.text || '(the subagent produced no final message)'}`,
        meta: { steps: result.steps, agent: definition?.name ?? input.subagent_type ?? 'general-purpose' },
      };
    } catch (error) {
      return { isError: true, output: `Subagent failed: ${error.message}` };
    }
  },
};

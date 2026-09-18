/**
 * Tool registry.
 *
 * Names match Claude Code (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
 * `TodoWrite`, `Task`, `WebFetch`, `PowerShell`) so permission rules and
 * `allowed-tools` front-matter written for Claude Code apply unchanged.
 */

import { readTool, writeTool, editTool, globTool } from './fs.js';
import { grepTool } from './search.js';
import { bashTool, powershellTool } from './shell.js';
import { todoTool, webFetchTool } from './misc.js';
import { taskTool } from './task.js';
import { listAgentsTool, sendMessageTool } from './agents.js';

/** Every tool the CLI can offer. */
export function allTools() {
  const tools = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
  ];
  if (process.platform === 'win32') tools.push(powershellTool);
  tools.push(todoTool, webFetchTool, taskTool, listAgentsTool, sendMessageTool);
  return tools;
}

/** Build the name -> tool map for a session. */
export function buildRegistry(config, options = {}) {
  const disabled = new Set(options.disabled ?? config.disabledTools ?? []);
  let tools = allTools().filter((tool) => !disabled.has(tool.name));

  if (Array.isArray(options.only) && options.only.length) {
    const wanted = new Set(options.only.flatMap((name) => name.split(',').map((part) => part.trim())));
    tools = tools.filter((tool) => wanted.has(tool.name));
  }
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Names of tools that cannot change anything on disk. */
export function readOnlyToolNames(registry) {
  return [...registry.values()].filter((tool) => tool.readOnly).map((tool) => tool.name);
}

/** Convert the registry into the `tools` array DeepSeek expects. */
export function toolSpecs(registry) {
  return [...registry.values()].map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Restrict a registry to an explicit list of tool names. */
export function restrictRegistry(registry, allowedNames) {
  if (!Array.isArray(allowedNames) || !allowedNames.length) return registry;
  const allowed = new Set(allowedNames);
  const restricted = new Map();
  for (const [name, tool] of registry) {
    if (allowed.has(name)) restricted.set(name, tool);
  }
  return restricted;
}

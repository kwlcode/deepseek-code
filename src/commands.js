/**
 * Slash commands, including custom commands from `.claude/commands/*.md`.
 *
 * A command file is markdown with optional YAML front matter:
 *
 *   ---
 *   description: Review the current diff
 *   argument-hint: [path]
 *   allowed-tools: ["Read", "Grep", "Bash(git diff:*)"]
 *   model: deepseek-flash
 *   ---
 *   Review these files and report problems: $ARGUMENTS
 *
 * Nested directories namespace the command, so `.claude/commands/db/migrate.md`
 * becomes `/db:migrate`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatter, expandArguments } from './frontmatter.js';

export const BUILTIN_HELP = [
  ['/help', 'Show this help'],
  ['/init', 'Create a CLAUDE.md describing this project'],
  ['/memory', 'Show the memory files that are loaded'],
  ['/status', 'Show session, model and token usage'],
  ['/cost', 'Show token usage and estimated cost'],
  ['/todos', 'Show the current task list'],
  ['/model [name]', 'Show or switch the model'],
  ['/mode [mode]', 'Show or switch the permission mode'],
  ['/compact', 'Summarise the conversation to free context'],
  ['/clear', 'Start a fresh conversation'],
  ['/resume', 'List and resume an earlier session in this directory'],
  ['/exit', 'Quit (also Ctrl+D)'],
];

/** Walk a commands directory, including one level of namespacing per subdir. */
async function readCommandFiles(root, prefix, collected) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await readCommandFiles(full, `${prefix}${entry.name}:`, collected);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const name = `${prefix}${entry.name.replace(/\.md$/, '')}`;
      try {
        const raw = await fsp.readFile(full, 'utf8');
        const { data, body } = parseFrontMatter(raw);
        collected.set(name, {
          name,
          description: typeof data.description === 'string' ? data.description : '',
          argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : data.argumentHint ?? '',
          allowedTools: Array.isArray(data['allowed-tools'])
            ? data['allowed-tools']
            : Array.isArray(data.allowedTools)
              ? data.allowedTools
              : null,
          model: typeof data.model === 'string' ? data.model : null,
          body: body.trim(),
          file: full,
        });
      } catch {
        /* skip unreadable command */
      }
    }
  }
}

/** Load project-level custom commands from `.claude/commands` and its twin. */
export async function loadCommands(cwd) {
  const commands = new Map();
  await readCommandFiles(path.join(cwd, '.claude', 'commands'), '', commands);
  await readCommandFiles(path.join(cwd, '.deepseek-code', 'commands'), '', commands);
  return commands;
}

/** Expand a command into the prompt text handed to the model. */
export function renderCommand(command, argumentString) {
  const expanded = expandArguments(command.body, argumentString).trim();
  const parts = [];
  if (command.allowedTools?.length) {
    parts.push(`[Restrict this turn to these tools: ${command.allowedTools.join(', ')}]`);
  }
  parts.push(expanded || 'Follow the instructions in this command.');
  return parts.join('\n\n');
}

export function describeCommands(commands) {
  const custom = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    'Built-in commands:',
    ...BUILTIN_HELP.map(([name, description]) => `  ${name.padEnd(18)} ${description}`),
  ];
  if (custom.length) {
    lines.push('', 'Custom commands:');
    for (const command of custom) {
      lines.push(`  /${command.name.padEnd(17)} ${command.description || '(no description)'}`);
    }
  }
  return lines.join('\n');
}

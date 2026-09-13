/**
 * System prompt assembly.
 *
 * The shape mirrors Claude Code: an identity block, environment details, a
 * project-memory section built from CLAUDE.md / AGENTS.md, then the tool-use
 * and task-execution policies. Memory files may pull in other files with
 * `@relative/path` lines, which is how Claude Code imports extra context.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MEMORY_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md'];
const IMPORT_PATTERN = /^\s*@([^\s*]+)\s*$/gm;
const MAX_IMPORT_DEPTH = 5;
const MAX_MEMORY_CHARS = 40_000;

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Expand `@path` imports inside one memory file. */
function expandImports(text, baseDirectory, depth, visited) {
  if (depth > MAX_IMPORT_DEPTH) return text;
  return text.replace(IMPORT_PATTERN, (match, target) => {
    const resolved = path.isAbsolute(target) ? target : path.resolve(baseDirectory, target);
    if (visited.has(resolved)) return match;
    visited.add(resolved);
    const content = readIfPresent(resolved);
    if (content === null) return match;
    return expandImports(content, path.dirname(resolved), depth + 1, visited);
  });
}

/**
 * Collect project and user memory files, in Claude Code's precedence order:
 * enterprise/user level first, then walking up from cwd, then the local file.
 */
export function loadMemoryFiles(cwd) {
  const found = [];
  const visited = new Set();

  const candidates = [
    { file: path.join(os.homedir(), '.claude', 'CLAUDE.md'), scope: 'user' },
    { file: path.join(os.homedir(), '.deepseek-code', 'CLAUDE.md'), scope: 'user' },
  ];

  // Every directory from the filesystem root down to cwd, so nested projects
  // pick up the guidance written at any level above them.
  let directory = path.resolve(cwd);
  const chain = [];
  while (true) {
    chain.unshift(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const level of chain) {
    for (const name of MEMORY_FILENAMES) {
      candidates.push({ file: path.join(level, name), scope: level === cwd ? 'project' : 'parent' });
    }
  }

  for (const candidate of candidates) {
    if (visited.has(candidate.file)) continue;
    const raw = readIfPresent(candidate.file);
    if (raw === null || raw.trim() === '') continue;
    visited.add(candidate.file);
    const expanded = expandImports(raw.trim(), path.dirname(candidate.file), 0, visited);
    found.push({ ...candidate, text: expanded });
  }
  return found;
}

export function formatMemory(files) {
  if (!files.length) return '';
  const sections = files.map((entry) => `### ${entry.file} (${entry.scope})\n\n${entry.text}`);
  return `# Project memory\n\nThe files below are user-authored context. Follow them as if the user had typed them, but the system prompt wins when they disagree.\n\n${sections.join('\n\n')}`;
}

export function environmentBlock({ config, cwd }) {
  const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const platform = platformNames[process.platform] ?? process.platform;
  const shell = platform === 'Windows'
    ? 'PowerShell (use the PowerShell tool for Windows-specific commands; Bash is available when Git Bash is installed)'
    : process.env.SHELL || '/bin/sh';

  const lines = [
    `- Working directory: ${cwd}`,
    `- Platform: ${platform} (${process.arch})`,
    `- Shell: ${shell}`,
    `- Node: ${process.version}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Model: ${config.model} (thinking ${config.thinking ? 'on' : 'off'}, effort ${config.effort})`,
    `- Permission mode: ${config.permissionMode}`,
  ];

  return lines.join('\n');
}

/** The tool-use, tone and safety policies sent on every request. */
function policyBlock({ config, tools }) {
  const toolNames = tools.map((tool) => tool.name).join(', ');
  const canEdit = tools.some((tool) => tool.name === 'Edit' || tool.name === 'Write');
  const planMode = config.permissionMode === 'plan';

  const sections = [
    `# Tone

Answer concisely and directly: the user is a working engineer, not an audience. Do not open with "Great question" or similar filler, do not restate the request, and do not close with a summary of what you just said. Match the length of your answer to the complexity of the task. When you reference a file or a function, use \`path/to/file.ext:line\` so the user can jump to it. Use GitHub-flavoured markdown; the terminal renders headings, lists, tables and fenced code blocks.`,

    `# Tools

Available tools: ${toolNames}.

Prefer a dedicated tool over a shell command: Read instead of \`cat\`, Glob instead of \`find\`, Grep instead of \`grep\`/\`rg\`, Edit instead of \`sed\`/\`awk\`. Use Bash and PowerShell for git, package managers, builds and tests. Call several independent tools in one response instead of one per turn. Batch independent work: read the files you already know you need before deciding what to do next.

File paths must be absolute or relative to the working directory.`,
  ];

  if (canEdit) {
    sections.push(`# Making changes

Read a file before you edit it, never guess at its contents. Old text in an Edit must match the file exactly, including whitespace and indentation. If an edit fails, re-read the file and retry rather than retrying the same string. Prefer several small, surgical edits over one large rewrite, and never rewrite a file you have not read. Do not add comments that restate the code, do not add error handling for cases that cannot happen, and do not refactor code the user did not ask you to touch. Match the surrounding style and reuse the helpers that already exist in the repository.

If a task needs three or more steps, or the user gave you several items, track it with TodoWrite and keep exactly one item in_progress.`);
  }

  if (!planMode) {
    sections.push(`# Executing actions with care

Approval prompts exist to stop destructive or hard-to-reverse actions, not routine work. Treat these as needing explicit confirmation first: \`rm -rf\`, \`git reset --hard\`, \`git checkout -- .\`, \`git clean -fd\`, \`git push --force\`, force-pushing to a shared branch, dropping database tables, overwriting uncommitted work, pushing a commit, amending a commit, or changing CI secrets. Committing is fine when the user asked for it; never commit, amend or push on your own initiative.

Report faithfully: if a command failed, say so and show the output; never claim a test passed when it did not, and never invent output you did not see.`);
  }

  sections.push(`# Asking questions

Ask the user when a decision is genuinely ambiguous and getting it wrong would waste real work. Do not ask about things you can determine by reading the code or the docs, and do not stop mid-task to check in when you already know the next step.`);

  if (planMode) {
    sections.push(`# Plan mode

You are in plan mode: read-only tools are available and anything that changes state is refused. Research the codebase until you can be specific, then present a plan with the exact files and functions you intend to change, and wait for approval before starting. Do not ask the user to approve anything you cannot first justify from what you read.`);
  }

  return sections.join('\n\n');
}

/** Assemble the complete system prompt for a session. */
export function buildSystemPrompt({ config, tools, cwd, customPrompt, memoryFiles }) {
  const identity = `You are deepseek-code, an agentic coding assistant running in the user's terminal. You help with software engineering: reading and writing code, running commands, debugging, and explaining how a codebase works. You have a full tool suite and you act on the user's machine, so you are careful and honest about what you did.`;

  const parts = [identity, environmentBlock({ config, cwd }), policyBlock({ config, tools })];

  const memory = formatMemory(memoryFiles ?? loadMemoryFiles(cwd));
  if (memory) parts.push(memory);
  if (customPrompt) parts.push(`# Additional instructions\n\n${customPrompt}`);

  const prompt = parts.join('\n\n');
  if (prompt.length > MAX_MEMORY_CHARS * 4) {
    return `${prompt.slice(0, MAX_MEMORY_CHARS * 4)}\n\n[system prompt truncated]`;
  }
  return prompt;
}

/** Short title for a transcript, derived from the first user message. */
export function titleFor(text) {
  const firstLine = String(text ?? '').trim().split('\n')[0];
  const cleaned = firstLine.replace(/\s+/g, ' ').slice(0, 60);
  return cleaned || 'untitled session';
}


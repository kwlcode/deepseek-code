/**
 * Permission engine.
 *
 * Rule syntax is Claude Code's:
 *   Read                 every use of Read
 *   Edit(/src/**)        Edit on paths matching a glob
 *   Bash(git commit:*)   Bash commands starting with "git commit"
 *   WebFetch(domain:x.com)
 *
 * Modes:
 *   plan               read-only tools only; anything that changes state is refused
 *   default            read-only auto-allowed, everything else asks
 *   acceptEdits        file edits auto-allowed, shell and the rest ask
 *   bypassPermissions  everything allowed (--dangerously-skip-permissions)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { unifiedDiff } from './diff.js';
import { resolveToolPath, matchesGlob, applyEdits } from './tools/fs.js';

const EDIT_TOOLS = new Set(['Edit', 'Write']);
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write']);
const PATTERN_TOOLS = new Set(['Glob', 'Grep']);

const RULE_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\((.*)\))?$/s;

export function parseRule(rule) {
  if (rule && typeof rule === 'object') return rule;
  const match = RULE_PATTERN.exec(String(rule ?? '').trim());
  if (!match) return null;
  return {
    tool: match[1],
    specifier: match[2] === undefined ? null : match[2].trim(),
    raw: String(rule).trim(),
  };
}

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/** The string a rule specifier is compared against for this tool call. */
export function ruleSubject(toolName, input, cwd) {
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(input.command ?? '');
  if (PATH_TOOLS.has(toolName) && input.file_path) {
    const absolute = resolveToolPath(input.file_path, cwd);
    const relative = toPosix(path.relative(cwd, absolute));
    return relative.startsWith('..') ? toPosix(absolute) : relative;
  }
  if (PATTERN_TOOLS.has(toolName)) return String(input.pattern ?? '');
  if (toolName === 'WebFetch') return String(input.url ?? '');
  return null;
}

/** Does a single rule match this tool call? */
export function ruleMatches(rule, toolName, input, cwd) {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.specifier === null) return true;

  const subject = ruleSubject(toolName, input, cwd);
  if (subject === null) return false;

  const specifier = parsed.specifier;
  if (specifier.startsWith('domain:')) {
    try {
      return new URL(subject).hostname.endsWith(specifier.slice('domain:'.length));
    } catch {
      return false;
    }
  }
  if (specifier.endsWith(':*')) return subject.startsWith(specifier.slice(0, -2));
  if (/[*?[\]]/.test(specifier)) {
    return matchesGlob(subject, specifier) || matchesGlob(toPosix(subject), specifier);
  }
  return subject === specifier || toPosix(subject).endsWith(`/${specifier}`);
}

/** Human-readable one-liner for the permission prompt and the transcript. */
export function describeCall(toolName, input) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return `${toolName}: ${String(input.command ?? '').split('\n')[0].slice(0, 200)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${toolName} ${input.file_path}`;
    case 'Glob':
    case 'Grep':
      return `${toolName} ${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'WebFetch':
      return `WebFetch ${input.url}`;
    case 'Task':
      return `Task (${input.subagent_type ?? 'general-purpose'}): ${input.description ?? ''}`;
    case 'TodoWrite':
      return `TodoWrite ${(input.todos ?? []).length} task(s)`;
    default:
      return toolName;
  }
}

/** Build a diff preview for Edit/Write so the user can approve knowingly. */
export async function previewFor(toolName, input, cwd) {
  const clip = (text) => text.split('\n').slice(0, 60).join('\n');
  try {
    if (toolName === 'Write') {
      const target = resolveToolPath(input.file_path, cwd);
      let previous = '';
      try {
        previous = await fsp.readFile(target, 'utf8');
      } catch {
        previous = '';
      }
      const diff = unifiedDiff(previous, String(input.content ?? ''), {
        oldLabel: `${input.file_path} (on disk)`,
        newLabel: `${input.file_path} (new)`,
        context: 2,
      });
      return clip(diff.text);
    }
    if (toolName === 'Edit') {
      const target = resolveToolPath(input.file_path, cwd);
      const original = await fsp.readFile(target, 'utf8');
      const edits = Array.isArray(input.edits) && input.edits.length
        ? input.edits
        : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
      const diff = unifiedDiff(original, applyEdits(original, edits), {
        oldLabel: input.file_path,
        newLabel: input.file_path,
        context: 2,
      });
      return clip(diff.text);
    }
  } catch (error) {
    return `(preview unavailable: ${error.message})`;
  }
  return '';
}

export class PermissionEngine {
  /**
   * @param {{mode: string, allow?: string[], deny?: string[], cwd: string,
   *          ask?: (request: object) => Promise<string>, nonInteractive?: boolean,
   *          onNotice?: (message: string) => void,
   *          rememberRule?: (rule: string) => void}} options
   */
  constructor(options) {
    this.mode = options.mode ?? 'default';
    this.allow = [...(options.allow ?? [])];
    this.deny = [...(options.deny ?? [])];
    this.cwd = options.cwd;
    this.ask = options.ask ?? null;
    this.nonInteractive = Boolean(options.nonInteractive);
    this.onNotice = options.onNotice ?? (() => {});
    this.rememberRule = options.rememberRule ?? (() => {});
  }

  setMode(mode) {
    this.mode = mode;
  }

  addAllowRule(rule) {
    if (!this.allow.includes(rule)) this.allow.push(rule);
  }

  /** Decide without prompting. */
  evaluate(tool, input) {
    const name = tool.name;

    for (const rule of this.deny) {
      if (ruleMatches(rule, name, input, this.cwd)) {
        return { behavior: 'deny', rule, reason: `denied by rule ${rule}` };
      }
    }
    for (const rule of this.allow) {
      if (ruleMatches(rule, name, input, this.cwd)) {
        return { behavior: 'allow', rule, reason: `allowed by rule ${rule}` };
      }
    }

    if (this.mode === 'bypassPermissions') {
      return { behavior: 'allow', reason: 'bypassPermissions mode' };
    }
    if (name === 'TodoWrite' || (tool.readOnly && name !== 'Task')) {
      return { behavior: 'allow', reason: 'read-only tool' };
    }
    if (this.mode === 'plan') {
      if (tool.planModeSafe) return { behavior: 'allow', reason: 'allowed in plan mode' };
      return {
        behavior: 'deny',
        reason:
          'plan mode is read-only. Keep researching with read-only tools, then present a plan and ' +
          'ask the user to approve it before editing files or running commands.',
      };
    }
    if (this.mode === 'acceptEdits' && EDIT_TOOLS.has(name)) {
      return { behavior: 'allow', reason: 'acceptEdits mode' };
    }
    if (this.nonInteractive || !this.ask) {
      return { behavior: 'deny', reason: 'no interactive prompt is available in this session' };
    }
    return { behavior: 'ask', reason: 'requires approval' };
  }

  /** Decide, prompting the user when the mode calls for it. */
  async request(tool, input) {
    const decision = this.evaluate(tool, input);
    if (decision.behavior !== 'ask') return decision;

    const answer = await this.ask({ tool, input, decision, summary: describeCall(tool.name, input) });
    if (answer === 'allow') return { behavior: 'allow', reason: 'approved by user' };
    if (answer === 'allow-always') {
      const rule = ruleFor(tool.name, input, this.cwd);
      this.addAllowRule(rule);
      this.rememberRule(rule);
      this.onNotice(`Saved allow rule: ${rule}`);
      return { behavior: 'allow', reason: `approved by user (${rule} saved)` };
    }
    if (answer === 'deny-always') {
      const rule = ruleFor(tool.name, input, this.cwd);
      if (!this.deny.includes(rule)) this.deny.push(rule);
      this.onNotice(`Saved deny rule: ${rule}`);
    }
    return { behavior: 'deny', reason: 'denied by user' };
  }
}

/** Best rule to remember for an "always allow" answer. */
export function ruleFor(toolName, input, cwd) {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const [first, second] = String(input.command ?? '').trim().split(/\s+/);
    // A sub-command narrows the rule usefully only when it is a plain word.
    // Flags, paths and URLs would produce a rule that matches almost nothing.
    const usefulSecond = second && !/^[-./~]/.test(second) && !second.includes('://');
    if (usefulSecond) return `${toolName}(${first} ${second}:*)`;
    return first ? `${toolName}(${first}:*)` : toolName;
  }
  if (PATH_TOOLS.has(toolName) && input.file_path) {
    const absolute = resolveToolPath(input.file_path, cwd);
    const relative = path.relative(cwd, absolute);
    const directory = path.dirname(relative);
    if (directory === '.' || relative.startsWith('..')) return toolName;
    return `${toolName}(${toPosix(directory)}/**)`;
  }
  return toolName;
}


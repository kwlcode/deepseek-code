/**
 * Filesystem tools: Read, Write, Edit, Glob.
 *
 * Tool names and shapes deliberately match Claude Code so that project
 * permission rules written for Claude Code (`Read`, `Edit(/src/**)`,
 * `.claude/commands/*.md` -> `allowed-tools: ["Read", "Glob"]`) keep working.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff, diffSummary } from '../diff.js';

export const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 300;
const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', '.next', '.venv', '__pycache__', '.cache', 'dist', 'build', 'target', 'coverage',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.7z', '.exe', '.dll',
  '.so', '.dylib', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.sqlite', '.db',
]);

export function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Translate a glob (supporting **, *, ?, [abc], {a,b}) into a RegExp. */
export function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = normalized.indexOf(']', i + 1);
      if (close === -1) source += '\\[';
      else {
        source += normalized.slice(i, close + 1);
        i = close;
      }
    } else if (char === '{') {
      const close = normalized.indexOf('}', i + 1);
      if (close === -1) source += '\\{';
      else {
        const options = normalized.slice(i + 1, close).split(',').map(escapeRegExp);
        source += `(?:${options.join('|')})`;
        i = close;
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `relativePath` matches `pattern` (basename-only patterns allowed). */
export function matchesGlob(relativePath, pattern) {
  const target = String(relativePath).replace(/\\/g, '/');
  const normalizedPattern = String(pattern).replace(/\\/g, '/');
  if (globToRegExp(normalizedPattern).test(target)) return true;
  if (!normalizedPattern.includes('/')) {
    return globToRegExp(normalizedPattern).test(path.posix.basename(target));
  }
  return false;
}

/** Resolve a tool-supplied path against the session cwd, expanding `~`. */
export function resolveToolPath(inputPath, cwd) {
  if (!inputPath || typeof inputPath !== 'string') throw new Error('A file path is required.');
  let value = inputPath.trim();
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export function looksBinary(buffer) {
  return buffer.subarray(0, 4096).includes(0);
}

export function isBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Walk `root` lazily, skipping vendored/VCS directories. */
export async function* walkFiles(root, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORES;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() || (entry.isSymbolicLink() && options.followSymlinks)) {
        yield full;
      }
    }
  }
}

const readSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Absolute path to the file to read.' },
    offset: { type: 'integer', description: 'Line number to start reading from (1-based).' },
    limit: { type: 'integer', description: 'Maximum number of lines to read.' },
  },
  required: ['file_path'],
};

export const readTool = {
  name: 'Read',
  description:
    'Read a file from the local filesystem. Returns the contents with line numbers, up to ' +
    '2000 lines at a time; use offset/limit to page through larger files. Prefer this over ' +
    '`cat` in Bash so output stays line-numbered and bounded.',
  readOnly: true,
  inputSchema: readSchema,
  async run(input, ctx) {
    const target = resolveToolPath(input.file_path, ctx.cwd);
    let stats;
    try {
      stats = await fsp.stat(target);
    } catch {
      return { isError: true, output: `File not found: ${target}` };
    }
    if (stats.isDirectory()) {
      return { isError: true, output: `${target} is a directory. Use Glob or \`ls\` in Bash instead.` };
    }
    if (isBinaryPath(target)) {
      return { isError: true, output: `Refusing to read binary file: ${target}` };
    }

    const buffer = await fsp.readFile(target);
    if (looksBinary(buffer)) return { isError: true, output: `File appears to be binary: ${target}` };

    const allLines = buffer.toString('utf8').split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(Number(input.limit) || MAX_READ_LINES, MAX_READ_LINES);
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    if (!slice.length) {
      return {
        isError: true,
        output: `offset ${offset} is past the end of ${target} (${allLines.length} lines total)`,
      };
    }

    const width = String(offset + slice.length - 1).length;
    const lines = slice.map((line, index) => {
      const number = String(offset + index).padStart(width, ' ');
      const trimmed =
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}... [line truncated]` : line;
      return `${number}\u2192${trimmed}`;
    });

    const lastRead = offset + slice.length - 1;
    if (lastRead < allLines.length) {
      lines.push(`... ${allLines.length - lastRead} more lines (call Read again with offset=${lastRead + 1})`);
    }
    return { output: lines.join('\n') };
  },
};

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply a list of exact-string edits, returning the new content.
 * Literal replacement is done with index arithmetic so `$&`, `$1` and friends
 * inside new_string are never interpreted.
 */
export function applyEdits(content, edits) {
  let result = content;
  for (const [position, edit] of edits.entries()) {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit ?? {};
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new Error(`edit #${position + 1} needs both old_string and new_string`);
    }
    if (oldString === newString) {
      throw new Error(`edit #${position + 1}: old_string and new_string are identical`);
    }
    const occurrences = countOccurrences(result, oldString);
    if (occurrences === 0) {
      throw new Error(
        `edit #${position + 1}: old_string not found. It must match the file exactly, ` +
          'including indentation and whitespace.',
      );
    }
    if (occurrences > 1 && !replaceAll) {
      const first = result.indexOf(oldString);
      const line = result.slice(0, first).split('\n').length;
      throw new Error(
        `edit #${position + 1}: old_string appears ${occurrences} times (first near line ${line}). ` +
          'Add more surrounding context to make it unique, or set replace_all: true.',
      );
    }
    if (replaceAll) result = result.split(oldString).join(newString);
    else {
      const index = result.indexOf(oldString);
      result = result.slice(0, index) + newString + result.slice(index + oldString.length);
    }
  }
  return result;
}

export const writeTool = {
  name: 'Write',
  description:
    'Write a file to the local filesystem, creating parent directories as needed and ' +
    'overwriting the file if it exists. Prefer Edit for changing part of an existing file.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write.' },
      content: { type: 'string', description: 'Full contents to write.' },
    },
    required: ['file_path', 'content'],
  },
  async run(input, ctx) {
    const target = resolveToolPath(input.file_path, ctx.cwd);
    const content = String(input.content ?? '');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    const lines = content.split('\n').length;
    return { output: `Wrote ${lines} line${lines === 1 ? '' : 's'} (${content.length} bytes) to ${target}` };
  },
};

export const editTool = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. old_string must match the file byte for byte, ' +
    'including indentation, and must be unique unless replace_all is true. Include a few ' +
    'lines of surrounding context to anchor the change. Pass an array of edits to apply ' +
    'several changes to the same file in one call.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to modify.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
      edits: {
        type: 'array',
        description: 'Alternative to old_string/new_string: a list of {old_string, new_string, replace_all}.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path'],
  },
  async run(input, ctx) {
    const target = resolveToolPath(input.file_path, ctx.cwd);
    let original;
    try {
      original = await fsp.readFile(target, 'utf8');
    } catch {
      return { isError: true, output: `File not found: ${target}` };
    }

    const edits = Array.isArray(input.edits) && input.edits.length
      ? input.edits
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];

    let updated;
    try {
      updated = applyEdits(original, edits);
    } catch (error) {
      return { isError: true, output: `Edit failed: ${error.message}` };
    }

    await fsp.writeFile(target, updated, 'utf8');
    const diff = unifiedDiff(original, updated, {
      oldLabel: path.basename(target),
      newLabel: path.basename(target),
      context: 2,
    });
    const clipped = diff.text.split('\n').slice(0, 120).join('\n');
    return {
      output: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${target} (${diffSummary(diff.added, diff.removed)})\n${clipped}`,
      meta: { added: diff.added, removed: diff.removed },
    };
  },
};

export const globTool = {
  name: 'Glob',
  description:
    'Find files by glob pattern, sorted by most recently modified first. Supports **, *, ?, ' +
    '[abc] and {a,b}. Example: "**/*.test.ts". Use this instead of `find` or `ls -R`.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.js".' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const root = input.path ? resolveToolPath(input.path, ctx.cwd) : ctx.cwd;
    const results = [];
    for await (const file of walkFiles(root)) {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      if (!matchesGlob(relative, input.pattern)) continue;
      let mtime = 0;
      try {
        mtime = (await fsp.stat(file)).mtimeMs;
      } catch {
        mtime = 0;
      }
      results.push({ file, mtime });
      if (results.length >= MAX_GLOB_RESULTS * 4) break;
    }

    if (!results.length) return { output: `No files matched ${input.pattern} under ${root}` };

    results.sort((a, b) => b.mtime - a.mtime);
    const clipped = results.slice(0, MAX_GLOB_RESULTS).map((entry) => entry.file);
    const output = clipped.join('\n');
    return {
      output:
        results.length > MAX_GLOB_RESULTS
          ? `${output}\n... ${results.length - MAX_GLOB_RESULTS} more matches not shown`
          : output,
      meta: { count: results.length },
    };
  },
};


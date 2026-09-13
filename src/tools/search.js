/**
 * Grep tool: regex content search across the working tree, implemented in
 * JavaScript so the CLI stays dependency-free (no ripgrep binary required).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { matchesGlob, resolveToolPath, walkFiles, looksBinary, isBinaryPath } from './fs.js';

const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_HEAD_LIMIT = 200;

export const grepTool = {
  name: 'Grep',
  description:
    'Search file contents with a JavaScript regular expression. `output_mode` selects ' +
    '`content` (matching lines with line numbers), `files_with_matches` (paths only) or ' +
    '`count` (matches per file). Narrow with `glob` and `path` when the tree is large.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      output_mode: {
        type: 'string',
        description: 'One of: content, files_with_matches, count.',
        enum: ['content', 'files_with_matches', 'count'],
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive matching.' },
      line_numbers: { type: 'boolean', description: 'Include line numbers in content mode (default true).' },
      head_limit: { type: 'integer', description: 'Maximum output lines (default 200).' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    let regex;
    try {
      regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    } catch (error) {
      return { isError: true, output: `Invalid regular expression: ${error.message}` };
    }

    const root = input.path ? resolveToolPath(input.path, ctx.cwd) : ctx.cwd;
    const mode = input.output_mode ?? 'content';
    const headLimit = Math.max(1, Number(input.head_limit) || DEFAULT_HEAD_LIMIT);
    const showLineNumbers = input.line_numbers !== false;

    let stats = null;
    try {
      stats = await fsp.stat(root);
    } catch {
      return { isError: true, output: `Path not found: ${root}` };
    }

    const files = [];
    if (stats.isFile()) files.push(root);
    else {
      for await (const file of walkFiles(root)) {
        if (input.glob && !matchesGlob(path.relative(root, file).replace(/\\/g, '/'), input.glob)) continue;
        files.push(file);
      }
    }

    const contentLines = [];
    const matchedFiles = [];
    const counts = new Map();
    let totalMatches = 0;

    for (const file of files) {
      if (isBinaryPath(file)) continue;
      let buffer;
      try {
        const fileStat = await fsp.stat(file);
        if (fileStat.size > MAX_FILE_BYTES) continue;
        buffer = await fsp.readFile(file);
      } catch {
        continue;
      }
      if (looksBinary(buffer)) continue;

      const lines = buffer.toString('utf8').split('\n');
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.length > 4000) continue;
        if (!regex.test(line)) continue;
        fileMatches++;
        totalMatches++;
        if (mode === 'content' && contentLines.length < headLimit) {
          const label = path.relative(ctx.cwd, file).replace(/\\/g, '/') || file;
          contentLines.push(showLineNumbers ? `${label}:${index + 1}:${line}` : `${label}:${line}`);
        }
      }
      if (fileMatches > 0) {
        matchedFiles.push(path.relative(ctx.cwd, file).replace(/\\/g, '/') || file);
        counts.set(file, fileMatches);
      }
    }

    if (!totalMatches) return { output: `No matches for /${input.pattern}/ under ${root}` };

    if (mode === 'files_with_matches') {
      const list = matchedFiles.slice(0, headLimit);
      return {
        output: `${list.join('\n')}${matchedFiles.length > headLimit ? `\n... ${matchedFiles.length - headLimit} more files` : ''}`,
        meta: { files: matchedFiles.length, matches: totalMatches },
      };
    }

    if (mode === 'count') {
      const list = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, headLimit)
        .map(([file, count]) => `${path.relative(ctx.cwd, file).replace(/\\/g, '/') || file}: ${count}`);
      return { output: list.join('\n'), meta: { matches: totalMatches } };
    }

    const truncated = contentLines.length >= headLimit && totalMatches > contentLines.length;
    return {
      output: `${contentLines.join('\n')}${truncated ? `\n... showing first ${headLimit} of ${totalMatches} matching lines` : ''}`,
      meta: { matches: totalMatches, files: matchedFiles.length },
    };
  },
};

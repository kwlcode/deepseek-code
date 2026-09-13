/**
 * Minimal YAML front-matter reader for `.claude/commands/*.md` and
 * `.claude/agents/*.md`. Supports scalars, quoted scalars, inline arrays
 * (`[a, b]`) and block scalars (`|`, `>`), which is everything those files use.
 */

function coerce(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^"(.*)"$/s.test(trimmed)) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/s.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

export function parseFrontMatter(text) {
  const source = String(text ?? '');
  if (!source.startsWith('---')) return { data: {}, body: source };

  const firstBreak = source.indexOf('\n');
  if (firstBreak === -1) return { data: {}, body: source };

  const closing = source.indexOf('\n---', firstBreak);
  if (closing === -1) return { data: {}, body: source };

  const block = source.slice(firstBreak + 1, closing);
  const bodyStart = source.indexOf('\n', closing + 1);
  const body = bodyStart === -1 ? '' : source.slice(bodyStart + 1);

  const data = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;

    if (rawValue === '|' || rawValue === '>') {
      const collected = [];
      while (i + 1 < lines.length && (/^\s{2,}/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[i + 1].replace(/^\s{2}/, ''));
        i++;
      }
      data[key] = rawValue === '|' ? collected.join('\n') : collected.join(' ').trim();
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      data[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((entry) => coerce(entry))
        .filter((entry) => entry !== '');
      continue;
    }

    data[key] = coerce(rawValue);
  }

  return { data, body };
}

/** Expand `$ARGUMENTS`, `$1`..`$9` and `$ARGUMENTS[0]` in a command body. */
export function expandArguments(body, argumentString) {
  const args = String(argumentString ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = args.map((arg) => arg.replace(/^["']|["']$/g, ''));
  return String(body)
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_, index) => cleaned[Number(index)] ?? '')
    .replace(/\$ARGUMENTS/g, String(argumentString ?? '').trim())
    .replace(/\$(\d)/g, (_, index) => cleaned[Number(index) - 1] ?? '');
}

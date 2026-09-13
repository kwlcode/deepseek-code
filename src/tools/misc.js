/**
 * Planning and research tools: TodoWrite, WebFetch, Task (subagents).
 */

const MAX_FETCH_CHARS = 20_000;
const MAX_HTML_BYTES = 3_000_000;

const VALID_STATUSES = ['pending', 'in_progress', 'completed'];

export function formatTodos(todos) {
  const glyph = { pending: ' ', in_progress: '~', completed: 'x' };
  return todos
    .map((todo, index) => {
      const status = VALID_STATUSES.includes(todo.status) ? todo.status : 'pending';
      const label = todo.content ?? todo.activeForm ?? '(unnamed task)';
      return `${index + 1}. [${glyph[status]}] ${label}`;
    })
    .join('\n');
}

export const todoTool = {
  name: 'TodoWrite',
  description:
    'Create and update the task list for the current session. Use it for any work that needs ' +
    'three or more steps, or when the user gives you several things to do: keep exactly one task ' +
    'in_progress, mark tasks completed as soon as they are done, and clear the list when the work ' +
    'is finished. This is how the user follows your progress.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list, replacing any previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description, e.g. "Add the retry helper".' },
            status: { type: 'string', enum: VALID_STATUSES },
            activeForm: { type: 'string', description: 'Present continuous form shown while running.' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input, ctx) {
    const todos = (input.todos ?? []).map((todo) => ({
      content: String(todo.content ?? '').trim(),
      status: VALID_STATUSES.includes(todo.status) ? todo.status : 'pending',
      activeForm: todo.activeForm,
    })).filter((todo) => todo.content);

    ctx.session.todos = todos;
    if (!todos.length) return { output: 'Task list cleared.' };

    const inProgress = todos.filter((todo) => todo.status === 'in_progress').length;
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const note = inProgress > 1 ? ' (note: more than one task is in_progress)' : '';
    return { output: `${formatTodos(todos)}\n(${done}/${todos.length} complete)${note}`, meta: { todos } };
  },
};

/** Strip scripts, styles and tags so a page reads as plain text. */
export function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchTool = {
  name: 'WebFetch',
  description:
    'Fetch a URL over HTTP(S) and return its readable text (HTML is stripped). Use it to read ' +
    'documentation, API references and changelogs. The response is truncated, so fetch the ' +
    'specific page you need rather than a site index.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      prompt: { type: 'string', description: 'What you are looking for in the page (used to focus your reading).' },
    },
    required: ['url'],
  },
  async run(input) {
    const target = String(input.url ?? '');
    if (!/^https?:\/\//i.test(target)) {
      return { isError: true, output: 'WebFetch needs an absolute http(s) URL.' };
    }
    let response;
    try {
      response = await fetch(target, {
        redirect: 'follow',
        headers: { 'user-agent': 'deepseek-code/0.1 (+cli)', accept: 'text/html,application/json,text/plain,*/*' },
      });
    } catch (error) {
      return { isError: true, output: `Fetch failed for ${target}: ${error.message}` };
    }
    if (!response.ok) {
      return { isError: true, output: `Fetch failed for ${target}: HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) {
      return { isError: true, output: `Page is too large (${buffer.byteLength} bytes): ${target}` };
    }
    const raw = new TextDecoder().decode(buffer);
    const text = /html/i.test(contentType) ? htmlToText(raw) : raw;
    const truncated = text.length > MAX_FETCH_CHARS;
    return {
      output: truncated ? `${text.slice(0, MAX_FETCH_CHARS)}\n... [truncated]` : text,
      meta: { url: target, bytes: buffer.byteLength, truncated },
    };
  },
};

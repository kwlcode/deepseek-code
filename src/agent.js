/**
 * The agent loop.
 *
 * One "turn" is: stream a completion, run any tool calls it asks for, feed the
 * results back, repeat until the model answers without calling a tool or the
 * step budget runs out.
 *
 * Renderer contract (implemented by cli/render.js):
 *   startAssistant() / reasoning(chunk) / text(chunk) / endAssistant(info)
 *   toolStart({name, summary}) / toolUpdate({name, text}) / toolEnd({name, output, isError, durationMs})
 *   askPermission({summary, detail, preview}) -> 'allow' | 'allow-always' | 'deny' | 'deny-always'
 *   notice(message) / warn(message) / error(message) / todos(list)
 */

import { streamChat, chatOnce } from './api.js';
import { buildRegistry, toolSpecs, restrictRegistry } from './tools/index.js';
import { PermissionEngine, previewFor, describeCall } from './permissions.js';
import { buildSystemPrompt, loadMemoryFiles } from './prompt.js';
import { saveSession, createSession } from './session.js';
import { UsageTracker } from './cost.js';

const MAX_CONTINUATIONS = 3;
const MAX_TOOL_RESULT_CHARS = 60_000;

/**
 * Parse tool arguments. Models occasionally wrap JSON in a fence or leave a
 * trailing comma, so recover from the common cases instead of failing the call.
 */
export function parseToolArguments(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return {};

  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (braced && braced !== text) candidates.push(braced);
  candidates.push(text.replace(/,\s*([}\]])/g, '$1'));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`could not parse tool arguments as JSON: ${text.slice(0, 300)}`);
}

function clipResult(text, limit = MAX_TOOL_RESULT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... [tool result truncated at ${limit} characters]`;
}

/** Format a tool result the way it is handed back to the model. */
export function formatToolMessage(result) {
  const body = clipResult(result?.output ?? '');
  const meta = result?.meta ? `\n${JSON.stringify(result.meta).slice(0, 2000)}` : '';
  const content = body ? `${body}${meta}` : '(no output)';
  return result?.isError ? `Error: ${content}` : content;
}

export class Agent {
  /**
   * @param {{config: object, renderer: object, session: object, registry?: Map,
   *          memoryFiles?: object[], customPrompt?: string, interactive?: boolean,
   *          permissionMode?: string, allowedTools?: string[], isSubagent?: boolean}} options
   */
  constructor(options) {
    this.config = options.config;
    this.renderer = options.renderer;
    this.session = options.session;
    this.cwd = options.session.cwd ?? options.config.cwd;
    this.isSubagent = Boolean(options.isSubagent);
    this.customPrompt = options.customPrompt ?? null;
    this.allowedTools = options.allowedTools ?? null;
    this.memoryFiles = options.memoryFiles ?? loadMemoryFiles(this.cwd);

    this.registry = options.registry
      ? restrictRegistry(options.registry, this.allowedTools)
      : buildRegistry(this.config);

    this.tracker = options.tracker ?? new UsageTracker(this.config.model);
    this.abortController = new AbortController();
    this.stepCount = 0;

    this.permissions = new PermissionEngine({
      mode: options.permissionMode ?? this.session.permissionMode ?? this.config.permissionMode,
      allow: this.config.permissions?.allow ?? [],
      deny: this.config.permissions?.deny ?? [],
      cwd: this.cwd,
      nonInteractive: !(options.interactive ?? false),
      ask: this.buildAsk(),
      onNotice: (message) => this.renderer.notice?.(message),
      rememberRule: async (rule) => {
        try {
          const { rememberAllowRule } = await import('./config.js');
          rememberAllowRule(this.cwd, rule);
        } catch (error) {
          this.renderer.warn?.(`Could not save the rule: ${error.message}`);
        }
      },
    });
  }

  /** Wire the permission engine's ask() to the renderer. */
  buildAsk() {
    return async ({ tool, input, summary }) => {
      const preview = await previewFor(tool.name, input, this.cwd);
      return this.renderer.askPermission({
        summary,
        tool: tool.name,
        detail: input,
        preview,
        mode: this.permissions.mode,
      });
    };
  }

  setPermissionMode(mode) {
    this.permissions.setMode(mode);
    this.session.permissionMode = mode;
  }

  abort() {
    this.abortController.abort();
  }

  /** System prompt + conversation, in the order the API expects. */
  buildMessages() {
    const tools = this.registrySnapshot();
    const system = buildSystemPrompt({
      config: { ...this.config, model: this.session.model ?? this.config.model, permissionMode: this.permissions.mode },
      tools: [...this.registry.values()],
      cwd: this.cwd,
      customPrompt: this.customPrompt,
      memoryFiles: this.memoryFiles,
    });
    return [{ role: 'system', content: system }, ...this.session.messages];
  }

  registrySnapshot() {
    return this.registry;
  }

  /** Everything a tool may touch while it runs. */
  toolContext() {
    return {
      cwd: this.cwd,
      config: this.config,
      session: this.session,
      signal: this.abortController.signal,
      tracker: this.tracker,
      renderer: this.renderer,
      registry: this.registry,
      agent: this,
      spawnSubagent: (request) => this.spawnSubagent(request),
    };
  }

  /** Validate, authorise, run and render one tool call. */
  async executeToolCall(call, step) {
    const name = call.function?.name;
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        content: `Error: unknown tool "${name}". Available tools: ${[...this.registry.keys()].join(', ')}.`,
        isError: true,
      };
    }

    let input;
    try {
      input = parseToolArguments(call.function?.arguments);
    } catch (error) {
      return { content: `Error: ${error.message}`, isError: true };
    }
    const missing = (tool.inputSchema?.required ?? []).filter((key) => input[key] === undefined);
    if (missing.length) {
      return {
        content: `Error: missing required parameter(s) ${missing.join(', ')}. Expected schema: ${JSON.stringify(tool.inputSchema)}`,
        isError: true,
      };
    }

    this.renderer.toolStart?.({ name, summary: describeCall(name, input), step });

    const decision = await this.permissions.request(tool, input);
    if (decision.behavior !== 'allow') {
      this.renderer.toolEnd?.({ name, output: decision.reason, isError: true, denied: true });
      return {
        content:
          `Error: permission denied for ${name} (${decision.reason}). Do not retry this exact call. ` +
          'If you need it, explain to the user what you want to do and ask them to change the permission mode or allow the action.',
        isError: true,
        denied: true,
      };
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await tool.run(input, this.toolContext());
    } catch (error) {
      result = { isError: true, output: `${name} failed: ${error.message}` };
    }
    const durationMs = Date.now() - startedAt;
    const content = formatToolMessage(result);
    this.renderer.toolEnd?.({
      name,
      output: content,
      isError: Boolean(result?.isError),
      durationMs,
      meta: result?.meta,
    });
    if (name === 'TodoWrite') this.renderer.todos?.(this.session.todos ?? []);
    return { content, isError: Boolean(result?.isError) };
  }

  /**
   * Run one user turn to completion.
   * @returns {Promise<{text: string, steps: number, stopped: string|null, aborted?: boolean, error?: string}>}
   */
  async runTurn(userText) {
    this.abortController = new AbortController();
    this.session.messages.push({ role: 'user', content: userText });
    const startStep = this.stepCount;
    let finalText = '';
    let continuations = 0;

    while (this.stepCount - startStep < this.config.maxSteps) {
      if (this.abortController.signal.aborted) return { text: finalText, steps: this.stepCount - startStep, stopped: 'aborted', aborted: true };
      this.stepCount += 1;

      const model = this.session.model ?? this.config.model;
      this.renderer.startAssistant?.({ step: this.stepCount });

      let result;
      try {
        result = await streamChat(
          { ...this.config, model },
          {
            messages: this.buildMessages(),
            tools: toolSpecs(this.registry),
            model,
            signal: this.abortController.signal,
            onDelta: (kind, chunk) => {
              if (kind === 'reasoning') this.renderer.reasoning?.(chunk);
              else this.renderer.text?.(chunk);
            },
          },
        );
      } catch (error) {
        if (error?.name === 'AbortError') {
          return { text: finalText, steps: this.stepCount - startStep, stopped: 'aborted', aborted: true };
        }
        this.renderer.error?.(error.message);
        return { text: finalText, steps: this.stepCount - startStep, stopped: 'error', error: error.message };
      }

      const message = result.message;
      this.session.messages.push(message);
      finalText = message.content ?? '';

      if (result.usage) this.tracker.add(result.usage, model);
      this.renderer.endAssistant?.({
        finishReason: result.finishReason,
        usage: result.usage,
        tracker: this.tracker,
        truncated: Boolean(message.truncated),
      });
      await this.persist();

      const calls = (message.tool_calls ?? []).filter((entry) => entry.function?.name);
      if (!calls.length) {
        if (message.truncated && continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          this.session.messages.push({
            role: 'user',
            content: 'Your previous message was cut off by the output limit. Continue exactly where you left off, without repeating what you already wrote.',
          });
          continue;
        }
        return { text: finalText, steps: this.stepCount - startStep, stopped: null };
      }

      for (const call of calls) {
        const outcome = await this.executeToolCall(call, this.stepCount);
        this.session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
      await this.persist();
    }

    this.renderer.warn?.(`Step limit reached (${this.config.maxSteps}). Ask me to continue when you are ready.`);
    return { text: finalText, steps: this.stepCount - startStep, stopped: 'maxSteps' };
  }

  /** Persist the transcript; failures are reported but never fatal. */
  async persist() {
    this.session.usage = {
      ...this.tracker.totals,
      usd: this.tracker.usd,
      turns: this.tracker.turns,
    };
    if (this.isSubagent) return;
    try {
      await saveSession(this.session);
    } catch (error) {
      this.renderer.warn?.(`Could not save the transcript: ${error.message}`);
    }
  }

  /**
   * Run a focused subagent: fresh history, its own system prompt, the same
   * tools minus Task (so it cannot recurse), and the same permission mode.
   */
  async spawnSubagent({ description, prompt, definition }) {
    const { createSubagentRenderer } = await import('./ui.js');
    const { loadAgentDefinition } = await import('./tools/task.js');

    const resolved = definition ?? (await loadAgentDefinition(this.cwd, undefined));
    const childSession = createSession({
      cwd: this.cwd,
      model: resolved?.model ?? this.session.model ?? this.config.model,
      permissionMode: this.permissions.mode,
      title: `subagent: ${description ?? 'task'}`,
    });

    const childRegistry = new Map(this.registry);
    childRegistry.delete('Task');

    const systemPrompt = resolved?.systemPrompt
      ? `${resolved.systemPrompt}\n\n# Environment\n\nYou are a subagent started by deepseek-code. Your working directory is ${this.cwd}. Finish by reporting your findings or results in your final message: it is the only thing the calling agent will see.`
      : null;

    const child = new Agent({
      config: { ...this.config, model: childSession.model },
      renderer: createSubagentRenderer({ parent: this.renderer, description }),
      session: childSession,
      registry: resolved?.tools?.length ? restrictRegistry(childRegistry, resolved.tools) : childRegistry,
      memoryFiles: this.memoryFiles,
      permissionMode: this.permissions.mode,
      interactive: false,
      isSubagent: true,
    });
    if (systemPrompt) child.customPrompt = systemPrompt;

    const outcome = await child.runTurn(prompt);
    const text = outcome.text || lastAssistantText(childSession);
    this.renderer.notice?.(`Subagent "${description ?? 'task'}" finished (${outcome.steps} step(s)).`);
    return { text, steps: outcome.steps, error: outcome.error ?? null };
  }

  /**
   * Replace the conversation with a summary, keeping the most recent turns
   * verbatim. Used by /compact and automatically when context grows too large.
   */
  async compact() {
    const messages = this.session.messages;
    if (messages.length < 6) {
      this.renderer.notice?.('Nothing to compact yet.');
      return { compacted: false };
    }

    // Keep the last few messages so the model does not lose the current thread.
    const keep = messages.slice(-4);
    const older = messages.slice(0, -4);
    const transcript = older
      .map((message) => {
        const role = message.role === 'tool' ? 'tool result' : message.role;
        return `${role}: ${String(message.content ?? '').slice(0, 4000)}`;
      })
      .join('\n\n');

    this.renderer.notice?.('Summarising the conversation...');
    try {
      const summary = await chatOnce(
        { ...this.config, model: this.config.smallModel ?? this.config.model },
        [
          {
            role: 'system',
            content:
              'You compress coding sessions. Summarise the transcript into a briefing that lets another ' +
              'agent continue the work: the goal, decisions made, files touched with their current state, ' +
              'commands run and their results, open problems, and the immediate next step. Be specific and ' +
              'terse; omit pleasantries. Use bullet points.',
          },
          { role: 'user', content: transcript.slice(-120_000) },
        ],
        { maxTokens: 2048 },
      );

      this.session.messages = [
        { role: 'user', content: `[Summary of the conversation so far]\n\n${summary.content}` },
        { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' },
        ...keep,
      ];
      await this.persist();
      this.renderer.notice?.(`Compacted ${older.length} message(s) into a summary.`);
      return { compacted: true, summary: summary.content };
    } catch (error) {
      this.renderer.error?.(`Compaction failed: ${error.message}`);
      return { compacted: false, error: error.message };
    }
  }
}

/** Last assistant text in a transcript, used when a subagent ends mid-step. */
function lastAssistantText(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role === 'assistant' && message.content) return message.content;
  }
  return '';
}


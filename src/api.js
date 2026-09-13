/**
 * DeepSeek API client over the OpenAI-compatible /chat/completions endpoint.
 *
 * DeepSeek specifics this module encodes:
 *  - thinking mode is enabled by default and is toggled with
 *    `thinking: {type: "enabled" | "disabled"}` plus `reasoning_effort`.
 *  - the chain of thought comes back in `reasoning_content`, next to `content`.
 *  - when `tools` are sent, `reasoning_content` from earlier assistant turns
 *    MUST be echoed back or the model loses its chain of thought, so assistant
 *    messages are stored and replayed verbatim.
 *  - thinking mode ignores temperature/presence/frequency penalties, so we do
 *    not send them.
 */

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.body = options.body ?? null;
  }
}

/** Build the JSON request body for one completion. */
export function buildChatBody({ config, messages, tools, model, maxTokens, stream = true }) {
  const body = {
    model: model ?? config.model,
    messages,
    max_tokens: maxTokens ?? config.maxTokens,
  };

  if (stream) body.stream = true;

  if (config.thinking) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = config.effort;
  } else {
    body.thinking = { type: 'disabled' };
  }

  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** Mutable accumulator for one streamed assistant message. */
export function newMessageState() {
  return {
    content: '',
    reasoningContent: '',
    toolCalls: new Map(), // index -> { id, name, arguments }
    finishReason: null,
    usage: null,
  };
}

/** Apply one streaming `delta` object to the accumulator. */
export function applyStreamDelta(state, delta) {
  if (!delta) return state;

  if (typeof delta.reasoning_content === 'string') state.reasoningContent += delta.reasoning_content;
  if (typeof delta.content === 'string') state.content += delta.content;

  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? state.toolCalls.size;
    const existing = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
    if (call.id) existing.id = call.id;
    if (call.function?.name) existing.name = call.function.name;
    if (typeof call.function?.arguments === 'string') existing.arguments += call.function.arguments;
    state.toolCalls.set(index, existing);
  }
  return state;
}

/** Turn an accumulator into a replayable assistant message. */
export function stateToMessage(state) {
  const message = { role: 'assistant', content: state.content };
  if (state.reasoningContent) message.reasoning_content = state.reasoningContent;

  const calls = [...state.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call], order) => ({
      id: call.id || `call_${index}_${order}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }))
    .filter((call) => call.function.name);

  if (calls.length) message.tool_calls = calls;
  return message;
}

/** Split a byte stream into complete SSE `data:` payloads. */
export async function* ssePayloads(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  const drain = function* (flush) {
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
    if (flush && buffer.trim().startsWith('data:')) {
      const line = buffer.trim();
      buffer = '';
      yield line.slice(5).trim();
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function parseErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? parsed?.message ?? text;
  } catch {
    return text;
  }
}

/** Translate an HTTP failure into an ApiError with an actionable message. */
export function httpError(status, rawBody, baseUrl = '') {
  const detail = parseErrorMessage(rawBody).slice(0, 500);
  let message;
  if (status === 401) {
    message = 'DeepSeek rejected the credentials (401). Check that DEEPSEEK_API_KEY is valid.';
  } else if (status === 402) {
    message = 'DeepSeek reports insufficient balance (402). Top up your account to continue.';
  } else if (status === 429) {
    message = 'DeepSeek rate limit reached (429).';
  } else if (status >= 500) {
    message = `DeepSeek server error (${status}).`;
  } else if (status === 400) {
    message = `DeepSeek rejected the request (400): ${detail}`;
  } else {
    message = `DeepSeek request failed (${status}): ${detail}`;
  }
  if (baseUrl && status !== 400) message += ` [${baseUrl}]`;
  return new ApiError(message, {
    status,
    retryable: RETRYABLE_STATUS.has(status),
    body: detail,
  });
}

function isNetworkError(error) {
  return (
    error instanceof TypeError ||
    ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(
      error?.code,
    )
  );
}

function backoffDelay(attempt, error) {
  const header = Number.parseFloat(error?.retryAfterSeconds ?? '');
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Stream one assistant message.
 * @param {object} config resolved configuration
 * @param {{messages: object[], tools?: object[], model?: string, signal?: AbortSignal,
 *          onDelta?: (kind: 'text'|'reasoning', chunk: string) => void, retries?: number}} request
 */
export async function streamChat(config, request) {
  const { messages, tools, model, maxTokens, signal, onDelta } = request;
  const url = `${config.baseUrl}/chat/completions`;
  const body = buildChatBody({ config, messages, tools, model, maxTokens });
  const maxAttempts = request.retries ?? 4;
  let lastError = null;
  let attempt = 0;
  let emitted = false;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = httpError(response.status, text, config.baseUrl);
        error.retryAfterSeconds = response.headers.get('retry-after');
        throw error;
      }

      const state = newMessageState();
      for await (const payload of ssePayloads(response.body)) {
        if (payload === '[DONE]') break;
        if (!payload) continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial noise
        }

        if (parsed.error) {
          throw new ApiError(`DeepSeek stream error: ${parseErrorMessage(JSON.stringify(parsed.error))}`, {
            retryable: false,
            body: JSON.stringify(parsed.error),
          });
        }
        if (parsed.usage) state.usage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) state.finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        applyStreamDelta(state, delta);

        if (delta.reasoning_content && onDelta) {
          emitted = true;
          onDelta('reasoning', delta.reasoning_content);
        }
        if (delta.content && onDelta) {
          emitted = true;
          onDelta('text', delta.content);
        }
      }

      const message = stateToMessage(state);
      if (state.finishReason === 'length') message.truncated = true;
      return { message, usage: state.usage, finishReason: state.finishReason };
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError') throw error;
      const retryable = error instanceof ApiError ? error.retryable : isNetworkError(error);
      // Never retry once tokens have reached the terminal: the caller would see
      // the same answer streamed twice.
      if (!retryable || emitted || attempt >= maxAttempts) throw error;
      await sleep(backoffDelay(attempt, error), signal);
    }
  }
  throw lastError ?? new ApiError('DeepSeek request failed');
}

/** Single non-streaming completion (used for compaction and session titles). */
export async function chatOnce(config, messages, options = {}) {
  const url = `${config.baseUrl}/chat/completions`;
  const body = buildChatBody({
    config,
    messages,
    model: options.model,
    maxTokens: options.maxTokens ?? 2048,
    stream: false,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) {
    throw httpError(response.status, await response.text().catch(() => ''), config.baseUrl);
  }
  const parsed = await response.json();
  return {
    content: parsed.choices?.[0]?.message?.content ?? '',
    usage: parsed.usage ?? null,
    finishReason: parsed.choices?.[0]?.finish_reason ?? null,
  };
}

/** GET /models — used by `deepseek-code doctor`. */
export async function listModels(config) {
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw httpError(response.status, await response.text().catch(() => ''), config.baseUrl);
  }
  const parsed = await response.json();
  return (parsed.data ?? []).map((entry) => entry.id).filter(Boolean);
}

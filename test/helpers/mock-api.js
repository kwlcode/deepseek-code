/**
 * A stub DeepSeek-compatible API for tests.
 *
 * Replays a scripted array of responses: script[0] answers the first request,
 * script[1] the second, and the last entry repeats for anything beyond that.
 * Every request body is recorded so tests can assert what the agent sent back
 * (tool results, echoed reasoning_content, and so on).
 *
 * A script entry looks like:
 *   {
 *     reasoning: ['I should read the file.'],        // streamed as reasoning_content
 *     content: ['Here ', 'it is.'],                  // streamed as content
 *     toolCalls: [{ id, name, arguments }],          // arguments may be a string
 *                                                    // or an array of fragments
 *     finishReason: 'stop' | 'tool_calls' | 'length',
 *     usage: { prompt_tokens, completion_tokens, ... },
 *     status: 500, body: {...},                      // error responses
 *   }
 */

import http from 'node:http';

const BASE_CHUNK = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: 'deepseek-flash',
};

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamStep(res, step) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const piece of step.reasoning ?? []) {
    sendSse(res, { ...BASE_CHUNK, choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
  }
  for (const piece of step.content ?? []) {
    sendSse(res, { ...BASE_CHUNK, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }

  (step.toolCalls ?? []).forEach((call, index) => {
    const fragments = Array.isArray(call.arguments) ? call.arguments : [call.arguments ?? '{}'];
    fragments.forEach((fragment, fragmentIndex) => {
      sendSse(res, {
        ...BASE_CHUNK,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: call.index ?? index,
                  ...(fragmentIndex === 0 ? { id: call.id ?? `call_${index}`, type: 'function' } : {}),
                  function: { ...(fragmentIndex === 0 ? { name: call.name } : {}), arguments: fragment },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    });
  });

  if (step.usage) {
    sendSse(res, { ...BASE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: step.usage });
  }

  const hasCalls = Boolean(step.toolCalls?.length);
  sendSse(res, {
    ...BASE_CHUNK,
    choices: [
      { index: 0, delta: {}, finish_reason: step.finishReason ?? (hasCalls ? 'tool_calls' : 'stop') },
    ],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function plainStep(step) {
  const message = { role: 'assistant', content: (step.content ?? []).join('') || null };
  if (step.reasoning?.length) message.reasoning_content = step.reasoning.join('');
  if (step.toolCalls?.length) {
    message.tool_calls = step.toolCalls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: { name: call.name, arguments: Array.isArray(call.arguments) ? call.arguments.join('') : call.arguments ?? '{}' },
    }));
  }
  return {
    id: BASE_CHUNK.id,
    object: 'chat.completion',
    created: BASE_CHUNK.created,
    model: BASE_CHUNK.model,
    choices: [{ index: 0, message, finish_reason: step.finishReason ?? (step.toolCalls?.length ? 'tool_calls' : 'stop') }],
    usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Start the stub server on an ephemeral port. */
export async function startMockApi(script, options = {}) {
  const models = options.models ?? ['deepseek-flash', 'deepseek-v4-pro'];
  const requests = [];
  const beforeRespond = options.beforeRespond ?? null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.url === '/models' && req.method === 'GET') {
        sendJson(res, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (req.url === '/chat/completions' && req.method === 'POST') {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, { error: { message: 'invalid JSON' } }, 400);
          return;
        }
        requests.push(body);

        if (beforeRespond) {
          const outcome = beforeRespond(res, body, requests.length);
          if (outcome === 'handled') return;
        }

        const step = script[Math.min(requests.length - 1, script.length - 1)] ?? { content: ['ok'] };
        if (step.status && step.status >= 400) {
          sendJson(res, step.body ?? { error: { message: 'stub failure', type: 'invalid_request_error' } }, step.status);
          return;
        }
        if (body.stream) streamStep(res, step);
        else sendJson(res, plainStep(step));
        return;
      }
      sendJson(res, { error: { message: `unexpected ${req.method} ${req.url}` } }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Bodies sent to /chat/completions, in order. */
    chatRequests: () => requests,
    setScript(next) {
      script.length = 0;
      script.push(...next);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Unit tests for OpenAI wire-format serialization (src/ai/openai.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  serializeMessages,
  buildResponsesBody,
  assistantFromResponsesOutput,
  createResponsesStreamState,
  applyResponsesEvent,
  shouldRetryStatus,
  retryDelayMs,
  userAgentFor,
  parseModelsResponse,
  listModels,
} from '../src/ai/openai.js';
import type { ChatMessage } from '../src/types.js';

test('serializeMessages: nests assistant tool_calls into the wire format', () => {
  const out = serializeMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      ],
    },
  ]);
  const tc = out[0].tool_calls![0] as unknown as {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  };
  assert.equal(tc.id, 'call_1');
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'read_file');
  assert.equal(tc.function.arguments, '{"path":"a.ts"}');
});

test('serializeMessages: handles multiple tool calls', () => {
  const out = serializeMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', name: 'list_dir', arguments: '{}' },
        { id: 'b', name: 'read_file', arguments: '{"path":"b.ts"}' },
      ],
    },
  ]);
  const tcs = out[0].tool_calls! as unknown as {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
  assert.equal(tcs.length, 2);
  assert.ok(tcs.every((t) => t.type === 'function'));
  assert.equal(tcs[1].function.name, 'read_file');
});

test('serializeMessages: leaves messages without tool_calls untouched', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'x' },
    { role: 'system', content: 'sys' },
  ];
  assert.deepEqual(serializeMessages(msgs), msgs);
});

test('buildResponsesBody: system becomes instructions, turns become items', () => {
  const body = buildResponsesBody(
    [
      { role: 'system', content: 'You are AstroCode.' },
      { role: 'user', content: 'hi' },
    ],
    [{ type: 'function', function: { name: 'list_dir', description: 'd', parameters: { type: 'object', properties: {} } } }],
    'auto:balance',
  );
  assert.equal(body.model, 'auto:balance');
  assert.equal(body.instructions, 'You are AstroCode.');
  assert.equal(body.stream, true);
  assert.ok(body.tools && body.tools.length === 1, 'tools passed through');
  const items = body.input as { type: string; role?: string; content?: unknown[] }[];
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'message');
  assert.equal(items[0].role, 'user');
  assert.deepEqual(items[0].content, [{ type: 'input_text', text: 'hi' }]);
});

test('buildResponsesBody: tool turns become function_call + function_call_output items', () => {
  const body = buildResponsesBody(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_9', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
      },
      { role: 'tool', tool_call_id: 'call_9', name: 'read_file', content: 'content of a.ts' },
    ],
    [],
    'm',
  );
  const items = body.input as {
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
  }[];
  assert.equal(items[0].type, 'function_call');
  assert.equal(items[0].call_id, 'call_9');
  assert.equal(items[0].name, 'read_file');
  assert.equal(items[0].arguments, '{"path":"a.ts"}');
  assert.equal(items[1].type, 'function_call_output');
  assert.equal(items[1].call_id, 'call_9');
  assert.equal(items[1].output, 'content of a.ts');
});

test('assistantFromResponsesOutput: message text becomes content', () => {
  const msg = assistantFromResponsesOutput([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello there' }],
    },
  ]);
  assert.equal(msg.content, 'Hello there');
  assert.ok(!msg.tool_calls);
});

test('assistantFromResponsesOutput: function_call items become flat tool_calls', () => {
  const msg = assistantFromResponsesOutput([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'checking…' }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_42',
      name: 'list_dir',
      arguments: '{"path":"."}',
    },
  ]);
  assert.equal(msg.content, null, 'content nulled when tools are present');
  assert.equal(msg.tool_calls!.length, 1);
  assert.equal(msg.tool_calls![0].id, 'call_42', 'call_id preferred over item id');
  assert.equal(msg.tool_calls![0].name, 'list_dir');
  assert.equal(msg.tool_calls![0].arguments, '{"path":"."}');
});

test('applyResponsesEvent: output_text.delta streams text', () => {
  const state = createResponsesStreamState();
  const tokens: string[] = [];
  applyResponsesEvent(
    state,
    { type: 'response.output_text.delta', delta: 'Hel' },
    (f) => {
      if (f.type === 'text') tokens.push(f.text!);
    },
  );
  applyResponsesEvent(
    state,
    { type: 'response.output_text.delta', delta: 'lo' },
    () => {},
  );
  assert.equal(state.content, 'Hello');
  assert.deepEqual(tokens, ['Hel']);
});

test('applyResponsesEvent: function call args accumulate by item id', () => {
  const state = createResponsesStreamState();
  const argsFrags: string[] = [];
  applyResponsesEvent(
    state,
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'fc_7',
        call_id: 'call_99',
        name: 'list_dir',
      },
    },
    () => {},
  );
  applyResponsesEvent(
    state,
    { type: 'response.function_call_arguments.delta', item_id: 'fc_7', delta: '{"pat' },
    (f) => {
      if (f.type === 'tool_args') argsFrags.push(f.delta!);
    },
  );
  applyResponsesEvent(
    state,
    { type: 'response.function_call_arguments.done', item_id: 'fc_7', arguments: '{"path":"."}' },
    () => {},
  );
  const entry = state.callMap.get('fc_7')!;
  assert.equal(entry.call_id, 'call_99', 'real call_id preserved for tool outputs');
  assert.equal(entry.name, 'list_dir');
  assert.equal(entry.args, '{"path":"."}');
  assert.deepEqual(argsFrags, ['{"pat']);
});

test('applyResponsesEvent: completed captures the authoritative response', () => {
  const state = createResponsesStreamState();
  applyResponsesEvent(
    state,
    { type: 'response.completed', response: { output: [{ type: 'message' }] } },
    () => {},
  );
  assert.deepEqual(state.finalResponse.output, [{ type: 'message' }]);
});

test('userAgentFor: agentrouter gets its gateway-approved UA, others get AstroCode', () => {
  assert.equal(userAgentFor('agentrouter'), 'opencode/0.2');
  assert.equal(userAgentFor(undefined, 'https://agentrouter.org/v1'), 'opencode/0.2');
  assert.equal(userAgentFor('openai'), 'astrocode/1.2.0');
  assert.equal(userAgentFor('tokenrouter'), 'astrocode/1.2.0');
});

test('shouldRetryStatus: only transient failures retry', () => {
  assert.equal(shouldRetryStatus(200), false);
  assert.equal(shouldRetryStatus(400), false);
  assert.equal(shouldRetryStatus(404), false);
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(408), true);
  assert.equal(shouldRetryStatus(500), true);
  assert.equal(shouldRetryStatus(502), true);
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(504), true);
});

test('retryDelayMs: honors Retry-After seconds and exponential backoff', () => {
  assert.equal(retryDelayMs(429, '5', 0), 5000);
  // No header → exponential backoff, capped.
  assert.equal(retryDelayMs(503, null, 0), 500);
  assert.equal(retryDelayMs(503, null, 1), 1000);
  assert.equal(retryDelayMs(503, null, 2), 2000);
  assert.equal(retryDelayMs(503, null, 10), 4000, 'capped');
  // Absurd Retry-After is capped.
  assert.equal(retryDelayMs(429, '3600', 0), 30_000);
});

test('applyResponsesEvent: failed events throw', () => {
  const state = createResponsesStreamState();
  assert.throws(
    () =>
      applyResponsesEvent(
        state,
        { type: 'response.failed', error: { message: 'upstream down' } },
        () => {},
      ),
    /upstream down/,
  );
  assert.throws(
    () => applyResponsesEvent(state, { type: 'error', message: 'boom' }, () => {}),
    /boom/,
  );
});

// ---- listModels / parseModelsResponse (the 'OpenAI Compatible' /login flow) ----

test('parseModelsResponse: OpenAI { data: [{ id }] } shape', () => {
  assert.deepEqual(
    parseModelsResponse({ data: [{ id: 'm2' }, { id: 'm1' }] }),
    ['m2', 'm1'],
  );
});

test('parseModelsResponse: gateway variants — bare array, { models }, name/model fields', () => {
  assert.deepEqual(parseModelsResponse(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parseModelsResponse({ models: [{ id: 'x' }] }), ['x']);
  assert.deepEqual(parseModelsResponse({ data: [{ name: 'n1' }, { model: 'n2' }] }), ['n1', 'n2']);
});

test('parseModelsResponse: dedupes and drops empty/non-string entries', () => {
  assert.deepEqual(
    parseModelsResponse({ data: [{ id: 'a' }, { id: 'a' }, {}, { id: '' }, 42, null] }),
    ['a'],
  );
});

test('parseModelsResponse: garbage payloads yield an empty list', () => {
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse('nope'), []);
  assert.deepEqual(parseModelsResponse({ data: 'not-an-array' }), []);
});

test('listModels: fetches, parses, and requires no key for local endpoints', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'llama3.1' }, { id: 'qwen2.5' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await listModels(`http://127.0.0.1:${port}/v1`);
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['llama3.1', 'qwen2.5']);
    assert.equal(result.error, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('listModels: connection refused → ok:false with a helpful error', async () => {
  // Port 1 on loopback is reliably closed — the fetch fails fast.
  const result = await listModels('http://127.0.0.1:1/v1', undefined, 2000);
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, []);
  assert.match(result.error ?? '', /Could not reach/);
});

test('listModels: HTTP 401 surfaces the status code', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"bad key"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await listModels(`http://127.0.0.1:${port}/v1`, 'wrong-key');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /HTTP 401/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalize, looksLike, extractMeta, roleForType } from '../src/formats/vscode-transcript.js';
import { parseLines } from '../src/parse.js';
import { syntheticLines, syntheticStatsLines, at } from './fixtures.js';

test('looksLike detects a transcript sample and rejects other JSONL', () => {
  assert.equal(looksLike('{"type":"session.start","data":{}}'), true);
  assert.equal(looksLike('{"kind":0,"v":{"version":3}}'), false);
  assert.equal(looksLike(''), false);
});

test('roleForType separates conversation from bookkeeping and tools', () => {
  assert.equal(roleForType('user.message'), 'user');
  assert.equal(roleForType('assistant.message'), 'assistant');
  assert.equal(roleForType('assistant.turn_start'), 'assistant');
  assert.equal(roleForType('tool.execution_start'), 'tool');
  assert.equal(roleForType('brand.new.event'), 'system');
});

test('normalize maps every known event type', () => {
  const user = normalize(
    JSON.stringify({ type: 'user.message', data: { content: 'hello', attachments: [] }, timestamp: '2026-01-01T00:00:00Z' }),
    0
  );
  assert.equal(user.role, 'user');
  assert.equal(user.text, 'hello');
  assert.equal(user.chars, 5);
  assert.equal(user.attachmentCount, 0);

  const assistant = normalize(
    JSON.stringify({
      type: 'assistant.message',
      data: { content: 'ok', reasoningText: 'because', toolRequests: [{ name: 'read_file' }] },
      timestamp: '2026-01-01T00:00:01Z',
    }),
    1
  );
  assert.equal(assistant.reasoningChars, 7);
  assert.equal(assistant.requestCount, 1);
  assert.deepEqual(assistant.requestedTools, ['read_file']);

  const start = normalize(
    JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'grep_search', toolCallId: 'c', arguments: { a: 1 } }, timestamp: '2026-01-01T00:00:02Z' }),
    2
  );
  assert.equal(start.toolName, 'grep_search');
  assert.equal(start.argsChars, JSON.stringify({ a: 1 }).length);
  assert.equal(start.argsTruncated, false);

  const complete = normalize(
    JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 'c', success: false }, timestamp: '2026-01-01T00:00:03Z' }),
    3
  );
  assert.equal(complete.success, false);
});

test('normalize keeps unknown event types instead of dropping them', () => {
  const ev = normalize(
    JSON.stringify({ type: 'future.event', data: { content: 'payload' }, timestamp: '2026-01-01T00:00:00Z' }),
    0
  );
  assert.equal(ev.unknown, true);
  assert.equal(ev.role, 'system');
  assert.equal(ev.text, 'payload');
});

test('normalize returns null for malformed lines', () => {
  assert.equal(normalize('{not json', 0), null);
  assert.equal(normalize('"a string"', 0), null);
});

test('extractMeta reads session.start', () => {
  const parsed = parseLines(syntheticLines());
  const meta = extractMeta(parsed.events);
  assert.equal(meta.sessionId, 'synthetic-session');
  assert.equal(meta.producer, 'copilot-agent');
  assert.equal(meta.copilotVersion, '0.0.0-test');
});

test('parseLines filters by event type and reports parse errors', () => {
  const lines = [...syntheticStatsLines(), '{broken'];
  const all = parseLines(lines);
  assert.equal(all.parseErrors, 1);
  const onlyUser = parseLines(lines, { types: new Set(['user.message']) });
  assert.equal(onlyUser.events.length, 2);
  assert.ok(onlyUser.events.every((e) => e.type === 'user.message'));
});

test('normalize preserves the event order index', () => {
  const parsed = parseLines(syntheticStatsLines());
  const indexes = parsed.events.map((e) => e.i);
  assert.deepEqual(indexes, indexes.slice().sort((a, b) => a - b));
  assert.equal(parsed.events[0].ts, at(0));
});

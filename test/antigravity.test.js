import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as ag from '../src/formats/antigravity-transcript.js';
import * as formats from '../src/formats/index.js';
import { parseLines } from '../src/parse.js';
import { computeStats } from '../src/stats.js';
import { projectLevel } from '../src/search.js';

const T0 = Date.parse('2026-01-05T09:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();

function line(step, source, type, min, extra = {}) {
  return JSON.stringify({
    step_index: step,
    source,
    type,
    status: 'DONE',
    created_at: at(min),
    ...extra,
  });
}

function transcript() {
  return [
    line(0, 'USER_EXPLICIT', 'USER_INPUT', 0, {
      content:
        '<USER_REQUEST>\nList the sandbox directory.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
    }),
    line(1, 'MODEL', 'PLANNER_RESPONSE', 0, {
      thinking: 'thinking hard',
      content: 'Listing now.',
      tool_calls: [
        { name: 'list_dir', args: { DirectoryPath: '"/sandbox"', toolSummary: '"List"' } },
        { name: 'run_command', args: { CommandLine: '"echo hi"' } },
      ],
    }),
    line(2, 'MODEL', 'GENERIC', 0.5, { content: 'Output:\na.txt\n' }),
    line(3, 'MODEL', 'RUN_COMMAND', 1, { content: 'The command exited with code 1.\nOutput:\nboom\n', exit_code: 1 }),
    line(4, 'MODEL', 'PLANNER_RESPONSE', 3, { content: 'All done.', tool_calls: [] }),
    line(5, 'SYSTEM', 'SYSTEM_MESSAGE', 3.5, { content: '<SYSTEM_MESSAGE>noop</SYSTEM_MESSAGE>' }),
  ];
}

test('the antigravity adapter sniffs its own format and not the other one', () => {
  const sample = transcript().join('\n');
  assert.equal(ag.looksLike(sample), true);
  assert.equal(formats.detect(sample)?.FORMAT_ID, 'antigravity-transcript');
});

test('the user request is unwrapped from <USER_REQUEST>', () => {
  const parsed = parseLines(transcript());
  assert.equal(parsed.format, 'antigravity-transcript');
  const user = parsed.events.find((e) => e.role === 'user');
  assert.equal(user.text, 'List the sandbox directory.');
  assert.equal(user.chars, 'List the sandbox directory.'.length);
});

test('tool results are paired with the requests that produced them', () => {
  const parsed = parseLines(transcript());
  const tools = parsed.events.filter((e) => e.role === 'tool');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((e) => e.toolName), ['list_dir', 'run_command']);
  assert.equal(tools[0].toolMs, 30_000);
  assert.equal(tools[1].toolMs, 60_000);
  assert.equal(tools[0].success, true);
  assert.equal(tools[1].success, false, 'exit_code 1 must be a failure');
  assert.ok(tools[1].argsText.includes('echo hi'));
});

test('tool output is parked in observation, never in prose', () => {
  const parsed = parseLines(transcript());
  const tools = parsed.events.filter((e) => e.role === 'tool');
  assert.ok(tools.every((e) => e.text === ''));
  assert.ok(tools.every((e) => e.observation.length > 0));
});

test('an unanswered request does not steal the next result', () => {
  const events = [
    line(0, 'MODEL', 'PLANNER_RESPONSE', 0, {
      content: '',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/a/b.txt"' } }],
    }),
    line(1, 'MODEL', 'VIEW_FILE', 1, { content: 'file body' }),
  ];
  const parsed = parseLines(events);
  assert.equal(parsed.events[1].toolName, 'view_file');
  assert.equal(parsed.events[1].toolMs, 60_000);
});

test('a result with no pending request still becomes a tool event', () => {
  const events = [line(0, 'MODEL', 'GREP_SEARCH', 0, { content: 'hit' })];
  const parsed = parseLines(events);
  assert.equal(parsed.events[0].role, 'tool');
  assert.equal(parsed.events[0].toolName, 'grep_search');
});

test('computeStats understands the antigravity shape', () => {
  const stats = computeStats(parseLines(transcript()));
  assert.equal(stats.format, 'antigravity-transcript');
  assert.equal(stats.counts.humanTurns, 1);
  assert.equal(stats.counts.toolCalls, 2);
  assert.equal(stats.counts.toolFailures, 1);
  assert.equal(stats.counts.toolRequests, 2);
  assert.deepEqual(stats.tools.map((t) => t.name), ['run_command', 'list_dir']);
  assert.equal(stats.text.reasoningChars, 'thinking hard'.length);
  assert.ok(stats.text.observationChars > 0);
  assert.equal(stats.text.assistantChars, 'Listing now.'.length + 'All done.'.length);
});

test('level projection hides and reveals machine traffic', () => {
  const parsed = parseLines(transcript());
  const l1 = projectLevel(parsed.events, 1, 1000);
  assert.deepEqual(l1.map((e) => e.kind), ['user']);

  const l2 = projectLevel(parsed.events, 2, 1000);
  assert.deepEqual(l2.map((e) => e.kind), ['user', 'assistant', 'assistant']);
  assert.ok(!l2.some((e) => e.text.includes('list_dir')));

  const l3 = projectLevel(parsed.events, 3, 1000);
  assert.equal(l3.filter((e) => e.kind === 'tool').length, 2);
  assert.ok(l3.some((e) => e.text.includes('run_command') && e.text.includes('FAILED')));

  const l4 = projectLevel(parsed.events, 4, 1000);
  assert.ok(l4.some((e) => e.text.includes('a.txt')));
});

test('a plain projection marks nothing as a keyword hit', () => {
  const parsed = parseLines(transcript());
  const entries = projectLevel(parsed.events, 3, 1000);
  assert.ok(entries.every((e) => e.matched === false));
});

test('malformed antigravity lines are rejected, not guessed at', () => {
  assert.equal(ag.normalize('{"type":"USER_INPUT"}', 0), null, 'missing step_index');
  assert.equal(ag.normalize('{"step_index":0}', 0), null, 'missing type');
  assert.equal(ag.normalize('not json', 0), null);
});

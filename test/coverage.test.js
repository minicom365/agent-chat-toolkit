import assert from 'node:assert/strict';
import { test } from 'node:test';

import { antigravityTranscript } from '../tools/make-sandbox.mjs';
import { coverageOf, eventWeight, parseTranscriptSet } from '../src/parse.js';
import { parseLines } from '../src/parse.js';
import { logSourcesFor, stepRangeOf } from '../src/hosts/antigravity.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORMAT = 'antigravity-transcript';

/** Write JSONL lines to a temp file and return its path. */
function tmpFile(lines, name = 'log.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agchat-merge-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

function line(step, type, extra = {}) {
  return `${JSON.stringify({
    step_index: step,
    source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
    type,
    status: 'DONE',
    created_at: new Date(Date.UTC(2026, 0, 5, 9, 0, step)).toISOString(),
    ...extra,
  })}\n`;
}

/** A `CLEARED` skeleton entry: the app keeps the step but drops its text. */
function cleared(step, type = 'PLANNER_RESPONSE') {
  return `${JSON.stringify({
    step_index: step,
    source: 'MODEL',
    type,
    status: 'CLEARED',
    created_at: new Date(Date.UTC(2026, 0, 5, 9, 0, step)).toISOString(),
  })}\n`;
}

test('parseTranscriptSet merges disjoint logs into one timeline', async () => {
  const skeleton = tmpFile([cleared(0, 'USER_INPUT'), cleared(4), cleared(8)], 'overview.txt');
  const tail = tmpFile([line(12, 'PLANNER_RESPONSE', { content: 'tail answer' })], 'transcript_full.jsonl');

  const parsed = await parseTranscriptSet(
    [
      { path: tail, kind: 'transcript-full', priority: 4 },
      { path: skeleton, kind: 'overview', priority: 2 },
    ],
    { format: FORMAT }
  );

  assert.equal(parsed.events.length, 4, 'the union of both logs, not just the tail');
  assert.deepEqual(
    parsed.events.map((e) => e.stepIndex),
    [0, 4, 8, 12],
    'merged events stay in step order'
  );
  assert.deepEqual(
    parsed.events.map((e) => e.i),
    [0, 1, 2, 3],
    'indices are renumbered after the merge'
  );
  assert.equal(parsed.coverage.stepSpan.first, 0);
  assert.equal(parsed.coverage.headLostSteps, 0, 'the skeleton still covers the head');
});

test('the richest copy of a duplicated step wins, whatever the source order', async () => {
  const rich = tmpFile([line(4, 'PLANNER_RESPONSE', { content: 'the real answer text' })], 'transcript_full.jsonl');
  const poor = tmpFile([cleared(4)], 'overview.txt');

  for (const order of [
    [
      { path: poor, kind: 'overview', priority: 2 },
      { path: rich, kind: 'transcript-full', priority: 4 },
    ],
    [
      { path: rich, kind: 'transcript-full', priority: 4 },
      { path: poor, kind: 'overview', priority: 2 },
    ],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTranscriptSet(order, { format: FORMAT });
    assert.equal(parsed.events.length, 1, 'the duplicate is collapsed');
    assert.equal(parsed.events[0].text, 'the real answer text');
    assert.equal(parsed.events[0].status, 'DONE');
  }
});

test('a cleared skeleton never displaces real content, even at equal priority', async () => {
  const rich = tmpFile([line(4, 'PLANNER_RESPONSE', { content: 'x'.repeat(120) })], 'a.jsonl');
  const poor = tmpFile([cleared(4)], 'b.jsonl');
  const parsed = await parseTranscriptSet([{ path: poor, priority: 4 }, { path: rich, priority: 1 }], {
    format: FORMAT,
  });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].text.length, 120);
});

test('coverage reports head loss when no log reaches step 0', async () => {
  const tail = tmpFile([line(7000, 'USER_INPUT', { content: '<USER_REQUEST>hi</USER_REQUEST>' }), line(7004, 'PLANNER_RESPONSE', { content: 'ok' })], 'transcript_full.jsonl');
  const parsed = await parseTranscriptSet([{ path: tail, kind: 'transcript-full', priority: 4 }], {
    format: FORMAT,
  });
  assert.equal(parsed.coverage.headLostSteps, 7000, 'the missing head is reported as a step count');
  assert.equal(parsed.coverage.stepSpan.first, 7000);
  assert.equal(parsed.coverage.textSteps, 2);
  assert.equal(parsed.coverage.firstTextStep, 7000);
});

test('coverage separates "steps present" from "steps with text"', async () => {
  const mixed = tmpFile([cleared(0), cleared(4), line(8, 'PLANNER_RESPONSE', { content: 'late answer' })], 'overview.txt');
  const parsed = await parseTranscriptSet([{ path: mixed, kind: 'overview', priority: 2 }], { format: FORMAT });
  assert.equal(parsed.coverage.steps, 3, 'every step is present');
  assert.equal(parsed.coverage.textSteps, 1, 'only one still has text');
  assert.equal(parsed.coverage.firstTextStep, 8);
});

test('eventWeight ranks content above an empty skeleton entry', () => {
  const rich = { text: 'abc', reasoningChars: 10, observationChars: 0, argsText: '', toolName: null, requestCount: 0 };
  const poor = { text: '', reasoningChars: 0, observationChars: 0, argsText: '', toolName: null, requestCount: 0 };
  assert.ok(eventWeight(rich) > eventWeight(poor));
  assert.equal(eventWeight(poor), 0);
});

test('coverageOf counts human chunks and tolerates a format without an order key', () => {
  const cov = coverageOf([{ role: 'user' }, { role: 'assistant' }], { orderKey: null });
  assert.equal(cov.humanChunks, 1);
  assert.equal(cov.stepSpan, null);
  assert.equal(cov.headLostSteps, 0);
});

test('parseLines keeps working unchanged for a single source', () => {
  const parsed = parseLines(
    antigravityTranscript({ id: 'x', ask: 'hi', final: 'bye' }).split('\n').filter(Boolean),
    { format: FORMAT }
  );
  assert.equal(parsed.events[0].role, 'user');
  assert.equal(parsed.coverage, undefined, 'single-source parses carry no coverage object');
});

test('logSourcesFor lists the overview and the transcript, richest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agchat-logs-'));
  const brain = path.join(dir, 'brain');
  const logs = path.join(brain, 'abc', '.system_generated', 'logs');
  fs.mkdirSync(path.join(logs, 'chunks', 'transcript_full'), { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), line(4, 'PLANNER_RESPONSE', { content: 'a' }));
  fs.writeFileSync(path.join(logs, 'overview.txt'), cleared(0));
  fs.writeFileSync(path.join(logs, 'chunks', 'transcript_full', '00000000.jsonl'), line(8, 'PLANNER_RESPONSE', { content: 'b' }));

  const sources = await logSourcesFor(brain, 'abc');
  assert.deepEqual(
    sources.map((s) => s.kind),
    ['transcript-full', 'chunk-full', 'overview'],
    'content beats skeleton, and the overview is always included'
  );
});

test('stepRangeOf reads the first and last step without loading the file', async () => {
  const file = tmpFile([line(0, 'USER_INPUT'), line(4, 'PLANNER_RESPONSE'), line(9999, 'PLANNER_RESPONSE')]);
  const range = await stepRangeOf(file);
  assert.deepEqual(range, { first: 0, last: 9999 });
});

test('stepRangeOf returns null for a file that holds no step lines', async () => {
  const file = tmpFile(['not json\n', '\n'], 'junk.txt');
  assert.equal(await stepRangeOf(file), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLines } from '../src/parse.js';
import { analyzeTiming, timelineOf, capLabel } from '../src/timing.js';
import { syntheticLines, syntheticStatsLines, at } from './fixtures.js';

const SEC = 1000;

function timingOf(lines, opts = {}) {
  const { events } = parseLines(lines);
  return analyzeTiming(events, opts);
}

test('timelineOf sorts by timestamp and keeps the original index', () => {
  const { events } = parseLines(syntheticLines());
  const tl = timelineOf(events);
  assert.equal(tl.length, events.length);
  for (let k = 1; k < tl.length; k += 1) assert.ok(tl[k].ts >= tl[k - 1].ts);
});

test('capped active time is the sum of gaps capped at the threshold', () => {
  const t = timingOf(syntheticLines(), { capMs: 300 * SEC });
  // gaps: 1,0,1,4,2,52,1,0,1,1,1,4936,1,0,1  (seconds)
  // with a 300s cap the 4936s break contributes exactly 300s
  assert.equal(t.span.ms, 5002 * SEC);
  assert.equal(t.active.ms, 366 * SEC);
});

test('active time grows with the cap until the wall-clock span is reached', () => {
  const tight = timingOf(syntheticLines(), { capMs: 10 * SEC });
  const loose = timingOf(syntheticLines(), { capMs: 3600 * SEC });
  const full = timingOf(syntheticLines(), { capMs: 100_000 * SEC });
  assert.equal(tight.active.ms, 34 * SEC); // 66s of short gaps - 52s + 10s cap, + 10s of the break
  assert.equal(loose.active.ms, 3666 * SEC); // 66s + min(4936, 3600)
  assert.equal(full.active.ms, 5002 * SEC); // nothing capped -> equals the span
});

test('sensitivity curve lists every requested cap with its own total', () => {
  const t = timingOf(syntheticLines(), { capsMs: [10 * SEC, 300 * SEC], capMs: 300 * SEC });
  const byCap = Object.fromEntries(t.byCap.map((r) => [r.capMs, r.activeMs]));
  assert.equal(byCap[10 * SEC], 34 * SEC);
  assert.equal(byCap[300 * SEC], 366 * SEC);
  assert.equal(t.byCap.find((r) => r.isDefault).capMs, 300 * SEC);
});

test('gaps are charged to the event that ends them', () => {
  const t = timingOf(syntheticLines(), { capMs: 300 * SEC });
  assert.equal(t.phases.human.raw, (52 + 4936) * SEC);
  assert.equal(t.phases.human.byCap[300 * SEC], (52 + 300) * SEC);
  assert.equal(t.phases.model.raw, 7 * SEC);
  assert.equal(t.phases.tool.raw, 7 * SEC);
  const sum = ['human', 'model', 'tool', 'other'].reduce((a, k) => a + (t.phases[k].raw ?? 0), 0);
  assert.equal(sum, t.span.ms);
});

test('tool runtime is measured by pairing start and complete on toolCallId', () => {
  const t = timingOf(syntheticLines());
  const byName = Object.fromEntries(t.toolRuntime.map((x) => [x.name, x]));
  assert.equal(byName.read_file.ms, 4 * SEC);
  assert.equal(byName.run_in_terminal.ms, 1 * SEC);
  assert.equal(byName.run_in_terminal.failed, 1);
  assert.equal(t.toolRuntimeTotals.ms, 5 * SEC);
});

test('segments pair each human ask with its agent time and think time', () => {
  const t = timingOf(syntheticLines(), { capMs: 300 * SEC });
  assert.equal(t.segments.length, 2);
  const [s1, s2] = t.segments;
  assert.equal(s1.startTs, at(60));
  assert.equal(s1.agentMs, 4 * SEC);
  assert.equal(s1.thinkMs, 4936 * SEC);
  assert.equal(s1.agentCappedMs, 4 * SEC);
  assert.equal(s1.thinkCappedMs, 300 * SEC);
  assert.equal(s1.toolCalls, 1);
  assert.equal(s2.agentMs, 2 * SEC);
  assert.equal(s2.thinkMs, 0);
  assert.equal(s2.prompt, 'third ask after a long break');
});

test('breaks are reported above the break threshold, longest first', () => {
  const t = timingOf(syntheticLines(), { breakMs: 30 * 60 * SEC });
  assert.equal(t.breakCount, 1);
  assert.equal(t.breaks[0].ms, 4936 * SEC);
  assert.equal(t.breaks[0].resumedWith, 'third ask after a long break');
});

test('per-day buckets split a multi-day session', () => {
  const { events } = parseLines(syntheticStatsLines());
  const t = analyzeTiming(events, { capMs: 5 * 60 * SEC });
  assert.equal(t.days.length, 1);
  assert.equal(t.days[0].humanTurns, 2);
  assert.equal(t.days[0].toolCalls, 2);
  assert.ok(t.days[0].activeMs > 0);
});

test('events without timestamps are counted but excluded from timing', () => {
  const lines = [
    JSON.stringify({ type: 'user.message', data: { content: 'x' }, timestamp: 'not-a-date', id: 'a', parentId: null }),
    JSON.stringify({ type: 'user.message', data: { content: 'y' }, timestamp: new Date(at(1)).toISOString(), id: 'b', parentId: null }),
  ];
  const { events } = parseLines(lines);
  const t = analyzeTiming(events);
  assert.equal(t.eventCount, 2);
  assert.equal(t.undatedEvents, 1);
  assert.equal(t.span.ms, 0);
});

test('capLabel renders human readable caps', () => {
  assert.equal(capLabel(30_000), '30s');
  assert.equal(capLabel(300_000), '5m');
  assert.equal(capLabel(1_500), '1500ms');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLines } from '../src/parse.js';
import { computeStats, countWords, sanityWarnings } from '../src/stats.js';
import { syntheticStatsLines, syntheticLines } from './fixtures.js';

const statsOf = (lines, opts) => computeStats(parseLines(lines), opts);

test('counts separate human turns, agent output and tool round-trips', () => {
  const s = statsOf(syntheticStatsLines());
  assert.equal(s.counts.humanTurns, 2);
  assert.equal(s.counts.assistantMessages, 1);
  // no assistant.turn_start in this fixture, so agent segments fall back to the
  // number of assistant messages (formats without an explicit turn marker)
  assert.equal(s.counts.agentSegments, 1);
  assert.equal(s.counts.toolCalls, 2);
  assert.equal(s.counts.toolFailures, 1);
  assert.equal(s.counts.toolRequests, 2);
  assert.equal(s.counts.uniqueTools, 2);
  assert.equal(s.counts.events, 8);
  assert.equal(s.counts.sessions, 1);
});

test('ratios expose how much traffic is machine generated', () => {
  const s = statsOf(syntheticStatsLines());
  assert.equal(s.ratios.toolCallsPerHumanTurn, 1);
  assert.equal(s.ratios.assistantPerHumanTurn, 0.5);
  assert.equal(s.ratios.toolFailureRate, 0.5);
  assert.equal(s.ratios.machineLineShare, 0.5);
});

test('text volume separates prose from machine arguments and reasoning', () => {
  const s = statsOf(syntheticLines());
  assert.equal(s.text.userChars, 'second ask'.length + 'third ask after a long break'.length);
  assert.equal(s.text.assistantChars, 'first reply'.length + 'second reply'.length + 'third reply'.length);
  assert.equal(s.text.reasoningChars, 'thinking about the first reply'.length);
  assert.ok(s.text.toolArgsChars > 0);
});

test('tool table is sorted by call count then measured runtime', () => {
  const s = statsOf(syntheticStatsLines());
  assert.deepEqual(s.tools.map((t) => t.name), ['read_file', 'grep_search']);
  assert.equal(s.tools[0].ms, 6000);
  assert.equal(s.tools[0].failed, 1);
  assert.equal(s.tools[0].failRate, 1);
  assert.equal(s.tools[1].failed, 0);
  assert.deepEqual(
    s.requestedTools.map((r) => r.name).sort(),
    ['grep_search', 'read_file']
  );
});

test('sanity warnings flag empty and untimed transcripts', () => {
  const empty = computeStats(parseLines([]));
  assert.ok(sanityWarnings(empty).some((w) => w.includes('No human-authored events')));
  const broken = parseLines([...syntheticStatsLines(), '{oops']);
  const s = computeStats(broken);
  assert.ok(sanityWarnings(s).some((w) => w.includes('could not be parsed')));
});

test('countWords handles latin and CJK without whitespace', () => {
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('안녕하세요'), 5);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('byType is sorted by frequency', () => {
  const s = statsOf(syntheticStatsLines());
  for (let k = 1; k < s.byType.length; k += 1) assert.ok(s.byType[k - 1].n >= s.byType[k].n);
  assert.equal(s.byType[0].n, 2);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFilter, grepHaystack, previewOf, queryEvents, toRows } from '../src/query.js';
import { parseLines } from '../src/parse.js';
import { parseArgs, parseDuration } from '../src/cli.js';
import { exportCsv, exportJson, exportMarkdown, renderQuery, renderStats } from '../src/render.js';
import { computeStats } from '../src/stats.js';
import { makeStyler, parseTimeArg, table, truncate } from '../src/util.js';
import { syntheticLines, syntheticStatsLines, at } from './fixtures.js';

const evOf = (lines) => parseLines(lines).events;
const STATS = computeStats(parseLines(syntheticLines()));
const NO_COLOR = makeStyler(false);

test('filter by type, role, tool and time window', () => {
  const events = evOf(syntheticLines());
  assert.equal(queryEvents(events, { type: ['user.message'] }).length, 2);
  assert.equal(queryEvents(events, { role: ['tool'] }).length, 4);
  assert.ok(queryEvents(events, { tool: ['read_file'] }).every((e) => e.toolName === 'read_file'));
  assert.equal(queryEvents(events, { since: at(100), until: at(6000) }).length, 4);
  assert.equal(queryEvents(events, { type: 'user.message', limit: 1 }).length, 1);
});

test('grep searches the requested haystack', () => {
  const events = evOf(syntheticLines());
  assert.equal(queryEvents(events, { grep: 'echo hi', grepScope: 'args' }).length, 1);
  assert.equal(queryEvents(events, { grep: 'echo hi', grepScope: 'content' }).length, 0);
  assert.equal(queryEvents(events, { grep: 'first reply', grepScope: 'content' }).length, 1);
  assert.equal(queryEvents(events, { grep: 'nope' }).length, 0);
  const toolEvent = events.find((e) => e.toolName === 'run_in_terminal');
  assert.ok(grepHaystack(toolEvent, 'args').includes('echo'));
  assert.ok(grepHaystack(toolEvent, 'tool').includes('run_in_terminal'));
});

test('buildFilter AND-combines every predicate', () => {
  const events = evOf(syntheticLines());
  const match = buildFilter({ type: ['assistant.message'], grep: 'reply' });
  const hits = events.filter(match);
  assert.equal(hits.length, 3);
  assert.ok(hits.every((e) => e.type === 'assistant.message' && e.text.includes('reply')));
});

test('preview collapses whitespace and truncates', () => {
  assert.equal(previewOf({ text: 'a\n\n  b' }), 'a b');
  assert.ok(previewOf({ text: 'x'.repeat(500) }, 20).endsWith('…'));
  assert.equal(previewOf({}), '');
});

test('toRows exposes both UTC and local stamps', () => {
  const [row] = toRows(evOf(syntheticLines()));
  assert.equal(row.time, new Date(at(0)).toISOString());
  assert.match(row.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('parseArgs understands commands, filters and durations', () => {
  const { command, opts, errors } = parseArgs([
    'query',
    '--type',
    'user.message,assistant.message',
    '--tool',
    'read_file',
    '--grep',
    'foo',
    '--cap',
    '2m',
    '--index',
    '10:20',
    '--json',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(command, 'query');
  assert.deepEqual(opts.type, ['user.message', 'assistant.message']);
  assert.deepEqual(opts.tool, ['read_file']);
  assert.equal(opts.grep, 'foo');
  assert.equal(opts.capMs, 120_000);
  assert.equal(opts.fromIndex, 10);
  assert.equal(opts.toIndex, 20);
  assert.equal(opts.json, true);
});

test('parseArgs defaults to stats and reports unknown options', () => {
  assert.equal(parseArgs([]).command, 'stats');
  assert.equal(parseArgs(['--latest']).opts.latest, true);
  const bad = parseArgs(['stats', '--nope']);
  assert.equal(bad.errors.length, 1);
});

test('parseDuration and parseTimeArg accept the documented syntax', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('90m'), 5_400_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('x', [], '--cap'), null);
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(parseTimeArg('2h', now), now - 7_200_000);
  assert.equal(parseTimeArg('2026-01-01', now), Date.parse('2026-01-01T00:00:00'));
  assert.equal(parseTimeArg('', now), null);
});

test('renderers produce non-empty plain output without ANSI when disabled', () => {
  const out = renderStats(STATS, { styler: NO_COLOR, warnings: [] });
  assert.ok(out.includes('human turns'));
  assert.ok(out.includes('Effective development time'));
  assert.ok(!out.includes('\u001b['), 'no ANSI escapes when colour is disabled');
  assert.ok(renderQuery(evOf(syntheticLines()), { styler: NO_COLOR }).includes('user.message'));
  assert.equal(renderQuery([], { styler: NO_COLOR }), 'No events matched.');
});

test('exports round-trip through json, csv and markdown', () => {
  const json = JSON.parse(exportJson(STATS));
  assert.equal(json.counts.humanTurns, 2);
  const csv = exportCsv(evOf(syntheticStatsLines()));
  assert.ok(csv.startsWith('index,timestamp,type,role,tool'));
  assert.equal(csv.split('\r\n').length, 9); // header + 8 events
  const md = exportMarkdown(STATS);
  assert.ok(md.startsWith('# Transcript report'));
  assert.ok(md.includes('| human turns | 2 |'));
});

test('table and truncate respect CJK double-width characters', () => {
  const out = table(['a', 'b'], [['안녕', 'x'], ['ab', 'y']]);
  const lines = out.split('\n');
  assert.equal(lines[1].split('  ')[0].length, 4); // '안녕' measured as width 4
  assert.equal(truncate('안녕하세요', 4), '안…');
  assert.equal(truncate('abc', 10), 'abc');
});

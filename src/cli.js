import fsp from 'node:fs/promises';
import path from 'node:path';

import { findTranscriptFiles, listTranscripts, userDataDirs } from './discover.js';
import { parseTranscript } from './parse.js';
import { computeStats, sanityWarnings } from './stats.js';
import { DEFAULT_BREAK_MS, DEFAULT_CAP_MS, analyzeTiming, capLabel } from './timing.js';
import { buildFilter, queryEvents } from './query.js';
import {
  exportCsv,
  exportJson,
  exportMarkdown,
  renderList,
  renderQuery,
  renderSegments,
  renderStats,
  renderTime,
  renderTimeline,
  renderTools,
} from './render.js';
import * as adapter from './formats/vscode-transcript.js';
import { DAY, HOUR, MIN, SEC, makeStyler, parseTimeArg } from './util.js';

export const VERSION = '0.1.0';

const HELP = `copilot-transcript-stats ${VERSION}
Analyse VS Code Copilot Chat agent transcripts (JSONL).

USAGE
  transcript-stats <command> [options]

COMMANDS
  list        discover transcripts on this machine
  stats       conversation statistics + effective development time (default)
  time        effective development time detail (incl. breaks, per-day)
  tools       tool usage breakdown
  segments    one row per human turn (agent time / think time / tool calls)
  timeline    raw chronological event list
  query       filter events (by type / role / tool / time / text)
  export      dump stats or events as json | md | csv
  formats     list registered format adapters
  paths       print the directories searched for transcripts
  help        this text

SELECTING A TRANSCRIPT
  -f, --file <path|sessionId|prefix>   explicit file, session id, or unique prefix
      --latest                         most recently modified transcript (default)
      --all                            aggregate every discovered transcript
      --root <dir>                     extra user-data dir to search (repeatable)

FILTERS (query / timeline / export)
      --type <t>          event type, repeatable / comma separated
      --role <r>          user | assistant | tool | system
      --tool <name>       tool name (tool.execution_start only)
      --grep <regex>      case-insensitive by default
      --grep-scope <s>    content (default) | args | tool | all
      --since <when>      ISO date, epoch ms, or relative (90m, 2h, 3d)
      --until <when>      same syntax as --since
      --index <a:b>       inclusive normalised event index range

TIME MODEL
      --cap <dur>         silence counted as work, per gap (default 5m)
      --break <dur>       gap reported as a break (default 30m)
      --caps <list>       override the sensitivity curve, e.g. 30s,1m,5m,30m

OUTPUT
      --json              machine readable output
      --md                markdown output (export defaults per command)
      --out <file>        write to a file instead of stdout
      --limit <n>         cap the number of rows / events
      --no-color          disable ANSI colours
      --explain           print the assumptions behind the numbers
`;

export async function main(argv) {
  const { command, opts, errors } = parseArgs(argv);
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n\n${HELP}`);
    return 1;
  }
  if (opts.help || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const color = opts.color !== false && process.stdout.isTTY;
  const st = makeStyler(color);

  switch (command) {
    case 'list':
      return cmdList(opts, st);
    case 'paths':
      return cmdPaths();
    case 'formats':
      return cmdFormats(st);
    case 'stats':
    case 'time':
    case 'tools':
    case 'segments':
    case 'timeline':
    case 'query':
    case 'export':
      return cmdAnalysis(command, opts, st);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

/* --------------------------------------------------------------- commands */

async function cmdList(opts, st) {
  const rows = await listTranscripts({ roots: opts.root, filter: opts.filter });
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  if (opts.json) {
    return writeOut(JSON.stringify(limited, null, 2), opts);
  }
  return writeOut(renderList(limited, { styler: st, total: rows.length }), opts);
}

function cmdPaths() {
  return writeOut(userDataDirs().join('\n'), {});
}

function cmdFormats(st) {
  const lines = [
    st.bold('Format adapters'),
    `${st.cyan('vscode-transcript')}  ${adapter.FORMAT_DESCRIPTION}`,
    '',
    st.gray('Known event types: ' + adapter.knownTypes().join(', ')),
    st.gray('Unknown event types are preserved and reported, never dropped.'),
  ];
  return writeOut(lines.join('\n'), {});
}

async function cmdAnalysis(command, opts, st) {
  const targets = await resolveTargets(opts);
  if (!targets.length) {
    process.stderr.write(
      'No transcript found. Run `transcript-stats list` or pass --file/--root.\n'
    );
    return 1;
  }

  if (command === 'export') return cmdExport(targets, opts);

  const needsEvents = command === 'timeline' || command === 'query';
  const analyses = [];
  const allEvents = [];
  for (const file of targets) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTranscript(file, { keepData: false });
    if (needsEvents) allEvents.push(...parsed.events);
    // eslint-disable-next-line no-await-in-loop
    analyses.push(computeStats(parsed, timingOpts(opts)));
  }
  const stats = analyses.length === 1 ? analyses[0] : mergeStats(analyses);

  if (needsEvents && opts.json) {
    const events =
      command === 'query'
        ? queryEvents(allEvents, { ...filterOpts(opts), limit: opts.limit || 500 })
        : allEvents;
    return writeOut(JSON.stringify(events, null, 2), opts);
  }

  if (opts.json) return writeOut(JSON.stringify(stats, null, 2), opts);

  switch (command) {
    case 'stats': {
      const warnings = analyses.flatMap((s) => sanityWarnings(s));
      return writeOut(renderStats(stats, { styler: st, warnings }), opts);
    }
    case 'time':
      return writeOut(renderTime(stats.timing, { styler: st }), opts);
    case 'tools':
      return writeOut(renderTools(stats, { styler: st }), opts);
    case 'segments':
      return writeOut(renderSegments(stats.timing, { styler: st, limit: opts.limit || 50 }), opts);
    case 'timeline':
      return writeOut(
        renderTimeline(allEvents, { styler: st, limit: opts.limit || 200 }),
        opts
      );
    case 'query': {
      const events = queryEvents(allEvents, {
        ...filterOpts(opts),
        limit: opts.limit || 500,
      });
      return writeOut(renderQuery(events, { styler: st }), opts);
    }
    default:
      return 1;
  }
}

async function cmdExport(targets, opts) {
  const format = opts.format ?? (opts.json ? 'json' : opts.csv ? 'csv' : 'md');
  const chunks = [];
  for (const file of targets) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTranscript(file, { keepData: false });
    if (format === 'csv') {
      chunks.push(exportCsv(parsed.events));
    } else if (format === 'json') {
      const stats = computeStats(parsed, timingOpts(opts));
      chunks.push(exportJson(stats));
    } else {
      const stats = computeStats(parsed, timingOpts(opts));
      chunks.push(exportMarkdown(stats));
    }
  }
  return writeOut(chunks.join('\n'), opts);
}

/* ------------------------------------------------------------- resolution */

async function resolveTargets(opts) {
  if (opts.file) {
    const direct = path.resolve(String(opts.file));
    try {
      const stat = await fsp.stat(direct);
      if (stat.isFile()) return [direct];
    } catch {
      /* fall through to prefix matching */
    }
    const rows = await listTranscripts({ roots: opts.root });
    const needle = String(opts.file).toLowerCase();
    const matches = rows.filter(
      (r) =>
        r.name.toLowerCase().startsWith(needle) ||
        (r.sessionId ?? '').toLowerCase().startsWith(needle) ||
        r.file.toLowerCase().includes(needle)
    );
    if (matches.length === 1) return [matches[0].file];
    if (matches.length > 1) {
      const names = matches.map((m) => `  ${m.name.slice(0, 8)}  ${m.firstTimestamp ? new Date(m.firstTimestamp).toISOString() : ''}  ${m.file}`).join('\n');
      throw new Error(`--file matched ${matches.length} transcripts:\n${names}`);
    }
    throw new Error(`No transcript matched --file ${opts.file}`);
  }

  if (opts.all) {
    const files = await findTranscriptFiles({ roots: opts.root });
    const ok = [];
    for (const f of files) {
      // Cheap guard: a transcript's first bytes must contain a known event type.
      // eslint-disable-next-line no-await-in-loop
      const head = await readHead(f.file, 4096);
      if (adapter.looksLike(head)) ok.push(f.file);
    }
    return ok;
  }

  const rows = await listTranscripts({ roots: opts.root, limit: 1 });
  if (!rows.length) return [];
  return [rows[0].file];
}

async function readHead(file, bytes) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close();
  }
}

/* ---------------------------------------------------------------- merging */

function mergeStats(list) {
  const base = JSON.parse(JSON.stringify(list[0]));
  base.file = `${list.length} transcripts`;
  base.tools = [];
  base.requestedTools = [];
  base.byType = [];
  base.top = { prompts: [], replies: [], toolArgs: [] };

  const toolMap = new Map();
  const reqMap = new Map();
  const typeMap = new Map();

  for (const s of list) {
    for (const k of ['humanTurns', 'assistantMessages', 'agentSegments', 'toolCalls', 'toolFailures', 'toolRequests', 'events', 'sessions']) {
      base.counts[k] = (base.counts[k] ?? 0) + (s.counts[k] ?? 0);
    }
    base.counts.undatedEvents += s.counts.undatedEvents ?? 0;
    base.parseErrors += s.parseErrors;
    base.totalLines += s.totalLines;
    base.bytes += s.bytes;
    for (const k of Object.keys(base.text)) base.text[k] += s.text[k] ?? 0;
    for (const t of s.tools) {
      const cur = toolMap.get(t.name) ?? { name: t.name, calls: 0, failed: 0, argsChars: 0, ms: 0, timed: 0 };
      cur.calls += t.calls;
      cur.failed += t.failed;
      cur.argsChars += t.argsChars;
      cur.ms += t.ms;
      cur.timed += t.timed;
      toolMap.set(t.name, cur);
    }
    for (const r of s.requestedTools) reqMap.set(r.name, (reqMap.get(r.name) ?? 0) + r.n);
    for (const b of s.byType) typeMap.set(b.type, (typeMap.get(b.type) ?? 0) + b.n);
  }

  base.tools = [...toolMap.values()]
    .map((t) => ({ ...t, failRate: t.calls ? t.failed / t.calls : 0 }))
    .sort((a, b) => b.calls - a.calls || b.ms - a.ms);
  base.requestedTools = [...reqMap.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  base.byType = [...typeMap.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
  base.counts.uniqueTools = base.tools.length;

  const c = base.counts;
  base.ratios = {
    agentSegmentsPerHumanTurn: c.humanTurns ? c.agentSegments / c.humanTurns : 0,
    toolCallsPerHumanTurn: c.humanTurns ? c.toolCalls / c.humanTurns : 0,
    assistantPerHumanTurn: c.humanTurns ? c.assistantMessages / c.humanTurns : 0,
    toolFailureRate: c.toolCalls ? c.toolFailures / c.toolCalls : 0,
    machineLineShare: c.events
      ? (typeMap.get('tool.execution_start') +
          typeMap.get('tool.execution_complete') +
          typeMap.get('assistant.turn_start') +
          typeMap.get('assistant.turn_end')) /
        c.events
      : 0,
  };

  // Sum effective time across sessions: each session keeps its own wall clock.
  const t = base.timing;
  t.span = { first: Math.min(...list.map((s) => s.timing.span.first ?? Infinity)), last: Math.max(...list.map((s) => s.timing.span.last ?? -Infinity)), ms: 0 };
  t.span.ms = Math.max(0, t.span.last - t.span.first);
  for (const s of list) {
    t.active.ms += s.timing.active.ms;
    for (const r of t.byCap) {
      const src = s.timing.byCap.find((x) => x.capMs === r.capMs);
      if (src) r.activeMs += src.activeMs;
    }
  }
  for (const r of t.byCap) {
    r.idleMs = Math.max(0, list.reduce((a, s) => a + s.timing.span.ms, 0) - r.activeMs);
    const denom = list.reduce((a, s) => a + s.timing.span.ms, 0);
    r.ratio = denom ? r.activeMs / denom : 0;
  }
  t.active.ratio = t.span.ms ? t.active.ms / t.span.ms : 0;
  t.days = list.flatMap((s) => s.timing.days).sort((a, b) => a.day.localeCompare(b.day));
  t.activeDayCount = new Set(t.days.map((d) => d.day)).size;
  t.segments = [];
  t.breaks = [];
  t.gaps = [];
  t.phases = null;
  t.toolRuntime = [];
  t.toolRuntimeTotals = {
    calls: list.reduce((a, s) => a + (s.timing.toolRuntimeTotals?.calls ?? 0), 0),
    failed: list.reduce((a, s) => a + (s.timing.toolRuntimeTotals?.failed ?? 0), 0),
    ms: list.reduce((a, s) => a + (s.timing.toolRuntimeTotals?.ms ?? 0), 0),
  };
  t.breakCount = list.reduce((a, s) => a + (s.timing.breakCount ?? 0), 0);
  t.notes = ['Aggregated across transcripts: per-session capped active time is summed.'];
  return base;
}

/* ----------------------------------------------------------- arg parsing */

function timingOpts(opts) {
  return {
    capMs: opts.capMs ?? DEFAULT_CAP_MS,
    breakMs: opts.breakMs ?? DEFAULT_BREAK_MS,
    capsMs: opts.capsMs ?? undefined,
  };
}

function filterOpts(opts) {
  return {
    type: opts.type,
    role: opts.role,
    tool: opts.tool,
    grep: opts.grep,
    grepScope: opts.grepScope,
    since: opts.since,
    until: opts.until,
  };
}

export function parseArgs(argv) {
  const opts = {};
  const errors = [];
  let command = null;
  const args = argv.slice();

  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    const take = (name) => {
      if (k + 1 >= args.length) {
        errors.push(`Missing value for ${name}`);
        return null;
      }
      k += 1;
      return args[k];
    };
    switch (a) {
      case '-f':
      case '--file':
        opts.file = take(a);
        break;
      case '--root':
      case '--dir':
        opts.root = opts.root ?? [];
        opts.root.push(take(a));
        break;
      case '--latest':
        opts.latest = true;
        break;
      case '--all':
        opts.all = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--md':
      case '--markdown':
        opts.md = true;
        break;
      case '--csv':
        opts.csv = true;
        break;
      case '--format':
        opts.format = take(a);
        break;
      case '--out':
      case '-o':
        opts.out = take(a);
        break;
      case '--limit':
      case '-n':
        opts.limit = Number(take(a)) || 0;
        break;
      case '--cap':
        opts.capMs = parseDuration(take(a), errors, '--cap');
        break;
      case '--break':
        opts.breakMs = parseDuration(take(a), errors, '--break');
        break;
      case '--caps':
        opts.capsMs = String(take(a) ?? '')
          .split(',')
          .map((s) => parseDuration(s.trim(), errors, '--caps'))
          .filter((n) => n != null && n > 0);
        break;
      case '--grep':
        opts.grep = take(a);
        break;
      case '--grep-scope':
        opts.grepScope = take(a);
        break;
      case '--type':
        opts.type = pushCsv(opts.type, take(a));
        break;
      case '--role':
        opts.role = pushCsv(opts.role, take(a));
        break;
      case '--tool':
        opts.tool = pushCsv(opts.tool, take(a));
        break;
      case '--since':
        opts.since = parseTimeArg(take(a));
        break;
      case '--until':
        opts.until = parseTimeArg(take(a));
        break;
      case '--index': {
        const v = String(take(a) ?? '');
        const m = /^(\d+)?\s*:\s*(\d+)?$/.exec(v);
        if (m) {
          opts.fromIndex = m[1] ? Number(m[1]) : 0;
          opts.toIndex = m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
        } else {
          errors.push(`--index expects a:b, got "${v}"`);
        }
        break;
      }
      case '--filter':
        opts.filter = take(a);
        break;
      case '--no-color':
        opts.color = false;
        break;
      case '--explain':
        opts.explain = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v':
        if (!command) command = 'version';
        break;
      default:
        if (a.startsWith('--') || a.startsWith('-')) {
          errors.push(`Unknown option: ${a}`);
        } else if (!command) {
          command = a;
        } else {
          errors.push(`Unexpected argument: ${a}`);
        }
    }
  }

  return { command: command ?? 'stats', opts, errors };
}

function pushCsv(cur, value) {
  const v = String(value ?? '');
  const list = Array.isArray(cur) ? cur : cur ? [cur] : [];
  return [...list, ...v.split(',').map((s) => s.trim()).filter(Boolean)];
}

export function parseDuration(value, errors = [], label = 'duration') {
  const s = String(value ?? '').trim();
  const re = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;
  const m = re.exec(s);
  if (!m) {
    errors.push(`${label}: cannot parse duration "${s}"`);
    return null;
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mult = { ms: 1, s: SEC, m: MIN, h: HOUR, d: DAY }[unit];
  return Math.round(n * mult);
}

/* ------------------------------------------------------------------ output */

async function writeOut(text, opts) {
  if (opts.out) {
    await fsp.writeFile(opts.out, text, 'utf8');
    process.stderr.write(`wrote ${path.resolve(opts.out)}\n`);
    return 0;
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

export { capLabel, buildFilter, analyzeTiming };

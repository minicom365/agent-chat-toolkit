import fsp from 'node:fs/promises';
import path from 'node:path';

import { findTranscriptFiles, listTranscripts, userDataDirs } from './discover.js';
import { parseTranscript, parseTranscriptSet, readHead } from './parse.js';
import { computeStats, sanityWarnings } from './stats.js';
import { DEFAULT_BREAK_MS, DEFAULT_CAP_MS, analyzeTiming, capLabel } from './timing.js';
import { buildFilter, queryEvents } from './query.js';
import {
  exportCsv,
  exportJson,
  exportMarkdown,
  renderHosts,
  renderMovePlan,
  renderQuery,
  renderSearchResults,
  renderSegments,
  renderSessions,
  renderStats,
  renderTime,
  renderTimeline,
  renderTools,
} from './render.js';
import { detect, formatList } from './formats/index.js';
import { HOSTS, allSessions, findSession, inventory, byId as hostById } from './hosts/index.js';
import { moveSession } from './hosts/vscode.js';
import { LEVEL_DEFAULT_CHARS, levelName, searchSessions } from './search.js';
import { SafetyError, formatSafetyError } from './safety.js';
import { sqliteAvailable } from './sqlite.js';
import { DAY, HOUR, MIN, SEC, makeStyler, parseTimeArg } from './util.js';

export const VERSION = '0.3.1';

const HELP = `agent-chat-toolkit ${VERSION}
Analyse and navigate agent conversations kept by VS Code Copilot Chat and Antigravity.

USAGE
  agchat <command> [options]

HOSTS
  vscode       VS Code Copilot Chat  (transcripts/*.jsonl event log + chatSessions)
  antigravity  Antigravity Brain     (brain/<id>/.system_generated/logs/transcript*.jsonl)

COMMANDS
  hosts                  detected hosts, data roots and conversation counts
  sessions (alias list)  every conversation across hosts: title, project, id, size
  find                   keyword search across hosts, with detail levels 1-4
  show                   print one conversation (-s <id>) at a detail level
  move                   copy a VS Code conversation into another workspace storage
  stats                  statistics for one transcript (default)
  time                   effective development time detail
  tools                  tool usage breakdown
  segments               one row per human turn (agent time / think time / tools)
  timeline               raw chronological event list
  query                  filter events (type / role / tool / time / text)
  export                 dump stats or events as json | md | csv
  formats                registered transcript format adapters
  paths                  directories searched for transcripts
  help                   this text

SELECTING A CONVERSATION
  -s, --session <id|prefix|title>   conversation id, unique prefix, or title substring
  -f, --file <path|prefix>          explicit transcript file
      --latest                      most recent transcript across hosts (default)
      --all                         aggregate every discovered transcript
      --host <vscode|antigravity>   restrict to one host (repeatable)
      --root <dir>                  extra data dir to search (repeatable)

SEARCH / DETAIL (find, show)
  -k, --keyword <text>      keyword (or --regex pattern)
      --regex               treat --keyword as a regular expression
  -l, --level <1-4>         1 compact, 2 dialogue (default), 3 actions, 4 audit
      --max-chars <n>       clip each message (default depends on level)
      --context <n>         entries of context around each match (default 1)
      --max-results <n>     max conversations to print (default 10)
  -p, --project <text>      filter by workspace/project path substring
  -t, --title <text>        filter by conversation title substring

MOVING A CONVERSATION (VS Code only)
  -s, --session <id>        conversation to move
      --to <hash|path>      destination workspaceStorage folder (hash prefix or path)
      --data-dir <path>     REQUIRED: the user-data root that contains it
      --apply               actually write (default is a dry run)
      --i-know-what-im-doing  allow writing into a live data directory
      --allow-running       allow writing while the host application is running

FILTERS (query / timeline / export)
      --type <t>          event type, repeatable / comma separated
      --role <r>          user | assistant | tool | system
      --tool <name>       tool name
      --grep <regex>      case-insensitive by default
      --grep-scope <s>    content (default) | args | output | tool | all
      --since <when>      ISO date, epoch ms, or relative (90m, 2h, 3d)
      --until <when>      same syntax as --since
      --index <a:b>       inclusive normalised event index range

TIME MODEL
      --cap <dur>         silence counted as work, per gap (default 5m)
      --break <dur>       gap reported as a break (default 30m)
      --caps <list>       override the sensitivity curve, e.g. 30s,1m,5m,30m

OUTPUT
      --json / --md / --csv / --out <file> / --limit <n> / --no-color
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
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const color = opts.color !== false && process.stdout.isTTY;
  const st = makeStyler(color);

  try {
    switch (command) {
      case 'hosts':
        return await cmdHosts(opts, st);
      case 'paths':
        return await writeOut(userDataDirs().join('\n'), opts);
      case 'formats':
        return await cmdFormats(opts, st);
      case 'sessions':
      case 'list':
      case 'conversations':
        return await cmdSessions(opts, st);
      case 'find':
      case 'search':
        return await cmdFind(opts, st);
      case 'show':
        return await cmdShow(opts, st);
      case 'move':
        return await cmdMove(opts, st);
      case 'stats':
      case 'time':
      case 'tools':
      case 'segments':
      case 'timeline':
      case 'query':
      case 'export':
        return await cmdAnalysis(command, opts, st);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${formatSafetyError(err)}\n`);
    if (err?.code === 'EAMBIGUOUS') return 2;
    if (err?.code === 'ENOSQLITE') return 3;
    if (process.env.AGCHAT_DEBUG) process.stderr.write(`${err?.stack}\n`);
    return 1;
  }
}

/* ------------------------------------------------------------------ hosts */

async function cmdHosts(opts, st) {
  const inv = await inventory({ roots: opts.root });
  if (opts.json) return writeOut(JSON.stringify(inv, null, 2), opts);
  return writeOut(renderHosts(inv, { styler: st }), opts);
}

function cmdFormats(opts, st) {
  const list = formatList();
  if (opts.json) return writeOut(JSON.stringify(list, null, 2), opts);
  const lines = [st.bold('Transcript format adapters')];
  for (const f of list) {
    lines.push('');
    lines.push(`${st.cyan(f.id)}`);
    lines.push(`  ${f.description}`);
    if (f.types.length) lines.push(st.gray(`  types: ${f.types.join(', ')}`));
  }
  lines.push('');
  lines.push(st.gray('Unknown event types are preserved and reported, never dropped.'));
  return writeOut(lines.join('\n'), opts);
}

/* --------------------------------------------------------------- sessions */

async function cmdSessions(opts, st) {
  const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
  const filtered = applySessionFilters(sessions, opts);
  const limited = opts.limit ? filtered.slice(0, opts.limit) : filtered;
  if (opts.json) return writeOut(JSON.stringify(limited, null, 2), opts);
  return writeOut(
    renderSessions(limited, { styler: st, limit: opts.limit || 60, total: filtered.length }),
    opts
  );
}

function applySessionFilters(sessions, opts) {
  let out = sessions;
  if (opts.project) {
    const p = String(opts.project).toLowerCase();
    out = out.filter((s) => (s.project ?? '').toLowerCase().includes(p));
  }
  if (opts.title) {
    const t = String(opts.title).toLowerCase();
    out = out.filter((s) => (s.title ?? '').toLowerCase().includes(t));
  }
  if (opts.instance) {
    const wanted = String(opts.instance).toLowerCase();
    out = out.filter((s) => (s.instance ?? '').toLowerCase().includes(wanted));
  }
  if (opts.withLog) out = out.filter((s) => s.transcriptPath);
  if (opts.orphansOnly) out = out.filter((s) => s.indexed === false);
  // Conversations the app's own index does not list, but this tool can read.
  if (opts.notIndexed) out = out.filter((s) => s.inIndex === false);
  if (opts.recoverable) out = out.filter((s) => s.recoverable === true);
  return out;
}

/* ------------------------------------------------------------------- find */

async function cmdFind(opts, st) {
  const sessions = applySessionFilters(
    await allSessions({ hosts: opts.host, roots: opts.root }),
    opts
  );
  if (!sessions.length) return writeOut('No conversations found for this host/root.', opts);

  let pool = sessions;
  if (opts.session) {
    const one = findSession(sessions, opts.session);
    if (!one) throw new Error(`No conversation matched --session ${opts.session}`);
    pool = [one];
  } else if (opts.limit && !opts.keyword) {
    pool = sessions.slice(0, opts.limit);
  }

  const results = await searchSessions(pool, {
    keyword: opts.keyword,
    regex: opts.regex,
    level: opts.level ?? 2,
    maxChars: opts.maxChars,
    maxResults: opts.limit || opts.maxResults || 10,
    context: opts.context ?? 1,
    requireTranscript: true,
  });

  if (opts.json) {
    return writeOut(
      JSON.stringify(
        results.map((r) => ({
          session: r.session,
          level: r.level,
          matchedCount: r.matchedCount,
          artifacts: r.artifacts,
          scratch: r.scratch,
          entries: r.entries,
        })),
        null,
        2
      ),
      opts
    );
  }
  return writeOut(renderSearchResults(results, { styler: st, level: opts.level ?? 2 }), opts);
}

async function cmdShow(opts, st) {
  if (!opts.session && !opts.file) {
    process.stderr.write('show needs --session <id> (or --file <path>).\n');
    return 1;
  }
  const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
  const one = opts.session ? findSession(sessions, opts.session) : null;
  const level = opts.level ?? 2;
  const results = await searchSessions(one ? [one] : sessions, {
    keyword: opts.keyword,
    regex: opts.regex,
    level,
    maxChars: opts.maxChars ?? LEVEL_DEFAULT_CHARS[level],
    maxResults: 1,
    context: opts.context ?? 0,
    filter: one ? undefined : undefined,
    requireTranscript: true,
  });
  if (opts.json) {
    return writeOut(JSON.stringify(results, null, 2), opts);
  }
  if (!results.length) {
    return writeOut(
      one && !one.transcriptPath
        ? `No transcript file for ${one.id} (only chat state exists).`
        : 'Nothing to show. Use --session <id>.',
      opts
    );
  }
  const out = [st.gray(`level ${level} (${levelName(level)})`)];
  out.push(renderSearchResults(results, { styler: st, level }));
  return writeOut(out.join('\n'), opts);
}

/* ------------------------------------------------------------------- move */

async function cmdMove(opts, st) {
  if (!opts.session) throw new SafetyError('move needs --session <id>.', 'NO_SESSION');
  if (!opts.dataDir) {
    throw new SafetyError(
      'move needs an explicit --data-dir <user-data root> so it cannot hit the live profile by accident.',
      'NO_TARGET'
    );
  }
  if (!opts.to) throw new SafetyError('move needs --to <storage hash|path>.', 'NO_TARGET');

  const dataDir = path.resolve(String(opts.dataDir));
  const sessions = await allSessions({ hosts: ['vscode'], roots: [dataDir] });
  const source = findSession(sessions, opts.session);
  if (!source) throw new Error(`No VS Code conversation matched ${opts.session} under ${dataDir}`);
  if (source.host !== 'vscode') throw new Error('move currently supports the vscode host only.');

  const target = await resolveStorageTarget(dataDir, source, opts.to);
  if (!target) throw new Error(`No workspaceStorage matched --to ${opts.to} under ${dataDir}`);
  if (target === source.storageDir) {
    throw new Error('Source and target storage are the same folder.');
  }

  const plan = await moveSession({
    source,
    targetStorageDir: target,
    apply: Boolean(opts.apply),
    allowReal: Boolean(opts.allowReal),
    allowRunning: Boolean(opts.allowRunning),
    dataDir,
  });

  if (opts.json) return writeOut(JSON.stringify({ source, target, plan }, null, 2), opts);
  return writeOut(renderMovePlan(plan, { styler: st, session: source, target }), opts);
}

async function resolveStorageTarget(dataDir, source, to) {
  const raw = String(to);
  const asPath = path.resolve(raw);
  try {
    const stat = await fsp.stat(asPath);
    if (stat.isDirectory() && path.basename(path.dirname(asPath)) === 'workspaceStorage') return asPath;
    if (stat.isDirectory() && asPath.endsWith('workspaceStorage')) return null;
  } catch {
    /* not a path */
  }
  if (path.isAbsolute(raw) || raw.includes(path.sep) || raw.includes('/')) {
    return null;
  }
  const base = path.join(dataDir, 'workspaceStorage');
  let entries = [];
  try {
    entries = await fsp.readdir(base);
  } catch {
    return null;
  }
  const matches = entries.filter((e) => e.startsWith(raw) && path.join(base, e) !== source.storageDir);
  if (matches.length === 1) return path.join(base, matches[0]);
  if (matches.length > 1) {
    throw new SafetyError(
      `--to ${raw} matches ${matches.length} storage folders:\n` +
        matches.map((m) => `  ${m}`).join('\n'),
      'EAMBIGUOUS'
    );
  }
  return null;
}

/* --------------------------------------------------------------- analysis */

async function cmdAnalysis(command, opts, st) {
  const targets = await resolveTranscripts(opts);
  if (!targets.length) {
    process.stderr.write(
      'No transcript found. Run `agchat sessions` or pass --session/--file/--root.\n'
    );
    return 1;
  }

  if (command === 'export') return cmdExport(targets, opts);

  const needsEvents = command === 'timeline' || command === 'query';
  const analyses = [];
  const allEvents = [];
  const sourceMap = await sessionSources(opts);
  for (const file of targets) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTarget(file, opts, sourceMap);
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
      return writeOut(renderTimeline(allEvents, { styler: st, limit: opts.limit || 200 }), opts);
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
  const sourceMap = await sessionSources(opts);
  for (const file of targets) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTarget(file, opts, sourceMap);
    if (format === 'csv') {
      chunks.push(exportCsv(parsed.events));
    } else if (format === 'json') {
      chunks.push(exportJson(computeStats(parsed, timingOpts(opts))));
    } else {
      chunks.push(exportMarkdown(computeStats(parsed, timingOpts(opts))));
    }
  }
  return writeOut(chunks.join('\n'), opts);
}

/* ------------------------------------------------------------- resolution */

/**
 * Map each primary transcript path to the full set of logs that describe the same
 * conversation. Antigravity splits one conversation over several files, so acting
 * on `transcript_full.jsonl` alone silently drops the head of long sessions.
 */
async function sessionSources(opts) {
  const map = new Map();
  try {
    const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
    for (const s of sessions) {
      if (s.transcriptPath && Array.isArray(s.logSources) && s.logSources.length) {
        map.set(path.resolve(s.transcriptPath), s.logSources);
      }
    }
  } catch {
    /* discovery is best-effort here; fall back to single-file parsing */
  }
  return map;
}

/** Parse one transcript target, merging every log that belongs to the session. */
async function parseTarget(file, opts, sourceMap) {
  const sources = sourceMap?.get(path.resolve(file));
  if (sources && sources.length > 1) {
    return parseTranscriptSet(sources, { keepData: false });
  }
  return parseTranscript(file, { keepData: false });
}

/** Resolve the transcript file(s) a command should act on. */
async function resolveTranscripts(opts) {
  if (opts.file) return [await resolveFileArg(opts)];

  if (opts.session) {
    const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
    const one = findSession(sessions, opts.session);
    if (!one) throw new Error(`No conversation matched --session ${opts.session}`);
    if (!one.transcriptPath) {
      throw new Error(
        `Conversation ${one.id} has no transcript file (only chat state). Nothing to analyse.`
      );
    }
    return [one.transcriptPath];
  }

  if (opts.all) {
    const extraRoot = opts.root ?? opts.dataDir ?? null;
    const files = await findTranscriptFiles({ roots: extraRoot ? [extraRoot] : null });
    const ok = [];
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      const head = await readHead(f.file, 4096);
      if (detect(head)) ok.push(f.file);
    }
    return ok;
  }

  // --latest: newest transcript across hosts (falls back to VS Code discovery)
  const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
  const withLog = sessions.filter((s) => s.transcriptPath);
  if (withLog.length) return [withLog[0].transcriptPath];

  const rows = await listTranscripts({ roots: opts.root, limit: 1 });
  return rows.length ? [rows[0].file] : [];
}

async function resolveFileArg(opts) {
  const direct = path.resolve(String(opts.file));
  try {
    const stat = await fsp.stat(direct);
    if (stat.isFile()) return direct;
  } catch {
    /* prefix match below */
  }
  const sessions = await allSessions({ hosts: opts.host, roots: opts.root });
  const needle = String(opts.file).toLowerCase();
  const matches = sessions.filter(
    (s) =>
      s.transcriptPath &&
      (s.id.toLowerCase().startsWith(needle) || s.transcriptPath.toLowerCase().includes(needle))
  );
  if (matches.length === 1) return matches[0].transcriptPath;
  if (matches.length > 1) {
    throw new Error(
      `--file matched ${matches.length} transcripts:\n` +
        matches.map((m) => `  ${m.id}  [${m.host}]  ${m.title}`).join('\n')
    );
  }
  throw new Error(`No transcript matched --file ${opts.file}`);
}

/* ---------------------------------------------------------------- merging */

function mergeStats(list) {
  const base = JSON.parse(JSON.stringify(list[0]));
  base.file = `${list.length} transcripts`;
  base.tools = [];
  base.requestedTools = [];
  base.byType = [];
  base.top = { prompts: [], replies: [], toolArgs: [], observations: [] };
  base.formats = [...new Set(list.map((s) => s.format))];
  // Coverage describes one conversation; it is meaningless once several are summed.
  base.coverage = list.length === 1 ? (list[0].coverage ?? null) : null;

  const toolMap = new Map();
  const reqMap = new Map();
  const typeMap = new Map();

  for (const s of list) {
    for (const k of [
      'humanTurns',
      'assistantMessages',
      'agentSegments',
      'toolCalls',
      'toolFailures',
      'toolRequests',
      'toolUnknown',
      'events',
      'sessions',
    ]) {
      base.counts[k] = (base.counts[k] ?? 0) + (s.counts[k] ?? 0);
    }
    base.counts.undatedEvents += s.counts.undatedEvents ?? 0;
    base.parseErrors += s.parseErrors;
    base.totalLines += s.totalLines;
    base.bytes += s.bytes;
    for (const k of Object.keys(base.text)) base.text[k] += s.text[k] ?? 0;
    for (const t of s.tools) {
      const cur =
        toolMap.get(t.name) ?? { name: t.name, calls: 0, failed: 0, unknown: 0, argsChars: 0, ms: 0, timed: 0 };
      cur.calls += t.calls;
      cur.failed += t.failed;
      cur.unknown += t.unknown ?? 0;
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
  base.requestedTools = [...reqMap.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n);
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

  const t = base.timing;
  const firsts = list.map((s) => s.timing.span.first).filter((x) => x != null);
  const lasts = list.map((s) => s.timing.span.last).filter((x) => x != null);
  t.span = {
    first: firsts.length ? Math.min(...firsts) : null,
    last: lasts.length ? Math.max(...lasts) : null,
    ms: 0,
  };
  t.span.ms = t.span.first != null && t.span.last != null ? Math.max(0, t.span.last - t.span.first) : 0;
  t.active.ms = 0;
  for (const s of list) t.active.ms += s.timing.active.ms;
  for (const r of t.byCap) {
    r.activeMs = 0;
    for (const s of list) {
      const src = s.timing.byCap.find((x) => x.capMs === r.capMs);
      if (src) r.activeMs += src.activeMs;
    }
    const denom = list.reduce((a, s) => a + s.timing.span.ms, 0);
    r.idleMs = Math.max(0, denom - r.activeMs);
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
      case '-s':
      case '--session':
      case '--id':
        opts.session = take(a);
        break;
      case '--to':
        opts.to = take(a);
        break;
      case '--data-dir':
      case '--data':
        opts.dataDir = take(a);
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--i-know-what-im-doing':
      case '--force-real':
        opts.allowReal = true;
        break;
      case '--allow-running':
        opts.allowRunning = true;
        break;
      case '--host':
        opts.host = pushCsv(opts.host, take(a));
        break;
      case '--instance':
        opts.instance = take(a);
        break;
      case '--not-indexed':
      case '--hidden':
        opts.notIndexed = true;
        break;
      case '--recoverable':
        opts.recoverable = true;
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
      case '-k':
      case '--keyword':
        opts.keyword = take(a);
        break;
      case '--regex':
        opts.regex = true;
        break;
      case '-l':
      case '--level':
        opts.level = Number(take(a)) || 2;
        break;
      case '--max-chars':
        opts.maxChars = Number(take(a)) || 0;
        break;
      case '--context':
        opts.context = Number(take(a));
        break;
      case '-p':
      case '--project':
        opts.project = take(a);
        break;
      case '-t':
      case '--title':
        opts.title = take(a);
        break;
      case '--with-log':
        opts.withLog = true;
        break;
      case '--orphans':
        opts.orphansOnly = true;
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
      case '--max-results':
        opts.maxResults = Number(take(a)) || 0;
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
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(s);
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

export { HOSTS, hostById, buildFilter, analyzeTiming, capLabel, sqliteAvailable };

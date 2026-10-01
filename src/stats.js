import { extractMeta } from './formats/vscode-transcript.js';
import { analyzeTiming } from './timing.js';

const CODE_FENCE = /```/g;

function count(map, key) {
  return map.get(key) ?? 0;
}

/** Count words in a way that is stable for mixed CJK/Latin text. */
export function countWords(text) {
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0;
  return latin + cjk;
}

function countCodeBlocks(text) {
  if (!text) return 0;
  const fences = text.match(CODE_FENCE)?.length ?? 0;
  return Math.floor(fences / 2);
}

/**
 * Aggregate conversation statistics for one parsed transcript.
 *
 * The first section deliberately separates *human-authored* turns from *agent
 * bookkeeping* and *tool round-trips*, because a raw line count of a Copilot
 * transcript is dominated by machine-generated traffic.
 */
export function computeStats(parsed, opts = {}) {
  const events = parsed.events;
  const byType = new Map();
  const byRole = { user: 0, assistant: 0, tool: 0, system: 0 };
  const toolCalls = new Map();
  const toolRequests = new Map();
  const toolDurations = new Map();
  const text = {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    userWords: 0,
    assistantCodeBlocks: 0,
  };
  const top = { prompts: [], replies: [], toolArgs: [] };

  const openCalls = new Map();
  let humanTurns = 0;
  let assistantMessages = 0;
  let agentSegments = 0;
  let toolCallCount = 0;
  let toolFailures = 0;
  let toolRequestCount = 0;
  let untimedEvents = 0;

  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    if (e.role in byRole) byRole[e.role] += 1;
    if (e.ts == null) untimedEvents += 1;

    switch (e.type) {
      case 'user.message': {
        humanTurns += 1;
        text.userChars += e.chars;
        text.userWords += countWords(e.text);
        if (e.text) top.prompts.push({ i: e.i, ts: e.ts, chars: e.chars, text: e.text });
        break;
      }
      case 'assistant.message': {
        assistantMessages += 1;
        text.assistantChars += e.chars;
        text.reasoningChars += e.reasoningChars;
        text.assistantCodeBlocks += countCodeBlocks(e.text);
        if (e.text) top.replies.push({ i: e.i, ts: e.ts, chars: e.chars, text: e.text });
        for (const name of e.requestedTools ?? []) {
          toolRequestCount += 1;
          toolRequests.set(name, (toolRequests.get(name) ?? 0) + 1);
        }
        break;
      }
      case 'assistant.turn_start':
        agentSegments += 1;
        break;
      case 'tool.execution_start': {
        toolCallCount += 1;
        const name = e.toolName ?? 'unknown';
        const bucket = toolCalls.get(name) ?? { name, calls: 0, failed: 0, argsChars: 0 };
        bucket.calls += 1;
        bucket.argsChars += e.argsChars;
        toolCalls.set(name, bucket);
        text.toolArgsChars += e.argsChars;
        if (e.argsText) top.toolArgs.push({ i: e.i, ts: e.ts, chars: e.argsChars, text: e.argsText, tool: name });
        openCalls.set(e.toolCallId ?? `i${e.i}`, { name, ts: e.ts });
        break;
      }
      case 'tool.execution_complete': {
        if (e.success === false) {
          toolFailures += 1;
          const open = openCalls.get(e.toolCallId ?? '');
          if (open) {
            const bucket = toolCalls.get(open.name);
            if (bucket) bucket.failed += 1;
          }
        }
        const open = openCalls.get(e.toolCallId ?? '');
        if (open && open.ts != null && e.ts != null) {
          const acc = toolDurations.get(open.name) ?? { name: open.name, ms: 0, timed: 0 };
          acc.ms += Math.max(0, e.ts - open.ts);
          acc.timed += 1;
          toolDurations.set(open.name, acc);
        }
        openCalls.delete(e.toolCallId ?? '');
        break;
      }
      default:
        break;
    }
  }

  const timing = analyzeTiming(events, opts);
  const sessionCount = byType.get('session.start') ?? 0;

  const stats = {
    file: parsed.file,
    bytes: parsed.bytes,
    totalLines: parsed.totalLines,
    parseErrors: parsed.parseErrors,
    meta: extractMeta(events),
    counts: {
      events: events.length,
      undatedEvents: untimedEvents,
      /** real conversation turns written by a human */
      humanTurns,
      /** assistant messages (agent output segments) */
      assistantMessages,
      /** assistant.turn_start markers: agent "turns" including tool round-trips */
      agentSegments,
      /** tool.execution_start count */
      toolCalls: toolCallCount,
      toolFailures,
      /** tool calls *requested* by the model (may exceed executed count) */
      toolRequests: toolRequestCount,
      sessions: sessionCount,
      uniqueTools: toolCalls.size,
    },
    ratios: {
      /** agent turn markers per human turn - shows how much traffic is bookkeeping */
      agentSegmentsPerHumanTurn: humanTurns ? agentSegments / humanTurns : 0,
      toolCallsPerHumanTurn: humanTurns ? toolCallCount / humanTurns : 0,
      assistantPerHumanTurn: humanTurns ? assistantMessages / humanTurns : 0,
      toolFailureRate: toolCallCount ? toolFailures / toolCallCount : 0,
      /** share of transcript lines that are neither user nor assistant prose */
      machineLineShare: events.length
        ? (count(byType, 'tool.execution_start') +
            count(byType, 'tool.execution_complete') +
            count(byType, 'assistant.turn_start') +
            count(byType, 'assistant.turn_end')) /
          events.length
        : 0,
    },
    byType: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, n })),
    byRole,
    text,
    tools: [...toolCalls.values()]
      .map((t) => ({
        ...t,
        ms: toolDurations.get(t.name)?.ms ?? 0,
        timed: toolDurations.get(t.name)?.timed ?? 0,
        failRate: t.calls ? t.failed / t.calls : 0,
      }))
      .sort((a, b) => b.calls - a.calls || b.ms - a.ms),
    requestedTools: [...toolRequests.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n),
    timing,
    top: {
      prompts: top.prompts.sort((a, b) => b.chars - a.chars).slice(0, 5),
      replies: top.replies.sort((a, b) => b.chars - a.chars).slice(0, 5),
      toolArgs: top.toolArgs.sort((a, b) => b.chars - a.chars).slice(0, 5),
    },
  };

  return stats;
}

/** Sanity checks that flag a suspicious analysis setup (used by `--explain` and tests). */
export function sanityWarnings(stats) {
  const w = [];
  if (stats.parseErrors > 0) {
    w.push(`${stats.parseErrors} line(s) could not be parsed as JSON and were skipped.`);
  }
  if (stats.counts.humanTurns === 0) {
    w.push('No user.message events found - is this a transcript file (not a chatSessions file)?');
  }
  if (stats.counts.toolCalls > stats.counts.humanTurns * 200) {
    w.push('Tool traffic dwarfs human turns; do not read raw event counts as "conversation turns".');
  }
  if (stats.timing.span.ms > 0 && stats.timing.active.ratio < 0.02) {
    w.push('Active-time ratio below 2% - the session is dominated by long idle gaps.');
  }
  if (stats.counts.undatedEvents > 0) {
    w.push(`${stats.counts.undatedEvents} event(s) have no parsable timestamp and were excluded from timing.`);
  }
  return w;
}

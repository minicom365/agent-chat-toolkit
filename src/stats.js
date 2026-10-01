import * as formats from './formats/index.js';
import { analyzeTiming } from './timing.js';

const CODE_FENCE = /```/g;

function count(map, key) {
  return map.get(key) ?? 0;
}

/** Count words in a way that is stable for mixed CJK/Latin text. */
export function countWords(text) {
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0;
  const cjk =
    text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0;
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
 * bookkeeping* and *tool round-trips*, because a raw line count of an agent
 * transcript is dominated by machine-generated traffic.
 *
 * Works for every registered format: the normalised event shape is the contract,
 * not the raw JSON.
 */
export function computeStats(parsed, opts = {}) {
  const events = parsed.events;
  const adapter = formats.byId(parsed.format);

  const byType = new Map();
  const byRole = { user: 0, assistant: 0, tool: 0, system: 0 };
  const toolCalls = new Map();
  const toolRequests = new Map();
  const text = {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    /** tool *output* text - machine data, never prose */
    observationChars: 0,
    userWords: 0,
    assistantCodeBlocks: 0,
  };
  const top = { prompts: [], replies: [], toolArgs: [], observations: [] };

  const openCalls = new Map();
  let humanTurns = 0;
  let assistantMessages = 0;
  let agentSegments = 0;
  let toolCallCount = 0;
  let toolFailures = 0;
  let toolRequestCount = 0;
  let untimedEvents = 0;

  const bucketOf = (name) => {
    let b = toolCalls.get(name);
    if (!b) {
      b = { name, calls: 0, failed: 0, unknown: 0, argsChars: 0, ms: 0, timed: 0 };
      toolCalls.set(name, b);
    }
    return b;
  };

  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    if (e.role in byRole) byRole[e.role] += 1;
    if (e.ts == null) untimedEvents += 1;

    // Tool output is machine data in every format, so it is accumulated before
    // any role-based branching can skip the event.
    text.observationChars += e.observationChars ?? 0;
    if (e.observation) {
      top.observations.push({ i: e.i, ts: e.ts, chars: e.observationChars, text: e.observation });
    }

    if (e.role === 'user') {
      humanTurns += 1;
      text.userChars += e.chars;
      text.userWords += countWords(e.text);
      if (e.text) top.prompts.push({ i: e.i, ts: e.ts, chars: e.chars, text: e.text });
      continue;
    }

    if (e.role === 'assistant' && !e.control) {
      assistantMessages += 1;
      text.assistantChars += e.chars;
      text.reasoningChars += e.reasoningChars;
      text.assistantCodeBlocks += countCodeBlocks(e.text);
      if (e.text) top.replies.push({ i: e.i, ts: e.ts, chars: e.chars, text: e.text });
      for (const name of e.requestedTools ?? []) {
        toolRequestCount += 1;
        toolRequests.set(name, (toolRequests.get(name) ?? 0) + 1);
      }
      continue;
    }

    if (e.type === 'assistant.turn_start') agentSegments += 1;

    if (e.type === 'tool.execution_start') {
      toolCallCount += 1;
      const b = bucketOf(e.toolName ?? 'unknown');
      b.calls += 1;
      b.argsChars += e.argsChars;
      text.toolArgsChars += e.argsChars;
      if (e.argsText) {
        top.toolArgs.push({ i: e.i, ts: e.ts, chars: e.argsChars, text: e.argsText, tool: b.name });
      }
      openCalls.set(e.toolCallId ?? `i${e.i}`, { name: b.name, ts: e.ts });
      continue;
    }

    if (e.type === 'tool.execution_complete') {
      const open = openCalls.get(e.toolCallId ?? '');
      if (e.success === false) {
        toolFailures += 1;
        if (open) bucketOf(open.name).failed += 1;
      }
      if (open && open.ts != null && e.ts != null) {
        const b = bucketOf(open.name);
        b.ms += Math.max(0, e.ts - open.ts);
        b.timed += 1;
      }
      openCalls.delete(e.toolCallId ?? '');
      continue;
    }

    // Formats that report a tool call and its result in a single event
    // (e.g. Antigravity): the call is the event itself.
    if (e.role === 'tool' && e.toolName) {
      toolCallCount += 1;
      const b = bucketOf(e.toolName);
      b.calls += 1;
      b.argsChars += e.argsChars;
      text.toolArgsChars += e.argsChars;
      if (e.argsText) {
        top.toolArgs.push({ i: e.i, ts: e.ts, chars: e.argsChars, text: e.argsText, tool: e.toolName });
      }
      if (e.success === false) {
        toolFailures += 1;
        b.failed += 1;
      } else if (e.success == null) {
        b.unknown += 1;
      }
      if (e.toolMs != null) {
        b.ms += e.toolMs;
        b.timed += 1;
      }
      continue;
    }
  }

  if (!agentSegments) agentSegments = assistantMessages;

  const timing = analyzeTiming(events, opts);
  const sessionCount = count(byType, 'session.start') || (humanTurns ? 1 : 0);

  const stats = {
    file: parsed.file,
    bytes: parsed.bytes,
    totalLines: parsed.totalLines,
    parseErrors: parsed.parseErrors,
    format: parsed.format ?? null,
    meta: adapter ? adapter.extractMeta(events) : {},
    /** how much of the conversation the log actually holds (null for single-file parses) */
    coverage: parsed.coverage ?? null,
    counts: {
      events: events.length,
      undatedEvents: untimedEvents,
      humanTurns,
      assistantMessages,
      agentSegments,
      toolCalls: toolCallCount,
      toolFailures,
      toolRequests: toolRequestCount,
      /** tool results that carry no success flag */
      toolUnknown: [...toolCalls.values()].reduce((a, b) => a + b.unknown, 0),
      sessions: sessionCount,
      uniqueTools: toolCalls.size,
    },
    ratios: {
      agentSegmentsPerHumanTurn: humanTurns ? agentSegments / humanTurns : 0,
      toolCallsPerHumanTurn: humanTurns ? toolCallCount / humanTurns : 0,
      assistantPerHumanTurn: humanTurns ? assistantMessages / humanTurns : 0,
      toolFailureRate: toolCallCount ? toolFailures / toolCallCount : 0,
      /**
       * Share of events that carry no human or model prose: tool round-trips and
       * the agent's own turn markers. `session.start` is metadata, so it is not
       * counted as machine traffic.
       */
      machineLineShare: events.length
        ? events.filter(
            (e) => e.role === 'tool' || (e.control && e.type !== 'session.start')
          ).length / events.length
        : 0,
    },
    byType: [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => ({ type, n })),
    byRole,
    text,
    tools: [...toolCalls.values()]
      .map((t) => ({ ...t, failRate: t.calls ? t.failed / t.calls : 0 }))
      .sort((a, b) => b.calls - a.calls || b.ms - a.ms),
    requestedTools: [...toolRequests.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n),
    timing,
    top: {
      prompts: top.prompts.sort((a, b) => b.chars - a.chars).slice(0, 5),
      replies: top.replies.sort((a, b) => b.chars - a.chars).slice(0, 5),
      toolArgs: top.toolArgs.sort((a, b) => b.chars - a.chars).slice(0, 5),
      observations: top.observations.sort((a, b) => b.chars - a.chars).slice(0, 5),
    },
  };

  return stats;
}

/** Sanity checks that flag a suspicious analysis setup. */
export function sanityWarnings(stats) {
  const w = [];
  if (stats.parseErrors > 0) {
    w.push(`${stats.parseErrors} line(s) could not be parsed and were skipped.`);
  }
  if (stats.counts.humanTurns === 0) {
    w.push('No human-authored events found - is this a conversation transcript?');
  }
  if (stats.counts.toolCalls > stats.counts.humanTurns * 200) {
    w.push('Tool traffic dwarfs human turns; do not read raw event counts as "conversation turns".');
  }
  if (stats.timing.span.ms > 0 && stats.timing.active.ratio < 0.02) {
    w.push('Active-time ratio below 2% - the session is dominated by long idle gaps.');
  }
  if (stats.counts.undatedEvents > 0) {
    w.push(
      `${stats.counts.undatedEvents} event(s) have no parsable timestamp and were excluded from timing.`
    );
  }
  const cov = stats.coverage;
  if (cov && cov.headLostSteps > 0) {
    w.push(
      `The log starts at step ${cov.stepSpan.first}: the first ${cov.headLostSteps} step(s) of this ` +
        'conversation are not in any readable log. Totals below cover only what survived.'
    );
  }
  if (cov && cov.firstTextStep != null && cov.stepSpan && cov.firstTextStep > cov.stepSpan.first) {
    w.push(
      `Text survives only from step ${cov.firstTextStep} onward (${cov.textSteps} steps carry content). ` +
        'Earlier steps are a skeleton: the app cleared their text and the full copy lives in the ' +
        'encrypted <id>.pb store, which is not readable offline.'
    );
  }
  return w;
}

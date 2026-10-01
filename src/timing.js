import { MIN, dayKey, localStamp } from './util.js';

/**
 * How long a silence between two events is *still* counted as work.
 *
 * A transcript only records the moment an event was written, so the wall-clock
 * span between the first and the last event is NOT the time a human spent
 * working: it includes lunch breaks, nights, and leaving the editor open.
 *
 * The standard remedy is to sum the gaps between consecutive events but cap
 * every gap at a threshold. Gaps below the cap are assumed to be "still
 * working" (thinking, reading, waiting on a build); gaps above it are assumed
 * to contain a break and contribute only the cap.
 *
 * The cap is a modelling choice, not a measurement, so the tool reports the
 * whole sensitivity curve instead of pretending one number is the truth.
 */
export const DEFAULT_CAPS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];

/** Cap used for the headline "effective development time" number. */
export const DEFAULT_CAP_MS = 300_000;

/** A silence longer than this is reported as a break. */
export const DEFAULT_BREAK_MS = 30 * MIN;

const HUMAN_TYPE = 'user.message';

/** Which lane a gap belongs to, decided by the event that *ends* the gap. */
function phaseOf(type) {
  if (type === 'user.message') return 'human';
  if (type === 'tool.execution_complete') return 'tool';
  if (typeof type === 'string' && type.startsWith('assistant.')) return 'model';
  if (type === 'tool.execution_start') return 'tool';
  return 'other';
}

export function timelineOf(events) {
  return events
    .filter((e) => e.ts != null)
    .slice()
    .sort((a, b) => (a.ts - b.ts) || (a.i - b.i));
}

function emptyPhase() {
  return { raw: 0, byCap: {}, count: 0 };
}

/**
 * @param {object[]} events normalised events from a transcript
 * @param {{
 *   capsMs?: number[],
 *   capMs?: number,
 *   breakMs?: number,
 *   topGaps?: number
 * }} [opts]
 */
export function analyzeTiming(events, opts = {}) {
  const caps = (opts.capsMs ?? DEFAULT_CAPS_MS).slice().sort((a, b) => a - b);
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const breakMs = opts.breakMs ?? DEFAULT_BREAK_MS;
  const topGaps = opts.topGaps ?? 5;

  const withTs = events.filter((e) => e.ts != null);
  const undated = events.length - withTs.length;
  const tl = timelineOf(events);

  const result = {
    capMs,
    breakMs,
    capsMs: caps,
    eventCount: events.length,
    undatedEvents: undated,
    span: { first: null, last: null, ms: 0 },
    active: { ms: 0, ratio: 0 },
    byCap: [],
    phases: {
      human: { label: 'human think time (gap before a user message)', ...emptyPhase() },
      model: { label: 'model generation (gap before an assistant event)', ...emptyPhase() },
      tool: { label: 'tool execution (gap before a tool completion)', ...emptyPhase() },
      other: { label: 'setup / other', ...emptyPhase() },
    },
    toolRuntime: [],
    segments: [],
    gaps: [],
    breaks: [],
    days: [],
  };

  if (tl.length === 0) return result;

  const first = tl[0].ts;
  const last = tl[tl.length - 1].ts;
  result.span = { first, last, ms: Math.max(0, last - first) };

  // ---- gap walk -----------------------------------------------------------
  const gaps = [];
  for (let k = 1; k < tl.length; k += 1) {
    const a = tl[k - 1];
    const b = tl[k];
    const ms = Math.max(0, b.ts - a.ts);
    gaps.push({ ms, from: a, to: b, phase: phaseOf(b.type) });
  }
  result.gaps = gaps;

  // ---- capped active time (the headline metric) ---------------------------
  const capSum = (limit) => gaps.reduce((acc, g) => acc + Math.min(g.ms, limit), 0);
  const activeMs = capSum(capMs);
  result.active = {
    ms: activeMs,
    ratio: result.span.ms ? activeMs / result.span.ms : 0,
  };
  result.byCap = caps.map((c) => {
    const act = capSum(c);
    return {
      capMs: c,
      activeMs: act,
      idleMs: Math.max(0, result.span.ms - act),
      ratio: result.span.ms ? act / result.span.ms : 0,
      isDefault: c === capMs,
    };
  });

  // ---- per-phase breakdown -------------------------------------------------
  const phases = result.phases;
  for (const key of Object.keys(phases)) {
    phases[key].byCap = Object.fromEntries(caps.map((c) => [c, 0]));
  }
  for (const g of gaps) {
    const bucket = phases[g.phase] ?? phases.other;
    bucket.raw += g.ms;
    bucket.count += 1;
    for (const c of caps) bucket.byCap[c] += Math.min(g.ms, c);
  }
  for (const key of Object.keys(phases)) delete phases[key].undef;

  // ---- exact tool runtime (start -> complete pairing) ----------------------
  const openCalls = new Map();
  const toolStats = new Map();
  for (const e of events) {
    if (e.type === 'tool.execution_start') {
      openCalls.set(e.toolCallId ?? `i${e.i}`, { name: e.toolName ?? 'unknown', start: e.ts, i: e.i });
      continue;
    }
    if (e.type === 'tool.execution_complete') {
      const key = e.toolCallId ?? null;
      const open = key != null ? openCalls.get(key) : undefined;
      const name = open?.name ?? 'unknown';
      const entry = toolStats.get(name) ?? { name, calls: 0, ok: 0, failed: 0, unknown: 0, ms: 0, timed: 0 };
      entry.calls += 1;
      if (e.success === true) entry.ok += 1;
      else if (e.success === false) entry.failed += 1;
      else entry.unknown += 1;
      if (open && open.start != null && e.ts != null) {
        entry.ms += Math.max(0, e.ts - open.start);
        entry.timed += 1;
      }
      toolStats.set(name, entry);
      if (key != null) openCalls.delete(key);
    }
  }
  result.toolRuntime = [...toolStats.values()].sort((a, b) => b.ms - a.ms || b.calls - a.calls);
  result.toolRuntimeTotals = {
    calls: result.toolRuntime.reduce((a, t) => a + t.calls, 0),
    failed: result.toolRuntime.reduce((a, t) => a + t.failed, 0),
    ms: result.toolRuntime.reduce((a, t) => a + t.ms, 0),
  };

  // ---- conversation segments (human turn -> agent activity) ----------------
  const userIdx = [];
  for (let k = 0; k < tl.length; k += 1) if (tl[k].type === HUMAN_TYPE) userIdx.push(k);
  const segments = [];
  for (let u = 0; u < userIdx.length; u += 1) {
    const startK = userIdx[u];
    const endK = u + 1 < userIdx.length ? userIdx[u + 1] - 1 : tl.length - 1;
    const startEv = tl[startK];
    const endEv = tl[endK];
    const nextEv = u + 1 < userIdx.length ? tl[userIdx[u + 1]] : null;
    const agentMs = endK > startK ? Math.max(0, endEv.ts - startEv.ts) : 0;
    const thinkMs = nextEv ? Math.max(0, nextEv.ts - endEv.ts) : 0;
    segments.push({
      n: u + 1,
      startIndex: startK,
      endIndex: endK,
      startTs: startEv.ts,
      endTs: endEv.ts,
      agentMs,
      agentCappedMs: Math.min(agentMs, capMs),
      thinkMs,
      thinkCappedMs: Math.min(thinkMs, capMs),
      events: endK - startK + 1,
      toolCalls: tl.slice(startK, endK + 1).filter((e) => e.type === 'tool.execution_start').length,
      prompt: startEv.text,
    });
  }
  result.segments = segments;

  // ---- breaks --------------------------------------------------------------
  result.breaks = gaps
    .filter((g) => g.ms > breakMs)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, topGaps)
    .map((g) => ({
      ms: g.ms,
      fromTs: g.from.ts,
      toTs: g.to.ts,
      from: `${g.from.type}${g.from.toolName ? `(${g.from.toolName})` : ''}`,
      to: `${g.to.type}${g.to.toolName ? `(${g.to.toolName})` : ''}`,
      resumedWith: g.to.type === 'user.message' ? g.to.text : null,
    }));
  result.breakCount = gaps.filter((g) => g.ms > breakMs).length;

  // ---- per-day breakdown ---------------------------------------------------
  const dayMap = new Map();
  for (let k = 0; k < tl.length; k += 1) {
    const e = tl[k];
    const key = dayKey(e.ts);
    let d = dayMap.get(key);
    if (!d) {
      d = {
        day: key,
        first: e.ts,
        last: e.ts,
        events: 0,
        humanTurns: 0,
        toolCalls: 0,
        assistantMessages: 0,
        userChars: 0,
        assistantChars: 0,
        activeMs: 0,
        rawMs: 0,
        firstPrompt: null,
      };
      dayMap.set(key, d);
    }
    d.events += 1;
    d.last = e.ts;
    if (e.type === HUMAN_TYPE) {
      d.humanTurns += 1;
      d.userChars += e.chars;
      if (!d.firstPrompt) d.firstPrompt = e.text;
    }
    if (e.type === 'tool.execution_start') d.toolCalls += 1;
    if (e.type === 'assistant.message') {
      d.assistantMessages += 1;
      d.assistantChars += e.chars;
    }
    // attribute the gap that *ended* at this event to this day
    const g = k > 0 ? { ms: Math.max(0, e.ts - tl[k - 1].ts) } : null;
    if (g && dayKey(tl[k - 1].ts) === key) {
      d.rawMs += g.ms;
      d.activeMs += Math.min(g.ms, capMs);
    }
  }
  result.days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  result.activeDayCount = result.days.length;

  return result;
}

/** Convenience wrapper used by the renderer: "5m" style cap labels. */
export function capLabel(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function describeWindow(timing) {
  if (!timing.span.first) return '(no timestamped events)';
  return `${localStamp(timing.span.first)} → ${localStamp(timing.span.last)}`;
}

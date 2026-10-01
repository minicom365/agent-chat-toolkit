import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';

import * as formats from './formats/index.js';

/** Read at most `bytes` from the head of a file (used for format sniffing). */
export async function readHead(file, bytes = 8192) {
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

export async function detectFormat(file) {
  const head = await readHead(file);
  return formats.detect(head);
}

function resolveAdapter(format, sampleLines) {
  if (format === null) return null;
  if (typeof format === 'string') return formats.byId(format);
  if (format) return format;
  return sampleLines ? formats.detect(sampleLines) : null;
}

function applyFinalize(adapter, events) {
  if (adapter && typeof adapter.finalize === 'function') adapter.finalize(events);
  return events;
}

/**
 * Stream-parse a transcript file into normalised events.
 * Memory scales with the number of events, not with the file size on disk.
 *
 * @param {string} file
 * @param {{ keepData?: boolean, types?: Set<string>|null, limit?: number, format?: object|string|null }} [opts]
 */
export async function parseTranscript(file, opts = {}) {
  const { keepData = false, types = null, limit = 0 } = opts;
  // `format: null` disables detection; `format: undefined` means auto-detect.
  let adapter = opts.format;
  if (typeof adapter === 'string') adapter = formats.byId(adapter);
  if (adapter === undefined) adapter = await detectFormat(file);
  if (!adapter) {
    const err = new Error(`Unrecognised transcript format: ${file}`);
    err.code = 'EFORMAT';
    throw err;
  }

  const stat = await fsp.stat(file);
  const events = [];
  let index = 0;
  let parseErrors = 0;
  let totalLines = 0;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      totalLines += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ev = adapter.normalize(trimmed, index, { keepData });
      if (!ev) {
        parseErrors += 1;
        continue;
      }
      index += 1;
      if (types && !types.has(ev.type)) continue;
      events.push(ev);
      if (limit && events.length >= limit) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  applyFinalize(adapter, events);
  return {
    file,
    bytes: stat.size,
    totalLines,
    parseErrors,
    format: adapter.FORMAT_ID,
    events,
  };
}

/**
 * Parse an in-memory array of JSONL lines. Handy for tests and for callers that
 * already hold the transcript text.
 */
export function parseLines(lines, opts = {}) {
  const { keepData = false, types = null, limit = 0 } = opts;
  const adapter = resolveAdapter(opts.format, lines.slice(0, 40).join('\n'));

  const events = [];
  let parseErrors = 0;
  let index = 0;
  if (adapter) {
    for (const line of lines) {
      const trimmed = String(line ?? '').trim();
      if (!trimmed) continue;
      const ev = adapter.normalize(trimmed, index, { keepData });
      if (!ev) {
        parseErrors += 1;
        continue;
      }
      index += 1;
      if (types && !types.has(ev.type)) continue;
      events.push(ev);
      if (limit && events.length >= limit) break;
    }
  }
  applyFinalize(adapter, events);

  return {
    file: '<memory>',
    bytes: 0,
    totalLines: lines.length,
    parseErrors,
    format: adapter?.FORMAT_ID ?? null,
    events,
  };
}

/**
 * Cheap look-ahead: read only the first chunk of a file.
 * Used by catalog/list commands so scanning many sessions never reads them fully.
 */
export async function peekTranscript(file, opts = {}) {
  const { maxBytes = 262144, maxLines = 800 } = opts;
  const stat = await fsp.stat(file);
  const result = {
    file,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    format: null,
    meta: null,
    firstUserMessage: null,
    firstTimestamp: null,
    sampleText: '',
    looksLikeFormat: false,
    userMessageCountInSample: 0,
  };

  const stream = fs.createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  try {
    let n = 0;
    for await (const line of rl) {
      n += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      collected.push(trimmed);
      if (n >= maxLines) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  result.sampleText = collected.join('\n').slice(0, maxBytes);
  const adapter = formats.detect(result.sampleText);
  if (!adapter) return result;
  result.looksLikeFormat = true;
  result.format = adapter.FORMAT_ID;

  const events = [];
  for (const line of collected) {
    const ev = adapter.normalize(line, events.length);
    if (ev) events.push(ev);
  }
  applyFinalize(adapter, events);
  result.meta = adapter.extractMeta(events);
  const first = events.find((e) => e.role === 'user' && e.text);
  result.firstUserMessage = first ? first.text : null;
  result.firstTimestamp = events.find((e) => e.ts != null)?.ts ?? null;
  result.userMessageCountInSample = events.filter((e) => e.role === 'user').length;
  return result;
}

/**
 * Aggregate parse used by `--all`: streams several files and folds them with a
 * reducer so the events of every file are released before the next one starts.
 */
export async function foldTranscripts(files, reducer, opts = {}) {
  for (const file of files) {
    const parsed = await parseTranscript(file, opts);
    reducer(parsed);
  }
}

/* ------------------------------------------------------- multi-source merge */

/** Higher wins when two sources describe the same event equally well. */
const DEFAULT_PRIORITY = 5;

/**
 * How much information an event carries. Used to pick the best copy of a step
 * when a conversation is spread over several logs — a content-elided overview
 * entry scores 0 and can never displace a real transcript entry.
 */
export function eventWeight(ev) {
  return (
    (ev.text?.length ?? 0) +
    (ev.reasoningChars ?? 0) +
    (ev.observationChars ?? 0) +
    (ev.argsText?.length ?? 0) +
    (ev.toolName ? 1 : 0) +
    (ev.requestCount ?? 0)
  );
}

function normaliseSources(sources) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  return list.map((s) =>
    typeof s === 'string'
      ? { path: s, kind: 'primary', priority: DEFAULT_PRIORITY }
      : { priority: DEFAULT_PRIORITY, kind: 'primary', ...s }
  );
}

/**
 * Parse several log files that describe the *same* conversation and merge them
 * into one event list.
 *
 * Antigravity writes a conversation to more than one place and each copy can be
 * incomplete: `transcript_full.jsonl` drops the head of very long sessions,
 * `overview.txt` keeps the whole step skeleton but elides the text of everything
 * except the newest steps, and `chunks/…` holds only the newest slice. Merging
 * them recovers the union — which is how the early tool calls of a truncated
 * session can still be listed.
 *
 * Formats that expose an `ORDER_KEY` are merged by that key (richest copy wins,
 * then highest priority); every other format is simply concatenated in order.
 *
 * @param {Array<string|{path:string,kind?:string,priority?:number}>} sources richest first
 */
export async function parseTranscriptSet(sources, opts = {}) {
  const list = normaliseSources(sources);
  if (!list.length) {
    const err = new Error('parseTranscriptSet: no sources given');
    err.code = 'EFORMAT';
    throw err;
  }

  const parsedList = [];
  for (const src of list) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = await parseTranscript(src.path, opts);
    parsedList.push({ src, parsed });
  }

  const format = parsedList[0].parsed.format;
  const adapter = formats.byId(format);
  const orderKey = adapter && typeof adapter.ORDER_KEY === 'string' ? adapter.ORDER_KEY : null;

  const events = orderKey
    ? mergeKeyedEvents(parsedList, orderKey)
    : parsedList.flatMap((p) => p.parsed.events);

  events.forEach((ev, i) => {
    ev.i = i;
  });

  const bytes = parsedList.reduce((sum, p) => sum + p.parsed.bytes, 0);
  const totalLines = parsedList.reduce((sum, p) => sum + p.parsed.totalLines, 0);
  const parseErrors = parsedList.reduce((sum, p) => sum + p.parsed.parseErrors, 0);

  const sources1 = parsedList.map(({ src, parsed }) => ({
    file: src.path,
    kind: src.kind,
    priority: src.priority,
    bytes: parsed.bytes,
    lines: parsed.totalLines,
    errors: parsed.parseErrors,
    events: parsed.events.length,
    steps: stepSpanOf(parsed.events, orderKey),
  }));

  return {
    file: parsedList[0].parsed.file,
    files: parsedList.map((p) => p.parsed.file),
    bytes,
    totalLines,
    parseErrors,
    format,
    events,
    sources: sources1,
    coverage: coverageOf(events, { orderKey, sources: sources1 }),
  };
}

function mergeKeyedEvents(parsedList, orderKey) {
  const best = new Map();
  for (const { src, parsed } of parsedList) {
    for (const ev of parsed.events) {
      const key = ev[orderKey];
      if (key == null) continue;
      const weight = eventWeight(ev);
      const prev = best.get(key);
      if (!prev) {
        best.set(key, { ev, weight, priority: src.priority ?? 0 });
      } else if (weight > prev.weight || (weight === prev.weight && (src.priority ?? 0) > prev.priority)) {
        prev.ev = ev;
        prev.weight = weight;
        prev.priority = src.priority ?? 0;
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => Number(a.ev[orderKey]) - Number(b.ev[orderKey]))
    .map((r) => r.ev);
}

function stepSpanOf(events, orderKey) {
  if (!orderKey) return null;
  const steps = events.map((e) => Number(e[orderKey])).filter((n) => Number.isFinite(n));
  return steps.length ? { first: Math.min(...steps), last: Math.max(...steps) } : null;
}

/**
 * Describe how much of a conversation is actually readable.
 *
 * `headLostSteps` is the number of leading steps missing from the events (0 when
 * the log is complete); `textSteps`/`firstTextStep` tell how much real prose and
 * tool output survived, because a recovered skeleton step has no text at all.
 */
export function coverageOf(events, { orderKey = null, sources = [] } = {}) {
  const span = stepSpanOf(events, orderKey);
  const withText = events.filter((e) => e.text || e.observationChars);
  const textSteps = withText.map((e) => Number(e[orderKey])).filter((n) => Number.isFinite(n));
  return {
    sources,
    stepSpan: span,
    /** merged steps (a conversation split over several logs counts each step once) */
    steps: events.length,
    /** steps that carry real text or tool output; a `CLEARED` skeleton step carries none */
    textSteps: withText.length,
    firstTextStep: textSteps.length ? Math.min(...textSteps) : null,
    lastTextStep: textSteps.length ? Math.max(...textSteps) : null,
    humanChunks: events.filter((e) => e.role === 'user').length,
    /** leading steps absent from every log */
    headLostSteps: span && span.first > 0 ? span.first : 0,
  };
}

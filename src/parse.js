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

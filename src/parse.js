import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';

import * as adapter from './formats/vscode-transcript.js';

/**
 * Stream-parse a transcript file into normalised events.
 * Memory scales with the number of events, not with the file size on disk.
 *
 * @param {string} file
 * @param {{ keepData?: boolean, types?: Set<string>|null, limit?: number }} [opts]
 * @returns {Promise<{file:string, bytes:number, totalLines:number, parseErrors:number, events:object[]}>}
 */
export async function parseTranscript(file, opts = {}) {
  const { keepData = false, types = null, limit = 0 } = opts;
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

  return { file, bytes: stat.size, totalLines, parseErrors, events };
}

/**
 * Parse an in-memory array of JSONL lines. Handy for tests and for callers that
 * already hold the transcript text.
 *
 * @param {string[]} lines
 * @param {{ keepData?: boolean, types?: Set<string>|null, limit?: number }} [opts]
 */
export function parseLines(lines, opts = {}) {
  const { keepData = false, types = null, limit = 0 } = opts;
  const events = [];
  let parseErrors = 0;
  let index = 0;
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
  return { file: '<memory>', bytes: 0, totalLines: lines.length, parseErrors, events };
}

/**
 * Cheap look-ahead: read only the first chunk of a file.
 * Used by `list` so that scanning 50 transcripts does not read 500 MB.
 *
 * @param {string} file
 * @param {{ maxBytes?: number, maxLines?: number }} [opts]
 */
export async function peekTranscript(file, opts = {}) {
  const { maxBytes = 262144, maxLines = 800 } = opts;
  const stat = await fsp.stat(file);
  const result = {
    file,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
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
  result.looksLikeFormat = adapter.looksLike(result.sampleText);

  const events = [];
  for (const line of collected) {
    const ev = adapter.normalize(line, events.length);
    if (ev) events.push(ev);
  }
  result.meta = adapter.extractMeta(events);
  const first = events.find((e) => e.type === 'user.message' && e.text);
  result.firstUserMessage = first ? first.text : null;
  result.firstTimestamp = events.find((e) => e.ts != null)?.ts ?? null;
  result.userMessageCountInSample = events.filter((e) => e.type === 'user.message').length;
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

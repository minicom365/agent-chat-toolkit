/**
 * Cross-host conversation search and level-of-detail rendering.
 *
 * A conversation is a few hundred thousand characters long, and most of it is tool
 * traffic. Reading it back at full fidelity is rarely what you want, so this module
 * projects a transcript onto four levels before anything is printed:
 *
 *   1 compact   human requests only, hard truncated        "what did I ask for?"
 *   2 dialogue  + assistant prose (no tools, no output)    "what was decided?"
 *   3 actions   + one-line tool badges                     "what did it actually do?"
 *   4 audit     + tool output, arguments, raw payloads      "why did it fail?"
 *
 * Search is level-aware: a level-2 search never matches tool output, so the result
 * list stays free of the noise that makes raw transcript grep useless.
 */
import fs from 'node:fs';

import { parseTranscript } from './parse.js';
import { antigravity } from './hosts/index.js';

export const LEVEL_NAMES = {
  1: 'compact',
  2: 'dialogue',
  3: 'actions',
  4: 'audit',
};

export const LEVEL_DEFAULT_CHARS = { 1: 150, 2: 2000, 3: 3500, 4: 10000 };

export function levelName(level) {
  return LEVEL_NAMES[level] ?? String(level);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Project normalised events onto one detail level.
 * @returns {{kind:'user'|'assistant'|'tool'|'system', label:string, text:string, ts:number|null, matched:boolean}[]}
 */
export function projectLevel(events, level, maxChars) {
  const out = [];
  for (const e of events) {
    if (e.role === 'user') {
      if (level < 1) continue;
      out.push({ kind: 'user', label: 'User', text: clip(e.text, maxChars), ts: e.ts, matched: false });
      continue;
    }
    if (level === 1) continue;

    if (e.role === 'assistant' && e.text) {
      out.push({
        kind: 'assistant',
        label: 'Agent',
        text: clip(e.text, maxChars),
        ts: e.ts,
        matched: false,
      });
      continue;
    }

    // A tool *result* event in a request/result format carries no tool name of its
    // own; it is linked back to its request, so exactly one badge is emitted.
    if (e.linkedToolIndex != null) continue;

    if (level >= 3 && e.role === 'tool' && e.toolName) {
      const detail = e.argsSummary
        ? `:${e.argsSummary.replace(e.toolName, '').replace(/^\(|\)$/g, '')}`
        : '';
      out.push({
        kind: 'tool',
        label: 'Tool',
        text: `[${e.toolName}${detail}]${e.success === false ? ' FAILED' : ''}`,
        ts: e.ts,
        matched: false,
      });
      if (level < 4) continue;
    }
    if (level < 4) continue;

    // Level 4: the raw payload behind the event (tool output for a tool call,
    // the message body for a system event).
    const body = e.observation || e.argsText || e.text;
    if (!body) continue;
    out.push({
      kind: e.role === 'tool' ? 'tool' : 'system',
      label: `${e.toolName ?? e.source ?? e.type}`,
      text: clip(body, maxChars),
      ts: e.ts,
      matched: false,
    });
  }
  return out;
}

/** Does the raw file contain the pattern? Cheap pre-filter before parsing. */
export async function fileContains(file, pattern) {
  if (!pattern) return true;
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let tail = '';
    const onData = (chunk) => {
      const hay = tail + chunk;
      if (pattern.test(hay)) {
        stream.destroy();
        resolve(true);
        return;
      }
      tail = hay.slice(-200);
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(false));
    stream.on('error', () => resolve(false));
  });
}

function makePattern(keyword, { regex = false, ignoreCase = true } = {}) {
  if (!keyword) return null;
  const source = regex ? String(keyword) : String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, ignoreCase ? 'i' : '');
  } catch {
    return new RegExp(String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/**
 * Files a session produced. Only Antigravity keeps artifacts next to the
 * transcript; VS Code sessions carry none, so this returns empty lists there.
 */
export async function artifactsOf(session) {
  if (session.host === 'antigravity' && session.sessionDir) {
    return antigravity.artifactsFor(session.sessionDir);
  }
  return { artifacts: [], scratch: [] };
}

/** Keep a window of ±`radius` entries around every match. */
export function withContext(entries, radius = 1) {
  const keep = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i].matched) continue;
    for (let k = Math.max(0, i - radius); k <= Math.min(entries.length - 1, i + radius); k += 1) keep.add(k);
  }
  return [...keep].sort((a, b) => a - b).map((i) => entries[i]);
}

/**
 * Search a list of sessions.
 *
 * @param {object[]} sessions  unified session records
 * @param {object} opts
 * @param {string} [opts.keyword]
 * @param {boolean} [opts.regex]
 * @param {number} [opts.level]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.maxResults]
 * @param {number} [opts.context]  entries of context around a match
 * @param {(s:object)=>boolean} [opts.filter]
 * @param {boolean} [opts.includeArtifacts]
 */
export async function searchSessions(sessions, opts = {}) {
  const level = opts.level ?? 2;
  const maxChars = opts.maxChars ?? LEVEL_DEFAULT_CHARS[level] ?? 2000;
  const maxResults = opts.maxResults ?? 10;
  const context = opts.context ?? 1;
  const pattern = makePattern(opts.keyword, { regex: opts.regex });
  const results = [];

  for (const s of sessions) {
    if (opts.filter && !opts.filter(s)) continue;

    const { artifacts, scratch } = opts.includeArtifacts === false
      ? { artifacts: [], scratch: [] }
      : await artifactsOf(s);

    const artifactHit = pattern
      ? [...artifacts, ...scratch].some((p) => pattern.test(String(p).split(/[\\/]/).pop() ?? ''))
      : false;

    const skip = !pattern && opts.requireTranscript !== false && !s.transcriptPath;
    if (skip) continue;

    let transcriptWorthParsing = Boolean(s.transcriptPath);
    if (pattern && transcriptWorthParsing && level < 4) {
      // For levels 1-3 the match must be in prose, which the raw grep covers too;
      // a raw miss means no prose can match, so the parse can be skipped.
      transcriptWorthParsing = await fileContains(s.transcriptPath, pattern);
    }
    if (pattern && !transcriptWorthParsing && !artifactHit) continue;

    let entries = [];
    let parseError = null;
    if (transcriptWorthParsing) {
      try {
        const parsed = await parseTranscript(s.transcriptPath);
        entries = projectLevel(parsed.events, level, maxChars);
      } catch (err) {
        parseError = err?.message ?? String(err);
      }
    }

    let matchedCount = 0;
    if (pattern) {
      for (const e of entries) {
        const hit = pattern.test(e.text);
        e.matched = hit;
        if (hit) matchedCount += 1;
      }
    }
    if (pattern && matchedCount === 0 && !artifactHit) continue;

    const shown = pattern ? withContext(entries, context) : entries;
    results.push({
      session: s,
      level,
      matchedCount,
      artifactHit,
      artifacts,
      scratch,
      entries: shown,
      truncated: pattern ? shown.length < entries.length : false,
      totalEntries: entries.length,
      parseError,
    });

    if (results.length >= maxResults) break;
  }

  return results;
}

/**
 * Generic event querying over a normalised transcript.
 * All filters are AND-combined; every filter is optional.
 */
import { localStamp } from './util.js';

export function buildFilter(opts = {}) {
  const types = toSet(opts.type);
  const roles = toSet(opts.role);
  const tools = toSet(opts.tool);
  const scope = opts.grepScope ?? 'content';
  let grep = null;
  if (opts.grep) grep = opts.grep instanceof RegExp ? opts.grep : new RegExp(opts.grep, opts.ignoreCase === false ? '' : 'i');

  return function match(e) {
    if (types && !types.has(e.type)) return false;
    if (roles && !roles.has(e.role)) return false;
    if (tools && !(e.toolName && tools.has(e.toolName))) return false;
    if (opts.since != null && !(e.ts != null && e.ts >= opts.since)) return false;
    if (opts.until != null && !(e.ts != null && e.ts <= opts.until)) return false;
    if (opts.textOnly && !e.text) return false;
    if (grep) {
      const hay = grepHaystack(e, scope);
      if (!hay || !grep.test(hay)) return false;
    }
    return true;
  };
}

export function grepHaystack(e, scope) {
  if (scope === 'args') return e.argsText || '';
  if (scope === 'output' || scope === 'observation') return e.observation || '';
  if (scope === 'tool') return e.toolName || '';
  if (scope === 'all') {
    return [e.text, e.argsText, e.observation, e.toolName].filter(Boolean).join('\n');
  }
  return e.text || '';
}

export function queryEvents(events, opts = {}) {
  const match = typeof opts.match === 'function' ? opts.match : buildFilter(opts);
  const out = [];
  for (let k = 0; k < events.length; k += 1) {
    const e = events[k];
    if (opts.fromIndex != null && e.i < opts.fromIndex) continue;
    if (opts.toIndex != null && e.i > opts.toIndex) continue;
    if (!match(e)) continue;
    out.push(e);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

export function toRows(events) {
  return events.map((e) => ({
    i: e.i,
    ts: e.ts,
    time: e.ts == null ? '-' : new Date(e.ts).toISOString(),
    local: e.ts == null ? '-' : localStamp(e.ts),
    type: e.type,
    role: e.role,
    tool: e.toolName ?? '',
    chars: e.chars,
    argsChars: e.argsChars,
    success: e.success === null ? '' : String(e.success),
    preview: previewOf(e),
  }));
}

export function previewOf(e, max = 160) {
  const raw =
    e.type === 'tool.execution_start'
      ? e.argsText
      : e.text || e.argsText || e.observation || '';
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toSet(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  return list.length ? new Set(list) : null;
}

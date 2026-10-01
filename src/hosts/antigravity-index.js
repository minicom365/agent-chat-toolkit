/**
 * Antigravity sidebar index reader.
 *
 * The list of conversations the Antigravity UI shows is stored in the app's
 * global state, not in a database table:
 *
 *   <appProfile>/User/globalStorage/state.vscdb
 *     ItemTable['antigravityUnifiedStateSync.trajectorySummaries']
 *
 * The value is **base64-encoded protobuf**, not encrypted. Frame the outer
 * message as a repeated field 1, each entry being:
 *
 *   entry        { 1: conversationId (uuid), 2: { 1: base64(summary) } }
 *   summary      { 1: title?, 2: stepCount, 3: created Timestamp,
 *                 4: trajectoryId?, 9: { 1: workspaceUri }, 10: lastModified Timestamp,
 *                 17: { 1: workspace, 2: created, 7: workspaceUri } }
 *
 * Field numbers were derived by reading real values, so the reader below is
 * deliberately schema-light: it pulls out identifiers, workspace URIs and
 * timestamps by *shape* (see `src/protobuf.js`) instead of by a fixed schema, and
 * reports nothing rather than guessing when a value does not look right.
 *
 * Why this matters: an entry missing from this index is invisible in the UI even
 * though its data is still on disk. Detecting that difference is the whole point
 * of `recovered` sessions.
 */
import path from 'node:path';

import { openReadOnly, readItem, sqliteAvailable } from '../sqlite.js';
import {
  collectStrings,
  collectTimestamps,
  decodeBase64Message,
  walk,
  walkNested,
} from '../protobuf.js';

export const SIDEBAR_KEY = 'antigravityUnifiedStateSync.trajectorySummaries';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URI_PREFIX = /^file:\/\//i;

/**
 * Decode a `trajectorySummaries` payload.
 * @param {Buffer} buf
 * @returns {Map<string, object>} conversationId -> summary
 */
export function parseSidebarIndex(buf) {
  const out = new Map();
  let root;
  try {
    root = walk(buf);
  } catch {
    return out;
  }
  for (const entry of root) {
    if (entry.field !== 1 || !entry.bytes) continue;
    const kids = walkNested(entry);
    if (!kids) continue;

    const idField = kids.find((f) => f.field === 1 && f.bytes);
    const id = idField ? decodeText(idField.bytes) : null;
    if (!id || !UUID_RE.test(id)) continue;

    const summary = decodeSummary(kids);
    out.set(id.toLowerCase(), summary);
  }
  return out;
}

function decodeSummary(kids) {
  const summaryField = kids.find((f) => f.field === 2 && f.bytes);
  let fields = null;
  if (summaryField) {
    const inner = walkNested(summaryField);
    const b64Field = inner?.find((f) => f.field === 1 && f.bytes);
    if (b64Field) {
      const text = decodeText(b64Field.bytes);
      fields = decodeBase64Message(text) ?? walkNested(b64Field) ?? null;
    }
    if (!fields) fields = inner;
  }
  if (!fields) return { title: null, stepCount: null, createdMs: null, updatedMs: null, workspaceUris: [], trajectoryId: null };

  const strings = collectStrings(fields);
  const uris = [...new Set(strings.filter((s) => URI_PREFIX.test(s)))];
  const uuidStrings = strings.filter((s) => UUID_RE.test(s) && !URI_PREFIX.test(s));

  const titleField = fields.find((f) => f.field === 1 && f.bytes);
  let title = titleField ? decodeText(titleField.bytes) : null;
  if (title && (UUID_RE.test(title) || URI_PREFIX.test(title) || title.length > 400)) title = null;

  const stepField = fields.find((f) => f.field === 2 && f.wire === 0);
  const stepCount = stepField ? Number(stepField.varint) : null;

  const times = collectTimestamps(fields).sort((a, b) => a - b);
  const plausible = times.filter((t) => t > Date.UTC(2020, 0, 1) && t < Date.UTC(2100, 0, 1));

  return {
    title,
    stepCount: Number.isFinite(stepCount) ? stepCount : null,
    createdMs: plausible.length ? plausible[0] : null,
    updatedMs: plausible.length ? plausible[plausible.length - 1] : null,
    workspaceUris: uris,
    trajectoryId: uuidStrings[0] ?? null,
  };
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read the sidebar index of one app profile.
 * @param {string} dbPath `<appProfile>/User/globalStorage/state.vscdb`
 */
export function readSidebarIndex(dbPath) {
  if (!sqliteAvailable()) return { available: false, ids: new Set(), entries: new Map(), reason: 'node:sqlite unavailable' };
  let raw;
  try {
    raw = readItem(dbPath, SIDEBAR_KEY);
  } catch (err) {
    return { available: false, ids: new Set(), entries: new Map(), reason: err.message };
  }
  if (!raw) return { available: false, ids: new Set(), entries: new Map(), reason: 'key absent' };
  let bytes;
  try {
    bytes = Buffer.from(raw, 'base64');
  } catch {
    return { available: false, ids: new Set(), entries: new Map(), reason: 'not base64' };
  }
  const entries = parseSidebarIndex(bytes);
  return {
    available: true,
    ids: new Set(entries.keys()),
    entries,
    reason: null,
    rawBytes: bytes.length,
  };
}

/** Candidate app profiles for every Antigravity product on this machine. */
export async function findAppProfiles(appDataRoots) {
  const out = [];
  for (const root of appDataRoots) {
    for (const product of ['Antigravity', 'Antigravity IDE', 'antigravity', 'antigravity-ide']) {
      const dir = path.join(root, product);
      const db = path.join(dir, 'User', 'globalStorage', 'state.vscdb');
      // eslint-disable-next-line no-await-in-loop
      const index = readSidebarIndex(db);
      if (!index.available) continue;
      const key = `${dir.toLowerCase()}`;
      if (out.some((p) => p.dir.toLowerCase() === key)) continue;
      out.push({ dir, product, db, index });
    }
  }
  return out;
}

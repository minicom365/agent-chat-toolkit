/**
 * Antigravity host.
 *
 * Antigravity is a VS Code fork, and it keeps two independent stores:
 *
 *   ~/.gemini/<instance>/                     "instances" (one per install/backup)
 *       brain/<id>/.system_generated/logs/transcript_full.jsonl   conversation content
 *       brain/<id>/scratch|*.md                                   artifacts
 *       conversation_summaries.db                                 SQLite catalog
 *       annotations/<id>.pbtxt                                    title, last view
 *
 *   <appProfile>/User/globalStorage/state.vscdb                    what the UI shows
 *       ItemTable['antigravityUnifiedStateSync.trajectorySummaries']
 *
 * Instances seen in the wild: `antigravity` (current), `antigravity-ide`
 * (the IDE build) and `antigravity-backup` (a snapshot of an older profile).
 * They are discovered generically as `~/.gemini/*antigravity*`, so a future
 * rename does not need a code change.
 *
 * The important consequence: **content and visibility live in different places.**
 * A conversation can have a complete transcript on disk and still be invisible in
 * the sidebar because its entry is missing from `trajectorySummaries`. That state
 * is reported as `hidden` (see also `docs/ANTIGRAVITY.md`).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openReadOnly, sqliteAvailable } from '../sqlite.js';
import { fileUriToPath } from './vscode.js';
import { findAppProfiles } from './antigravity-index.js';

export const HOST_ID = 'antigravity';
export const HOST_LABEL = 'Antigravity';
export const TRANSCRIPT_FORMAT = 'antigravity-transcript';

const NAME_HINT = 'antigravity';

/**
 * The step logs the app keeps per conversation. `priority` decides which copy of
 * a duplicated step wins when the sources are merged: a real transcript beats the
 * content-elided overview.
 */
const LOG_FILES = {
  'transcript_full.jsonl': { kind: 'transcript-full', variant: 'full', priority: 4 },
  'transcript.jsonl': { kind: 'transcript', variant: 'short', priority: 3 },
  'overview.txt': { kind: 'overview', variant: 'overview', priority: 2 },
};

const CHUNK_DIRS = {
  transcript_full: { kind: 'chunk-full', variant: 'full', priority: 3 },
  transcript: { kind: 'chunk', variant: 'short', priority: 2 },
};

export function geminiDir() {
  return process.env.GEMINI_DIR || path.join(os.homedir(), '.gemini');
}

/** OS roots that hold application profiles (`%APPDATA%`, `Application Support`, …). */
export function appDataRoots() {
  const roots = [];
  if (process.env.ANTIGRAVITY_PROFILE_DIR) roots.push(process.env.ANTIGRAVITY_PROFILE_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(appData);
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support'));
  } else {
    roots.push(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  }
  return roots;
}

export function dataRoots() {
  return [geminiDir()];
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * Every Antigravity instance directory.
 * @param {string[]|null} roots explicit instance (or `~/.gemini`) directories
 */
export async function instances(roots = null) {
  const bases = roots?.length ? roots.map((r) => path.resolve(r)) : [geminiDir()];
  const out = [];
  const seen = new Set();

  const consider = async (dir, name) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    const brainDir = path.join(dir, 'brain');
    const catalogDb = path.join(dir, 'conversation_summaries.db');
    const [brainStat, catalogStat, cacheStat] = await Promise.all([statOrNull(brainDir), statOrNull(catalogDb), statOrNull(path.join(dir, 'cache.json'))]);
    if (!brainStat && !catalogStat && !cacheStat) return;
    seen.add(key);
    out.push({
      name,
      dir,
      brainDir: brainStat ? brainDir : null,
      catalogDb: catalogStat ? catalogDb : null,
      annotationsDir: (await statOrNull(path.join(dir, 'annotations'))) ? path.join(dir, 'annotations') : null,
      cacheFile: cacheStat ? path.join(dir, 'cache.json') : null,
      isBackup: /backup/i.test(name),
      isIde: /-?ide\b/i.test(name),
    });
  };

  for (const base of bases) {
    // A root may be `~/.gemini` (scan children) or one instance directory.
    const baseStat = await statOrNull(base);
    if (!baseStat) continue;
    if (path.basename(base).toLowerCase().includes(NAME_HINT)) {
      await consider(base, path.basename(base));
    }
    let entries = [];
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.toLowerCase().includes(NAME_HINT)) continue;
      await consider(path.join(base, e.name), e.name);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function transcriptPathFor(brainDir, id) {
  return {
    full: path.join(brainDir, id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    short: path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'),
  };
}

/** Prefer the untruncated log when both exist. */
export async function pickTranscript(brainDir, id) {
  const sources = await logSourcesFor(brainDir, id);
  if (!sources.length) return null;
  const primary = sources[0];
  return { path: primary.path, stat: { size: primary.bytes, mtimeMs: primary.mtimeMs }, variant: primary.variant };
}

/**
 * Every log the app keeps for one conversation, richest first.
 *
 * Antigravity spreads a single conversation over several files that overlap and
 * complement each other:
 *
 *   transcript_full.jsonl  the untruncated tail (can lose the head of a long session)
 *   transcript.jsonl       the capped twin of the above
 *   chunks/…/NNNNNNNN.jsonl the newest slice, appended between flushes
 *   overview.txt           the full step skeleton; its `content` is elided for all but
 *                          the newest steps (`status: "CLEARED"` means the text was dropped)
 *
 * Merging them recovers the step timeline of the whole conversation even when
 * `transcript_full.jsonl` lost its head, which is the only source that still holds
 * the early tool calls.
 */
export async function logSourcesFor(brainDir, id) {
  if (!brainDir) return [];
  const logs = path.join(brainDir, id, '.system_generated', 'logs');
  const out = [];
  for (const [name, meta] of Object.entries(LOG_FILES)) {
    const file = path.join(logs, name);
    const stat = await statOrNull(file);
    if (stat) {
      out.push({ path: file, kind: meta.kind, variant: meta.variant, priority: meta.priority, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  for (const [dir, meta] of Object.entries(CHUNK_DIRS)) {
    const base = path.join(logs, 'chunks', dir);
    let entries = [];
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(base, e.name);
      const stat = await statOrNull(file);
      if (!stat) continue;
      out.push({ path: file, kind: meta.kind, variant: meta.variant, priority: meta.priority, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
}

/**
 * Read just enough of a step log to learn which step it starts and ends at.
 * Both files are written in ascending step order, so the first and last lines
 * bound the range.
 */
export async function stepRangeOf(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const headLen = Math.min(size, 4096);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const first = parseStepIndex(head.toString('utf8'));
    if (first === null) return null;
    const tailLen = Math.min(size, 8192);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const tailText = tail.toString('utf8');
    const lines = tailText.split('\n').filter((l) => l.trim());
    let last = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      last = parseStepIndex(lines[i]);
      if (last !== null) break;
    }
    return { first, last: last ?? first };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

function parseStepIndex(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const o = JSON.parse(trimmed);
      if (o && Number.isFinite(Number(o.step_index))) return Number(o.step_index);
    } catch {
      /* not a step line */
    }
  }
  return null;
}

/**
 * Cheap head-loss check for the session list: read the first/last step of the
 * content transcript and of the overview skeleton only (chunks are always a
 * subset of the tail, so they never change the answer).
 *
 * Two different things can be missing, and conflating them hides real data loss:
 *
 *   headLostSteps          steps missing from the *content* transcript — the text
 *                          may still be described by `overview.txt`
 *   unrecoverableHeadSteps steps missing from *every* log — genuinely gone
 */
async function coverageFor(sources) {
  const full = sources.find((s) => s.kind === 'transcript-full') ?? sources.find((s) => s.kind === 'transcript');
  const overview = sources.find((s) => s.kind === 'overview');
  const noData = { headLostSteps: 0, unrecoverableHeadSteps: 0, stepSpan: null, hasOverview: false };
  if (!full && !overview) return noData;

  const [fullRange, overviewRange] = await Promise.all([
    full ? stepRangeOf(full.path) : null,
    overview ? stepRangeOf(overview.path) : null,
  ]);

  const firsts = [fullRange?.first, overviewRange?.first].filter((v) => v != null);
  const lasts = [fullRange?.last, overviewRange?.last].filter((v) => v != null);
  const first = firsts.length ? Math.min(...firsts) : null;
  return {
    headLostSteps: fullRange && fullRange.first > 0 ? fullRange.first : 0,
    unrecoverableHeadSteps: first != null && first > 0 ? first : 0,
    stepSpan: first != null ? { first, last: Math.max(...lasts) } : null,
    hasOverview: Boolean(overviewRange),
  };
}

export async function artifactsFor(sessionDir) {
  const artifacts = [];
  const scratch = [];
  try {
    for (const e of await fsp.readdir(sessionDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.md')) artifacts.push(path.join(sessionDir, e.name));
    }
  } catch {
    /* none */
  }
  try {
    const dir = path.join(sessionDir, 'scratch');
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.isFile()) scratch.push(path.join(dir, e.name));
    }
  } catch {
    /* none */
  }
  return { artifacts, scratch };
}

function parseWorkspaceUris(raw) {
  if (!raw) return [];
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed;
    else if (typeof parsed === 'string') list = [parsed];
  } catch {
    list = String(raw).split(/[,\s]+/).filter(Boolean);
  }
  return list.filter((u) => typeof u === 'string');
}

/** Read one instance's SQLite catalog. Returns [] when unavailable. */
export function readCatalog(dbPath) {
  if (!dbPath || !sqliteAvailable()) return [];
  let con;
  try {
    con = openReadOnly(dbPath);
    return con
      .prepare(
        'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, ' +
          'status, last_user_input_time, app_data_dir, parent_conversation_id, nesting_depth ' +
          'FROM conversation_summaries'
      )
      .all();
  } catch {
    return [];
  } finally {
    try {
      con?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Title fallback for conversations that are not in the catalog. */
export async function readAnnotationTitle(instanceDir, id) {
  try {
    const text = await fsp.readFile(path.join(instanceDir, 'annotations', `${id}.pbtxt`), 'utf8');
    const m = /title\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) return m[1].replace(/\\"/g, '"');
  } catch {
    /* none */
  }
  return null;
}

/**
 * The third-party history extension keeps its own catalog at
 * `<instance>/cache.json`; useful when `conversation_summaries.db` is gone.
 */
export async function readHistoryCaches(instanceList) {
  const map = new Map();
  for (const inst of instanceList) {
    if (!inst.cacheFile) continue;
    try {
      const data = JSON.parse(await fsp.readFile(inst.cacheFile, 'utf8'));
      for (const [id, meta] of Object.entries(data?.conversations ?? {})) {
        if (!map.has(id.toLowerCase())) map.set(id.toLowerCase(), meta);
      }
    } catch {
      /* ignore a corrupt cache */
    }
  }
  return map;
}

function parsePbTime(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T'));
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1)) return null;
  return t;
}

function normaliseTime(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  // Reject sentinel dates (`0001-01-01`) that some stores write for "never".
  if (ms < Date.UTC(2000, 0, 1)) return null;
  return ms;
}

/**
 * Match each app profile (which holds the sidebar index) to the instance whose
 * conversations it indexes, by identifier overlap. Matching on data instead of on
 * directory names keeps this working when a product is renamed.
 */
function matchProfiles(instanceList, profiles) {
  const result = new Map();
  for (const inst of instanceList) {
    // A backup snapshot is not indexed by any live app profile, so its visibility
    // is genuinely unknown - reporting it would be a guess.
    if (inst.isBackup) {
      result.set(inst.name, null);
      continue;
    }
    const ids = new Set(inst.ids.map((x) => x.toLowerCase()));
    const wantIde = inst.name.toLowerCase().includes('ide');
    let best = null;
    for (const p of profiles) {
      const isIde = p.product.toLowerCase().includes('ide');
      if (isIde !== wantIde) continue;
      let hit = 0;
      for (const id of p.index.ids) if (ids.has(id)) hit += 1;
      if (hit > 0 && (!best || hit > best.hit)) best = { profile: p, hit };
    }
    result.set(inst.name, best);
  }
  return result;
}

/**
 * The unified conversation catalog for the Antigravity host.
 * @param {{roots?: string[]|null, limit?: number, profileRoots?: string[]|null}} [opts]
 */
export async function listSessions({ roots = null, limit = 0, profileRoots = null } = {}) {
  const instanceList = await instances(roots);
  if (!instanceList.length) return [];

  // 1) gather ids per instance so profiles can be matched by overlap
  const perInstance = [];
  for (const inst of instanceList) {
    const catalog = readCatalog(inst.catalogDb);
    let brainIds = [];
    if (inst.brainDir) {
      try {
        brainIds = (await fsp.readdir(inst.brainDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && /^[0-9a-f-]{8,}$/i.test(e.name))
          .map((e) => e.name);
      } catch {
        brainIds = [];
      }
    }
    const ids = new Set([...catalog.map((r) => rowId(r)), ...brainIds].filter(Boolean));
    perInstance.push({ inst, catalog, brainIds, ids: [...ids] });
  }

  // 2) app profiles (sidebar index) — explicit roots win over OS defaults
  const rootsForProfiles = profileRoots?.length ? profileRoots : null;
  const profiles = await findAppProfiles(rootsForProfiles ?? appDataRoots());
  const matches = matchProfiles(perInstance.map((p) => ({ ...p.inst, ids: p.ids })), profiles);
  const historyCache = await readHistoryCaches(instanceList);

  const sessions = [];
  for (const { inst, catalog, brainIds } of perInstance) {
    const matched = matches.get(inst.name) ?? null;
    const sidebar = matched?.profile.index ?? null;
    const sidebarIds = sidebar?.ids ?? null;

    const rows = new Map();
    for (const r of catalog) {
      const id = rowId(r);
      if (id) rows.set(id.toLowerCase(), r);
    }

    const allIds = new Set([...rows.keys(), ...brainIds.map((x) => x.toLowerCase())]);
    for (const id of sidebarIds ?? []) allIds.add(id);

    for (const id of allIds) {
      const row = rows.get(id);
      const cached = historyCache.get(id) ?? null;
      const entry = sidebar?.entries?.get(id) ?? null;
      const logSources = await logSourcesFor(inst.brainDir, id);
      const transcript = logSources.length
        ? { path: logSources[0].path, stat: { size: logSources[0].bytes, mtimeMs: logSources[0].mtimeMs }, variant: logSources[0].variant }
        : null;
      const sessionDir = inst.brainDir ? path.join(inst.brainDir, id) : null;
      const dirStat = sessionDir ? await statOrNull(sessionDir) : null;
      const storeKind = await detectStoreKind(path.join(inst.dir, 'conversations'), id);
      const { headLostSteps, unrecoverableHeadSteps, stepSpan, hasOverview } = await coverageFor(logSources);

      const uris = entry?.workspaceUris?.length
        ? entry.workspaceUris
        : cached?.workspaces?.map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean)?.length
          ? cached.workspaces.map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean)
          : parseWorkspaceUris(row?.workspace_uris);

      const sources = [];
      if (row) sources.push('catalog');
      if (dirStat) sources.push('brain');
      if (entry) sources.push('sidebar');
      if (cached) sources.push('cache');
      if (transcript) sources.push('transcript');

      const title =
        row?.title ||
        entry?.title ||
        cached?.summary ||
        (await readAnnotationTitle(inst.dir, id)) ||
        row?.preview ||
        cached?.preview ||
        '(untitled)';

      const updatedMs =
        entry?.updatedMs ??
        parsePbTime(row?.last_modified_time) ??
        normaliseTime(cached?.lastModifiedTime) ??
        transcript?.stat.mtimeMs ??
        null;

      sessions.push({
        host: HOST_ID,
        instance: inst.name,
        instanceDir: inst.dir,
        isBackup: inst.isBackup,
        isIde: inst.isIde,
        id: row?.conversation_id ?? id,
        title,
        preview: row?.preview ?? cached?.preview ?? null,
        project: uris.map(fileUriToPath).filter(Boolean).join(', ') || null,
        workspaceUri: uris[0] ?? null,
        workspaceUris: uris,
        appDir: inst.dir,
        brainDir: inst.brainDir,
        sessionDir: dirStat ? sessionDir : null,
        statePath: null,
        transcriptPath: transcript?.path ?? null,
        transcriptVariant: transcript?.variant ?? null,
        /** every step log for this conversation, richest first (overview.txt included) */
        logSources,
        logSourceKinds: logSources.map((s) => s.kind),
        /** steps dropped from the head of the content transcript (0 = complete) */
        headLostSteps,
        /** steps missing from every log, i.e. gone for good */
        unrecoverableHeadSteps,
        /** [first, last] step index across all logs */
        stepSpan,
        hasOverview,
        updatedMs,
        createdMs: entry?.createdMs ?? normaliseTime(cached?.createdTime) ?? null,
        lastUserInputMs: parsePbTime(row?.last_user_input_time) ?? normaliseTime(cached?.lastUserInputTime),
        sizeBytes: transcript?.stat.size ?? 0,
        steps: entry?.stepCount ?? (Number(row?.step_count ?? cached?.stepCount ?? 0) || null),
        indexPath: inst.catalogDb,
        /** present in the SQLite catalog (or rebuilt from a file) */
        indexed: Boolean(row),
        /** listed in the app's own sidebar state (`trajectorySummaries`); null = no profile matched */
        inIndex: sidebarIds ? sidebarIds.has(id) : null,
        /** per-conversation store: the current protobuf `.pb` or the older `.db` */
        storeKind,
        /** what that store means for recoverability */
        storeNote: storeKindNote(storeKind),
        /**
         * The conversation exists but its content is only in the encrypted store:
         * no readable log, and a `.pb` store no key on this machine can open.
         * This is the state that is genuinely unrecoverable offline.
         */
        locked: Boolean(!transcript && storeKind === 'pb'),
        /** readable here (a transcript log exists) but not listed by the app */
        recoverable: Boolean(transcript) && (sidebarIds ? !sidebarIds.has(id) : false),
        sidebarProfile: matched?.profile.dir ?? null,
        sources,
        status: row?.status ?? cached?.status ?? null,
        parentId: row?.parent_conversation_id || null,
        nestingDepth: Number(row?.nesting_depth ?? 0),
      });

      if (limit && sessions.length >= limit) return sortSessions(sessions);
    }
  }

  return sortSessions(sessions);
}

/**
 * The per-conversation store. Two generations exist, and the *newer* one is the
 * readable one:
 *
 *   `<id>.pb`  encrypted protobuf. Measured across a full install: entropy 8.000
 *              bits/byte, no container or compression magic, no key on disk.
 *              Written by `jetski/cortex/proto_saver.DiskSaver` when its
 *              `WithEncryptionKey` option is set. Dated 2025-11 … 2026-08-13.
 *
 *   `<id>.db`  plain SQLite whose blob columns are ordinary protobuf — no key
 *              needed. Dated 2026-08-03 … onwards, i.e. the app *dropped*
 *              encryption at that cutover. A conversation never appears in both
 *              formats.
 *
 * The kind is worth reporting because it decides whether a conversation with no
 * readable log can be recovered at all: a `.pb` one cannot, a `.db` one can.
 */
async function detectStoreKind(conversationsDir, id) {
  if (await statOrNull(path.join(conversationsDir, `${id}.pb`))) return 'pb';
  if (await statOrNull(path.join(conversationsDir, `${id}.db`))) return 'db';
  return null;
}

/** Why a store kind matters, in one short phrase (used by the report). */
export function storeKindNote(kind) {
  if (kind === 'pb') return 'encrypted protobuf (older generation) - not readable offline';
  if (kind === 'db') return 'plaintext SQLite + protobuf blobs (newer generation) - readable';
  return 'no per-conversation store';
}

function rowId(row) {
  const id = row?.conversation_id;
  return typeof id === 'string' && id ? id : null;
}

export function sortSessions(list) {
  return list.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

/** Per-instance summary used by the `hosts` command. */
export async function instanceSummary() {
  const list = await instances(null);
  const out = [];
  for (const inst of list) {
    const rows = readCatalog(inst.catalogDb);
    let brainCount = 0;
    if (inst.brainDir) {
      try {
        brainCount = (await fsp.readdir(inst.brainDir)).length;
      } catch {
        brainCount = 0;
      }
    }
    out.push({
      name: inst.name,
      dir: inst.dir,
      kind: inst.isBackup ? 'backup' : inst.isIde ? 'ide' : 'app',
      catalogRows: rows.length,
      brainSessions: brainCount,
      hasCatalog: Boolean(inst.catalogDb),
      indexedByApp: inst.isBackup ? null : undefined,
    });
  }
  return out;
}

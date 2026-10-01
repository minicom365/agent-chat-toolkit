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
  if (!brainDir) return null;
  const { full, short } = transcriptPathFor(brainDir, id);
  const fullStat = await statOrNull(full);
  if (fullStat) return { path: full, stat: fullStat, variant: 'full' };
  const shortStat = await statOrNull(short);
  if (shortStat) return { path: short, stat: shortStat, variant: 'short' };
  return null;
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
      const transcript = await pickTranscript(inst.brainDir, id);
      const sessionDir = inst.brainDir ? path.join(inst.brainDir, id) : null;
      const dirStat = sessionDir ? await statOrNull(sessionDir) : null;
      const storeKind = await detectStoreKind(path.join(inst.dir, 'conversations'), id);

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
 * The per-conversation store: current builds write `<id>.pb` (protobuf), older
 * ones wrote `<id>.db` (SQLite). Which one is present correlates strongly with
 * whether the app still lists the conversation, so it is worth reporting.
 */
async function detectStoreKind(conversationsDir, id) {
  if (await statOrNull(path.join(conversationsDir, `${id}.pb`))) return 'pb';
  if (await statOrNull(path.join(conversationsDir, `${id}.db`))) return 'db';
  return null;
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

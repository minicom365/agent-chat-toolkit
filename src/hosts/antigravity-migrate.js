/**
 * Antigravity conversation migration and project registration.
 *
 * VS Code infers where a conversation belongs from the storage folder it sits in.
 * Antigravity instead keeps an explicit registry, and that registry answers every
 * question a migration has to:
 *
 *   ~/.gemini/<instance>/conversations/<id>.pb | .db   the store itself
 *   ~/.gemini/<instance>/conversation_summaries.db     the registry
 *
 *   conversation_id  primary key
 *   app_data_dir     which instance owns the store      -> "move to another build"
 *   workspace_uris   JSON array of file:// URIs         -> "which project space"
 *   project_id       project-space UUID, '' = unassigned
 *   step_count       what the UI shows before it opens the conversation
 *
 * So moving a conversation between Antigravity builds, or re-registering it under
 * a different project, is a store copy plus one row. This module plans that; it
 * never deletes, and it is dry-run unless the caller passes `apply`.
 *
 * Not handled here: the UI also caches its sidebar list in
 * `state.vscdb['antigravityUnifiedStateSync.trajectorySummaries']`. The registry
 * is the durable record and the cache is expected to be rebuilt from it, but that
 * has not been confirmed against a running build, so the cache is left alone.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { backupFile, assertSafeWriteTarget } from '../safety.js';
import { openWritable, query, sqliteAvailable } from '../sqlite.js';

export const HOST_ID = 'antigravity';
export const REGISTRY_DB = 'conversation_summaries.db';
export const REGISTRY_TABLE = 'conversation_summaries';
export const STORE_EXTENSIONS = ['.pb', '.db'];

/**
 * Root of the `.gemini` tree. An explicit `home` wins; otherwise GEMINI_DIR is
 * honoured, matching how the rest of the toolkit discovers Antigravity.
 */
export function geminiRoot(home) {
  if (home) return path.join(home, '.gemini');
  return process.env.GEMINI_DIR || path.join(os.homedir(), '.gemini');
}

export function conversationsDir(instance, home) {
  return path.join(geminiRoot(home), instance, 'conversations');
}

export function catalogPath(instance, home) {
  return path.join(geminiRoot(home), instance, REGISTRY_DB);
}

/** Every Antigravity instance on this machine that has a conversation folder. */
export async function listInstances(home) {
  const root = geminiRoot(home);
  let names = [];
  try {
    names = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of names) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name, 'conversations');
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const stores = await listStores(e.name, home);
    out.push({
      instance: e.name,
      dir,
      conversations: stores.size,
      hasRegistry: Boolean(await statOrNull(catalogPath(e.name, home))),
    });
  }
  return out.sort((a, b) => b.conversations - a.conversations);
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * Conversation id -> the store files that exist for it, with sizes and mtimes.
 * A conversation can legitimately have both a `.pb` and a `.db`; nothing in the
 * measured profile did, but the shape allows it.
 */
export async function listStores(instance, home) {
  const dir = conversationsDir(instance, home);
  const out = new Map();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const ext = path.extname(name);
    if (!STORE_EXTENSIONS.includes(ext)) continue;
    const id = path.basename(name, ext);
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const full = path.join(dir, name);
    // eslint-disable-next-line no-await-in-loop
    const stat = await statOrNull(full);
    if (!stat) continue;
    const entry = out.get(id) ?? { id, files: [], bytes: 0, mtimeMs: 0, kinds: [] };
    entry.files.push({ path: full, kind: ext.slice(1), bytes: stat.size, mtimeMs: stat.mtimeMs });
    entry.bytes += stat.size;
    entry.mtimeMs = Math.max(entry.mtimeMs, stat.mtimeMs);
    entry.kinds.push(ext.slice(1));
    out.set(id, entry);
  }
  return out;
}

/** One registry row, or null when the conversation is not registered. */
export function readRegistration(instance, id, home) {
  if (!sqliteAvailable()) return null;
  const rows = query(
    catalogPath(instance, home),
    `SELECT * FROM ${REGISTRY_TABLE} WHERE conversation_id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

/** Column order of the registry table, so inserts can be built generically. */
export function registryColumns(instance, home) {
  return query(catalogPath(instance, home), `PRAGMA table_info(${REGISTRY_TABLE})`)
    .sort((a, b) => a.cid - b.cid)
    .map((c) => c.name);
}

/** All registry rows for an instance. */
export function readRegistry(instance, home) {
  return query(catalogPath(instance, home), `SELECT * FROM ${REGISTRY_TABLE}`);
}

function jsonUriList(uris) {
  return JSON.stringify(uris.filter(Boolean));
}

/** Accept either a JSON array string (as stored) or an array, and return an array. */
export function parseUriList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Plan moving one conversation into another instance, and/or assigning it to a
 * project space. Pure inspection: nothing is written.
 *
 * @param {object} opts
 * @param {string} opts.id               conversation id
 * @param {string} opts.fromInstance     instance currently holding the store
 * @param {string} opts.toInstance       instance that should hold it
 * @param {string} [opts.workspaceUri]   `file:///…` URI to register under
 * @param {string} [opts.projectId]      project-space UUID ('' clears it)
 * @param {string} [opts.title]          title for an unregistered conversation
 * @param {string} [opts.home]
 */
export async function planMigration(opts) {
  const {
    id,
    fromInstance,
    toInstance,
    workspaceUri = null,
    projectId = undefined,
    title = null,
    home,
  } = opts;

  const plan = {
    id,
    fromInstance,
    toInstance,
    copies: [],
    registration: null,
    warnings: [],
    sameInstance: fromInstance === toInstance,
  };

  const sourceStores = await listStores(fromInstance, home);
  const store = sourceStores.get(id);
  if (!store) {
    plan.warnings.push(`No store found for ${id} in ${fromInstance}.`);
    return plan;
  }

  const targetDir = conversationsDir(toInstance, home);
  const targetStores = await listStores(toInstance, home);

  for (const f of store.files) {
    const dst = path.join(targetDir, path.basename(f.path));
    const existing = targetStores.get(id)?.files.find((t) => t.kind === f.kind);
    plan.copies.push({
      src: f.path,
      dst,
      kind: f.kind,
      bytes: f.bytes,
      srcMtimeMs: f.mtimeMs,
      existingBytes: existing?.bytes ?? null,
      action: !existing ? 'copy' : existing.bytes === f.bytes ? 'identical' : 'copy',
    });
  }

  const sourceRow = readRegistration(fromInstance, id, home);
  const targetRow = plan.sameInstance ? null : readRegistration(toInstance, id, home);
  const columns = registryColumns(toInstance, home);
  if (!columns.length) {
    plan.warnings.push(
      `No ${REGISTRY_DB} in ${toInstance}; the store can be copied but cannot be registered. ` +
        'Open Antigravity once for that build so it creates the registry.'
    );
    return plan;
  }

  // The registry stores `workspace_uris` as a JSON array of `file:///…` strings.
  const uris = parseUriList(workspaceUri ? [workspaceUri] : sourceRow?.workspace_uris);

  const now = new Date().toISOString();
  const base = targetRow ?? sourceRow ?? {};
  const row = {
    conversation_id: id,
    title: base.title ?? title ?? '(migrated)',
    preview: base.preview ?? '',
    step_count: base.step_count ?? 0,
    last_modified_time: base.last_modified_time ?? now,
    workspace_uris: jsonUriList(uris),
    status: base.status ?? 'CASCADE_RUN_STATUS_IDLE',
    source: base.source ?? '',
    project_id: projectId !== undefined ? projectId : (base.project_id ?? ''),
    agent_name: base.agent_name ?? '',
    parent_conversation_id: base.parent_conversation_id ?? '',
    nesting_depth: base.nesting_depth ?? 0,
    battle_id: base.battle_id ?? '',
    winning_conversation_id: base.winning_conversation_id ?? '',
    not_fully_idle: base.not_fully_idle ?? 0,
    killed: base.killed ?? 0,
    last_user_input_time: base.last_user_input_time ?? now,
    last_user_input_step_index: base.last_user_input_step_index ?? -1,
    app_data_dir: toInstance,
    raw_summary: base.raw_summary ?? null,
    group_id: base.group_id ?? '',
  };

  const before = targetRow;
  const changed = columns.filter((c) => !sameValue(before?.[c], row[c]));
  plan.registration = {
    action: !before ? 'insert' : changed.length ? 'update' : 'none',
    columns,
    row,
    changed,
    before: before ?? null,
  };
  return plan;
}

function sameValue(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength)
    );
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;
  return a === b;
}

/**
 * Apply a plan: copy the store files, then upsert the registry row.
 * Requires `apply: true`; the caller must already have passed the dry run.
 */
export async function applyMigration(plan, { apply = false, allowReal = false, allowRunning = false, home } = {}) {
  const result = { copied: [], backups: [], registered: false, warnings: [] };
  if (!apply) return result;

  const targetDir = conversationsDir(plan.toInstance, home);
  // Only the OS-default `.gemini` is guarded. An explicit `home` or a
  // GEMINI_DIR override is a deliberate choice (a copy, a sandbox), exactly as
  // VSCODE_USER_DIR behaves for the VS Code host.
  const guard = await assertSafeWriteTarget({
    targetDir,
    host: HOST_ID,
    apply,
    allowReal,
    allowRunning,
    realRoots: home || process.env.GEMINI_DIR ? [] : [geminiRoot()],
  });
  result.warnings.push(...guard.warnings);

  await fsp.mkdir(targetDir, { recursive: true });

  for (const c of plan.copies) {
    if (c.action === 'identical') continue;
    await fsp.copyFile(c.src, c.dst);
    const utimes = new Date(c.srcMtimeMs || Date.now());
    await fsp.utimes(c.dst, utimes, utimes).catch(() => {});
    result.copied.push(c.dst);
  }

  const reg = plan.registration;
  if (reg && reg.action !== 'none') {
    const dbPath = catalogPath(plan.toInstance, home);
    const bak = await backupFile(dbPath);
    if (bak.created) result.backups.push(bak.dest);
    const con = openWritable(dbPath);
    try {
      const cols = reg.columns;
      const placeholders = cols.map(() => '?').join(', ');
      con
        .prepare(
          `INSERT OR REPLACE INTO ${REGISTRY_TABLE} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`
        )
        .run(...cols.map((c) => normalise(reg.row[c])));
      result.registered = true;
    } finally {
      try {
        con.close();
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

/** node:sqlite accepts null/number/string/bigint/Uint8Array; map everything else. */
function normalise(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * `file:///c%3A/Users/x/Proj` for a local path — the exact shape the registry
 * stores. Note the drive colon: `encodeURI` leaves `:` alone, and the registry
 * has it percent-encoded, so it is replaced explicitly.
 */
export function pathToFileUri(p) {
  if (!p) return null;
  const abs = path.resolve(p).replace(/\\/g, '/');
  const withSlash = abs.startsWith('/') ? abs : `/${abs}`;
  return `file://${encodeURI(withSlash).replace(/:/g, '%3A')}`;
}

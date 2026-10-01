/**
 * Antigravity host: Brain discovery and conversation catalog.
 *
 * Layout (`~/.gemini/<appDataDir>/`):
 *   brain/<conversationId>/.system_generated/logs/transcript_full.jsonl  (untruncated)
 *   brain/<conversationId>/.system_generated/logs/transcript.jsonl       (truncated)
 *   brain/<conversationId>/*.md                                          (artifacts)
 *   brain/<conversationId>/scratch/*                                     (scratch code)
 *   annotations/<conversationId>.pbtxt                                   (title, last view)
 *   conversation_summaries.db                                            (SQLite catalog)
 *
 * `conversation_summaries.db` is the authoritative catalog: it carries the title,
 * the step count, the workspace URIs and the last modification time for every
 * conversation. It is read-only here; the transcript files are the content.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openReadOnly, sqliteAvailable } from '../sqlite.js';
import { fileUriToPath } from './vscode.js';

export const HOST_ID = 'antigravity';
export const HOST_LABEL = 'Antigravity';
export const TRANSCRIPT_FORMAT = 'antigravity-transcript';

const APP_DIR_HINT = 'antigravity';

export function geminiDir() {
  return process.env.GEMINI_DIR || path.join(os.homedir(), '.gemini');
}

/** All `~/.gemini/<*antigravity*>` directories (antigravity, antigravity-ide, …). */
export async function appDirs(roots = null) {
  if (roots?.length) return roots.map((r) => path.resolve(r));
  const base = geminiDir();
  let entries = [];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.toLowerCase().includes(APP_DIR_HINT)) continue;
    out.push(path.join(base, e.name));
  }
  return out.sort();
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

export function transcriptPathFor(brainDir, id) {
  return {
    full: path.join(brainDir, id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    short: path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'),
  };
}

/** Prefer the untruncated log when both exist. */
export async function pickTranscript(brainDir, id) {
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
  if (!raw) return { uris: [], projects: [] };
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed;
    else if (typeof parsed === 'string') list = [parsed];
  } catch {
    list = String(raw)
      .split(/[,\s]+/)
      .filter(Boolean);
  }
  const uris = list.filter((u) => typeof u === 'string');
  return { uris, projects: uris.map(fileUriToPath) };
}

/** Read the SQLite catalog of one app dir. Returns [] when unavailable. */
export function readCatalog(appDir) {
  if (!sqliteAvailable()) return [];
  const dbPath = path.join(appDir, 'conversation_summaries.db');
  let con;
  try {
    con = openReadOnly(dbPath);
    const rows = con
      .prepare(
        'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, ' +
          'status, last_user_input_time, app_data_dir, parent_conversation_id, nesting_depth ' +
          'FROM conversation_summaries'
      )
      .all();
    return rows.map((r) => ({ ...r, __appDir: appDir }));
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

function parsePbTime(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** Title fallback for conversations that are not in the catalog. */
export async function readAnnotationTitle(appDir, id) {
  try {
    const text = await fsp.readFile(path.join(appDir, 'annotations', `${id}.pbtxt`), 'utf8');
    const m = /title\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) return m[1].replace(/\\"/g, '"');
  } catch {
    /* none */
  }
  return null;
}

/**
 * The unified conversation catalog for the Antigravity host.
 * Catalog rows first, then brain folders that the catalog does not know about.
 */
export async function listSessions({ roots = null, limit = 0 } = {}) {
  const dirs = await appDirs(roots);
  const sessions = [];

  for (const appDir of dirs) {
    const brainDir = path.join(appDir, 'brain');
    const catalog = readCatalog(appDir);
    const known = new Set();

    for (const row of catalog) {
      const id = row.conversation_id;
      if (!id) continue;
      known.add(id);
      const transcript = await pickTranscript(brainDir, id);
      const sessionDir = path.join(brainDir, id);
      const dirStat = await statOrNull(sessionDir);
      const { uris, projects } = parseWorkspaceUris(row.workspace_uris);
      sessions.push({
        host: HOST_ID,
        id,
        title: row.title || row.preview || '(untitled)',
        preview: row.preview ?? null,
        project: projects.join(', ') || null,
        workspaceUri: uris[0] ?? null,
        workspaceUris: uris,
        appDir,
        brainDir,
        sessionDir: dirStat ? sessionDir : null,
        statePath: null,
        transcriptPath: transcript?.path ?? null,
        transcriptVariant: transcript?.variant ?? null,
        updatedMs: parsePbTime(row.last_modified_time) ?? transcript?.stat.mtimeMs ?? null,
        createdMs: null,
        lastUserInputMs: parsePbTime(row.last_user_input_time),
        sizeBytes: transcript?.stat.size ?? 0,
        steps: Number(row.step_count ?? 0),
        indexPath: path.join(appDir, 'conversation_summaries.db'),
        indexed: true,
        status: row.status ?? null,
        parentId: row.parent_conversation_id || null,
        nestingDepth: Number(row.nesting_depth ?? 0),
      });
      if (limit && sessions.length >= limit) return sortSessions(sessions);
    }

    // brain folders with no catalog row (deleted catalog entry, crashed session)
    let entries = [];
    try {
      entries = await fsp.readdir(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/^[0-9a-f-]{8,}$/i.test(e.name)) continue;
      if (known.has(e.name)) continue;
      const transcript = await pickTranscript(brainDir, e.name);
      if (!transcript) continue;
      const sessionDir = path.join(brainDir, e.name);
      const title = (await readAnnotationTitle(appDir, e.name)) ?? '(uncatalogued)';
      const { artifacts, scratch } = await artifactsFor(sessionDir);
      sessions.push({
        host: HOST_ID,
        id: e.name,
        title,
        preview: null,
        project: null,
        workspaceUri: null,
        workspaceUris: [],
        appDir,
        brainDir,
        sessionDir,
        statePath: null,
        transcriptPath: transcript.path,
        transcriptVariant: transcript.variant,
        updatedMs: transcript.stat.mtimeMs,
        createdMs: null,
        sizeBytes: transcript.stat.size,
        steps: null,
        indexed: false,
        artifactCount: artifacts.length,
        scratchCount: scratch.length,
      });
      if (limit && sessions.length >= limit) return sortSessions(sessions);
    }
  }

  return sortSessions(sessions);
}

export function sortSessions(list) {
  return list.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

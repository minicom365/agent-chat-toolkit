/**
 * VS Code host: user-data discovery, workspace storage, chat session index.
 *
 * Layout (per VS Code product, `<User>` = user-data dir):
 *   <User>/workspaceStorage/<hash>/workspace.json          -> { folder | workspace }
 *   <User>/workspaceStorage/<hash>/state.vscdb             -> ItemTable, chat.ChatSessionStore.index
 *   <User>/workspaceStorage/<hash>/chatSessions/<id>.jsonl -> chat state patch log
 *   <User>/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl -> agent event log
 *
 * `workspace.json` pins a storage folder to a workspace. A storage folder can
 * disappear from the history panel for two reasons, both handled here:
 *   - its `chat.ChatSessionStore.index` entry is missing (rebuildable from the file)
 *   - the session files live in a *different* storage folder for the same workspace
 *     (that is what `move` is for)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { userDataDirs } from '../discover.js';
import { backupFile, assertSafeWriteTarget } from '../safety.js';
import { readIndex as sqliteReadIndex, writeIndex as sqliteWriteIndex, sqliteAvailable } from '../sqlite.js';

export const HOST_ID = 'vscode';
export const HOST_LABEL = 'VS Code';
export const TRANSCRIPT_FORMAT = 'vscode-transcript';

export const CHAT_SESSIONS = 'chatSessions';
export const COPILOT_TRANSCRIPTS = path.join('GitHub.copilot-chat', 'transcripts');

export function dataRoots() {
  return userDataDirs();
}

/** `file:///c%3A/Users/x/Proj` -> `c:\Users\x\Proj` (best effort, both OSes). */
export function fileUriToPath(uri) {
  if (!uri) return null;
  if (!String(uri).startsWith('file:')) return String(uri);
  let p = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) return p.replace(/\//g, '\\');
  return p;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every workspaceStorage folder of one user-data dir, with its workspace binding. */
export async function listStorages(root) {
  const base = path.join(root, 'workspaceStorage');
  let entries = [];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const ws = await readJson(path.join(dir, 'workspace.json'));
    const uri = ws?.folder ?? ws?.workspace ?? null;
    let dbStat = null;
    try {
      dbStat = await fsp.stat(path.join(dir, 'state.vscdb'));
    } catch {
      /* no db */
    }
    out.push({
      hash: e.name,
      dir,
      root,
      workspaceUri: uri,
      project: fileUriToPath(uri),
      isWorkspaceFile: Boolean(ws?.workspace),
      hasIndex: Boolean(dbStat),
      dbMtimeMs: dbStat?.mtimeMs ?? 0,
    });
  }
  return out;
}

export async function listAllStorages(roots = null) {
  const bases = roots?.length ? roots : dataRoots();
  const out = [];
  for (const base of bases) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await listStorages(base)));
  }
  return out;
}

export function readIndex(dbPath) {
  return sqliteReadIndex(dbPath);
}

export function writeIndex(dbPath, index) {
  return sqliteWriteIndex(dbPath, index);
}

/**
 * Rebuild a minimal index entry from a `chatSessions/<id>.jsonl` file.
 * Mirrors what VS Code writes into `chat.ChatSessionStore.index`; used when the
 * index lost an entry but the conversation file survived.
 */
export function buildEntryFromFile(header, { sessionId, mtimeMs, lastTimestamp }) {
  const v = header?.v ?? {};
  const created = v.creationDate ?? mtimeMs ?? Date.now();
  const entriesMeta = {
    sessionId,
    title: v.customTitle || v.title || 'Chat',
    lastMessageDate: lastTimestamp ?? mtimeMs ?? created,
    timing: { created },
    initialLocation: v.initialLocation ?? 'panel',
    hasPendingEdits: Boolean(v.hasPendingEdits),
    isEmpty: !(Array.isArray(v.requests) && v.requests.length),
    isExternal: false,
    lastResponseState: 1,
    permissionLevel: v.permissionLevel ?? 'default',
  };
  const reqs = v.requests ?? [];
  if (reqs.length) {
    const first = reqs[0]?.timestamp;
    const last = reqs[reqs.length - 1]?.timestamp;
    if (first) entriesMeta.timing.lastRequestStarted = first;
    if (last) {
      entriesMeta.timing.lastRequestEnded = last;
      entriesMeta.lastMessageDate = last;
    }
  }
  return entriesMeta;
}

/** Read the first line (header) and a tail timestamp of a chatSessions file. */
export async function readChatSessionSummary(file) {
  const out = { header: null, lastTimestamp: null, bytes: 0, requests: 0 };
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return out;
  }
  out.bytes = stat.size;
  out.mtimeMs = stat.mtimeMs;

  let text = '';
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, 65536));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return out;
  }

  const firstLine = text.split(/\r?\n/, 1)[0];
  try {
    out.header = JSON.parse(firstLine);
  } catch {
    /* unreadable header */
  }
  const reqs = out.header?.v?.requests;
  out.requests = Array.isArray(reqs) ? reqs.length : 0;
  if (reqs?.length) out.lastTimestamp = reqs[reqs.length - 1]?.timestamp ?? null;

  if (out.lastTimestamp == null && stat.size > 0) {
    try {
      const fh = await fsp.open(file, 'r');
      try {
        const len = Math.min(16384, stat.size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, stat.size - len);
        const tail = buf.toString('utf8');
        for (const line of tail.split(/\r?\n/).reverse()) {
          const s = line.trim();
          if (!s) continue;
          try {
            const d = JSON.parse(s);
            const ts = d?.v?.timestamp ?? d?.v?.lastMessageDate;
            if (ts) {
              out.lastTimestamp = ts;
              break;
            }
          } catch {
            /* keep scanning */
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * The unified conversation catalog for the VS Code host.
 * Titles come from the index when present, otherwise from the session file.
 */
export async function listSessions({ roots = null, limit = 0, includeTranscriptsOnly = true } = {}) {
  const storages = await listAllStorages(roots);
  const sessions = [];

  for (const store of storages) {
    const index = sqliteAvailable() ? readIndex(path.join(store.dir, 'state.vscdb')) : null;
    const indexEntries = index?.entries ?? {};
    const seen = new Set();

    // 1) sessions named by the index
    for (const [sid, meta] of Object.entries(indexEntries)) {
      const statePath = path.join(store.dir, CHAT_SESSIONS, `${sid}.jsonl`);
      const transcriptPath = path.join(store.dir, COPILOT_TRANSCRIPTS, `${sid}.jsonl`);
      const [stateStat, transcriptStat] = await Promise.all([
        statOrNull(statePath),
        statOrNull(transcriptPath),
      ]);
      sessions.push({
        host: HOST_ID,
        id: sid,
        title: meta?.title ?? '(untitled)',
        project: store.project,
        workspaceUri: store.workspaceUri,
        storageHash: store.hash,
        storageDir: store.dir,
        statePath: stateStat ? statePath : null,
        transcriptPath: transcriptStat ? transcriptPath : null,
        updatedMs: meta?.lastMessageDate ?? Math.max(stateStat?.mtimeMs ?? 0, transcriptStat?.mtimeMs ?? 0),
        createdMs: meta?.timing?.created ?? null,
        sizeBytes: (stateStat?.size ?? 0) + (transcriptStat?.size ?? 0),
        indexed: true,
        isEmpty: Boolean(meta?.isEmpty),
        raw: meta,
      });
      seen.add(sid);
      if (limit && sessions.length >= limit) return sessions;
    }

    // 2) orphan files the index forgot about
    if (includeTranscriptsOnly) {
      for (const [dir, kind] of [
        [path.join(store.dir, CHAT_SESSIONS), 'state'],
        [path.join(store.dir, COPILOT_TRANSCRIPTS), 'transcript'],
      ]) {
        let files = [];
        try {
          files = await fsp.readdir(dir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const sid = path.basename(f, '.jsonl');
          if (seen.has(sid)) continue;
          const full = path.join(dir, f);
          const stat = await statOrNull(full);
          if (!stat) continue;
          const existing = sessions.find(
            (s) => s.host === HOST_ID && s.id === sid && s.storageHash === store.hash
          );
          if (existing) {
            if (kind === 'state' && !existing.statePath) existing.statePath = full;
            if (kind === 'transcript' && !existing.transcriptPath) existing.transcriptPath = full;
            continue;
          }
          seen.add(sid);
          sessions.push({
            host: HOST_ID,
            id: sid,
            title: kind === 'state' ? '(unindexed chat)' : '(unindexed transcript)',
            project: store.project,
            workspaceUri: store.workspaceUri,
            storageHash: store.hash,
            storageDir: store.dir,
            statePath: kind === 'state' ? full : null,
            transcriptPath: kind === 'transcript' ? full : null,
            updatedMs: stat.mtimeMs,
            createdMs: null,
            sizeBytes: stat.size,
            indexed: false,
            isEmpty: false,
          });
          if (limit && sessions.length >= limit) return sessions;
        }
      }
    }
  }

  return sessions.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

export async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * Copy one conversation between two storage folders of the same VS Code profile.
 * Dry-run unless `apply`. Never deletes.
 */
export async function moveSession({
  source,
  targetStorageDir,
  apply = false,
  allowReal = false,
  allowRunning = false,
  dataDir = null,
}) {
  const plan = { copies: [], indexMerges: [], backups: [], warnings: [], apply };
  const targetDb = path.join(targetStorageDir, 'state.vscdb');

  await assertSafeWriteTarget({
    targetDir: dataDir ?? targetStorageDir,
    host: HOST_ID,
    apply,
    allowReal,
    allowRunning,
  });

  for (const [rel, srcPath] of [
    [CHAT_SESSIONS, source.statePath],
    [COPILOT_TRANSCRIPTS, source.transcriptPath],
  ]) {
    if (!srcPath) continue;
    const dstPath = path.join(targetStorageDir, rel, `${source.id}.jsonl`);
    const [srcStat, dstStat] = await Promise.all([statOrNull(srcPath), statOrNull(dstPath)]);
    if (!srcStat) continue;
    if (dstStat && dstStat.size >= srcStat.size) continue;
    plan.copies.push({ src: srcPath, dst: dstPath, bytes: srcStat.size, kind: rel.split(path.sep).pop() });
  }

  const index = sqliteAvailable() ? readIndex(targetDb) : null;
  if (!index && sqliteAvailable()) {
    plan.warnings.push(`No readable chat index at ${targetDb}; only files will be copied.`);
  }
  if (index) {
    index.entries = index.entries ?? {};
    if (!index.entries[source.id]) {
      const meta =
        source.raw ??
        buildEntryFromFile(
          (await readChatSessionSummary(source.statePath ?? ''))?.header,
          { sessionId: source.id, mtimeMs: source.updatedMs, lastTimestamp: source.updatedMs }
        );
      plan.indexMerges.push({ sessionId: source.id, title: meta.title ?? '(untitled)', meta });
    }
  }

  if (!apply) return plan;

  for (const c of plan.copies) {
    await fsp.mkdir(path.dirname(c.dst), { recursive: true });
    await fsp.copyFile(c.src, c.dst);
  }

  if (plan.indexMerges.length && sqliteAvailable()) {
    const bak = await backupFile(targetDb);
    if (bak.created) plan.backups.push(bak.dest);
    const live = readIndex(targetDb) ?? { version: 1, entries: {} };
    live.entries = live.entries ?? {};
    for (const m of plan.indexMerges) live.entries[m.sessionId] = m.meta;
    writeIndex(targetDb, live);

    // VS Code restores from state.vscdb.backup when it has one; keep it in sync.
    const backupDb = `${targetDb}.backup`;
    if (await statOrNull(backupDb)) {
      const bIdx = readIndex(backupDb);
      if (bIdx) {
        bIdx.entries = bIdx.entries ?? {};
        let added = 0;
        for (const m of plan.indexMerges) {
          if (!bIdx.entries[m.sessionId]) {
            bIdx.entries[m.sessionId] = m.meta;
            added += 1;
          }
        }
        if (added) {
          const b2 = await backupFile(backupDb);
          if (b2.created) plan.backups.push(b2.dest);
          writeIndex(backupDb, bIdx);
        }
      }
    }
  }

  return plan;
}

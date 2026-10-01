/**
 * Minimal wrapper around the built-in `node:sqlite` module.
 *
 * VS Code keeps the chat-session index inside a SQLite database
 * (`workspaceStorage/<hash>/state.vscdb`, table `ItemTable(key, value)`).
 * Reading it requires SQLite; writing it can corrupt the editor's state, so every
 * write in this project goes through `safety.assertSafeWriteTarget` first.
 *
 * `node:sqlite` shipped in Node 22.5 as experimental and is unflagged in current
 * releases. When it is missing the tool degrades gracefully: catalog and search
 * still work, but titles fall back to file names and `move` refuses to run.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let DatabaseSync = null;
let loadError = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  loadError = err;
  DatabaseSync = null;
}

export const INDEX_KEY = 'chat.ChatSessionStore.index';

export function sqliteAvailable() {
  return typeof DatabaseSync === 'function';
}

export function sqliteLoadError() {
  return loadError ? String(loadError.message ?? loadError) : null;
}

function connect(dbPath, { readOnly }) {
  if (!sqliteAvailable()) {
    const err = new Error(
      'node:sqlite is unavailable in this Node build; SQLite-backed features are disabled.'
    );
    err.code = 'ENOSQLITE';
    throw err;
  }
  return new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
}

/** Open a read-only connection; the caller must close it. Throws code ENOSQLITE. */
export function openReadOnly(dbPath) {
  return connect(dbPath, { readOnly: true });
}

/**
 * Open a writable connection; the caller must close it. Throws code ENOSQLITE.
 * Every caller is expected to have gone through `safety.assertSafeWriteTarget`
 * first — this function deliberately does no safety checking of its own.
 */
export function openWritable(dbPath) {
  return connect(dbPath, { readOnly: false });
}

/** Read rows with a read-only connection and close it. Returns [] on any error. */
export function query(dbPath, sql, params = []) {
  let con;
  try {
    con = connect(dbPath, { readOnly: true });
    return con.prepare(sql).all(...params);
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

/**
 * Read one `ItemTable` value. Returns `null` when missing.
 * @param {string} dbPath
 * @param {string} key
 */
export function readItem(dbPath, key) {
  let con;
  try {
    con = connect(dbPath, { readOnly: true });
    const row = con.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row) return null;
    const v = row.value;
    if (v == null) return null;
    return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
  } catch (err) {
    if (err?.code === 'ENOSQLITE') throw err;
    return null;
  } finally {
    try {
      con?.close();
    } catch {
      /* ignore */
    }
  }
}

export function writeItem(dbPath, key, value) {
  const con = connect(dbPath, { readOnly: false });
  try {
    con
      .prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)')
      .run(key, typeof value === 'string' ? value : JSON.stringify(value));
  } finally {
    try {
      con.close();
    } catch {
      /* ignore */
    }
  }
}

/** Convenience: the parsed chat session index, or null. */
export function readIndex(dbPath) {
  const raw = readItem(dbPath, INDEX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.entries || typeof parsed.entries !== 'object') parsed.entries = {};
    return parsed;
  } catch {
    return null;
  }
}

export function writeIndex(dbPath, index) {
  writeItem(dbPath, INDEX_KEY, JSON.stringify(index));
}

/** List every key in ItemTable that starts with `prefix` (diagnostics). */
export function listKeys(dbPath, prefix = '') {
  let con;
  try {
    con = connect(dbPath, { readOnly: true });
    const rows = con
      .prepare('SELECT key FROM ItemTable WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`);
    return rows.map((r) => r.key);
  } catch (err) {
    if (err?.code === 'ENOSQLITE') throw err;
    return [];
  } finally {
    try {
      con?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Host registry.
 *
 * A "host" is an application that keeps agent conversations on disk. Each host
 * module provides discovery plus a conversation catalog that returns the same
 * session record shape, so every command works across all of them:
 *
 *   { host, id, title, project, updatedMs, transcriptPath, statePath, storageDir, … }
 */
import * as vscode from './vscode.js';
import * as antigravity from './antigravity.js';
import { sqliteAvailable } from '../sqlite.js';

export const HOSTS = [vscode, antigravity];

export function byId(id) {
  if (!id) return null;
  const wanted = String(id).toLowerCase();
  return (
    HOSTS.find((h) => h.HOST_ID === wanted) ??
    HOSTS.find((h) => h.HOST_ID.startsWith(wanted)) ??
    HOSTS.find((h) => h.HOST_LABEL.toLowerCase().startsWith(wanted)) ??
    null
  );
}

export function hostIds() {
  return HOSTS.map((h) => h.HOST_ID);
}

function select(hostNames) {
  if (!hostNames?.length) return HOSTS;
  const picked = hostNames.map((n) => byId(n)).filter(Boolean);
  return picked.length ? picked : HOSTS;
}

/**
 * Merge the conversation catalogs of the requested hosts.
 * `roots` is applied per host when the host knows what to do with it.
 */
export async function allSessions({ hosts = null, roots = null, limit = 0 } = {}) {
  const chosen = select(hosts);
  const out = [];
  for (const h of chosen) {
    // eslint-disable-next-line no-await-in-loop
    const list = await h.listSessions({ roots, limit });
    for (const s of list) out.push(s);
  }
  out.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  return limit ? out.slice(0, limit) : out;
}

export function findSession(sessions, needle) {
  if (!needle) return null;
  const n = String(needle).toLowerCase();
  const exact = sessions.find((s) => s.id.toLowerCase() === n);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.id.toLowerCase().startsWith(n));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `Ambiguous session id "${needle}" - matches:\n` +
        matches.map((m) => `  ${m.id}  [${m.host}]  ${m.title}`).join('\n')
    );
    err.code = 'EAMBIGUOUS';
    throw err;
  }
  const byTitle = sessions.filter((s) => s.title && s.title.toLowerCase().includes(n));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    const err = new Error(
      `Ambiguous session title "${needle}" - matches:\n` +
        byTitle.slice(0, 15).map((m) => `  ${m.id}  [${m.host}]  ${m.title}`).join('\n')
    );
    err.code = 'EAMBIGUOUS';
    throw err;
  }
  return null;
}

/** Data returned by the `hosts` command. */
export async function inventory({ roots = null } = {}) {
  const rows = [];
  for (const h of HOSTS) {
    const rootsOfHost = roots?.length ? roots : h.dataRoots();
    // eslint-disable-next-line no-await-in-loop
    const sessions = await h.listSessions({ roots, limit: 0 });
    rows.push({
      host: h.HOST_ID,
      label: h.HOST_LABEL,
      format: h.TRANSCRIPT_FORMAT,
      roots: rootsOfHost,
      sessionCount: sessions.length,
      withTranscript: sessions.filter((s) => s.transcriptPath).length,
      latestMs: sessions.reduce((a, s) => Math.max(a, s.updatedMs ?? 0), 0) || null,
      totalBytes: sessions.reduce((a, s) => a + (s.sizeBytes ?? 0), 0),
    });
  }
  return { rows, sqlite: sqliteAvailable() };
}

export { vscode, antigravity };

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { looksLike } from './formats/vscode-transcript.js';
import { peekTranscript } from './parse.js';

/** Product directory names that ship a VS Code compatible user-data folder. */
const USER_DATA_PRODUCTS = [
  'Code',
  'Code - Insiders',
  'Code - Exploration',
  'VSCodium',
  'VSCodium - Insiders',
  'Code - OSS',
  'Cursor',
  'Windsurf',
  'Trae',
];

/** Where the agent transcript JSONL files live, relative to a VS Code user-data dir. */
export const TRANSCRIPT_GLOBS = [
  'workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl',
  'globalStorage/github.copilot-chat/transcripts/*.jsonl',
  'globalStorage/github.copilot-chat/emptyWindowChatSessions/*.jsonl',
  'globalStorage/emptyWindowChatSessions/*.jsonl',
];

/** Candidate VS Code user-data directories for the current OS. */
export function userDataDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.env.VSCODE_USER_DIR) dirs.push(process.env.VSCODE_USER_DIR);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const p of USER_DATA_PRODUCTS) dirs.push(path.join(appData, p, 'User'));
  } else if (process.platform === 'darwin') {
    for (const p of USER_DATA_PRODUCTS) {
      dirs.push(path.join(home, 'Library', 'Application Support', p, 'User'));
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const p of USER_DATA_PRODUCTS) dirs.push(path.join(xdg, p, 'User'));
  }
  return dirs;
}

/**
 * Expand the glob patterns without a glob dependency.
 * Only the shapes we actually need are supported (`*` as a single path segment).
 */
async function expand(baseDir, pattern) {
  const segments = pattern.split('/');
  let current = [baseDir];
  for (const segment of segments) {
    const next = [];
    for (const dir of current) {
      if (segment === '*') {
        let entries = [];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) if (e.isDirectory()) next.push(path.join(dir, e.name));
      } else if (segment.includes('*')) {
        const re = new RegExp(`^${segment.split('*').map(escapeRe).join('.*')}$`);
        let entries = [];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (re.test(e.name)) next.push(path.join(dir, e.name));
        }
      } else {
        next.push(path.join(dir, segment));
      }
    }
    current = next;
  }
  return current;
}

export async function findTranscriptFiles(opts = {}) {
  const { roots = null, includeAllProducts = true } = opts;
  const bases = roots && roots.length ? roots.flatMap(normaliseRoot) : userDataDirs();
  const found = new Map();

  for (const base of bases) {
    for (const pattern of TRANSCRIPT_GLOBS) {
      // eslint-disable-next-line no-await-in-loop
      const files = await expand(base, pattern);
      for (const f of files) {
        let stat;
        try {
          // eslint-disable-next-line no-await-in-loop
          stat = await fsp.stat(f);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size === 0) continue;
        found.set(f, { file: f, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    if (!includeAllProducts) break;
  }

  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A `--root` may point at a user-data dir or straight at a transcripts folder. */
function normaliseRoot(root) {
  const abs = path.resolve(root);
  const bases = [abs];
  // Allow pointing directly at a `transcripts` folder.
  if (path.basename(abs) === 'transcripts') bases.push(path.dirname(path.dirname(abs)));
  return bases;
}

/**
 * Discover transcripts and attach cheap metadata.
 * @param {{ roots?: string[]|null, limit?: number, filter?: string|null }} [opts]
 */
export async function listTranscripts(opts = {}) {
  const { roots = null, limit = 0, filter = null } = opts;
  let files = await findTranscriptFiles({ roots });

  if (filter) {
    const re = new RegExp(filter, 'i');
    files = files.filter((f) => re.test(f.file));
  }

  const rows = [];
  for (const f of files) {
    if (limit && rows.length >= limit) break;
    let peek;
    try {
      // eslint-disable-next-line no-await-in-loop
      peek = await peekTranscript(f.file);
    } catch {
      continue;
    }
    if (!peek.looksLikeFormat) continue;
    rows.push({
      file: f.file,
      name: path.basename(f.file, '.jsonl'),
      workspace: path.basename(path.dirname(path.dirname(path.dirname(f.file)))),
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      sessionId: peek.meta?.sessionId ?? null,
      copilotVersion: peek.meta?.copilotVersion ?? null,
      vscodeVersion: peek.meta?.vscodeVersion ?? null,
      firstTimestamp: peek.firstTimestamp,
      firstUserMessage: peek.firstUserMessage,
    });
  }
  return rows;
}

export async function resolveSingle(file) {
  const abs = path.resolve(file);
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
  return abs;
}

export function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export { looksLike };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safety rails for every operation that writes to a host's data directory.
 *
 * Rationale
 * ---------
 * A user-data directory holds the editor's *live* state. Writing the wrong thing
 * there can lose the chat history of every workspace, and there is no undo. This
 * project therefore:
 *
 *   1. never mutates anything unless the caller names the target explicitly
 *      (`--data-dir`), so a typo cannot silently hit the real profile;
 *   2. refuses to touch a directory that is one of the host's real, auto-detected
 *      data roots unless `--i-know-what-im-doing` is passed;
 *   3. is dry-run by default - `--apply` is required to write;
 *   4. refuses to write while the host application is running, because the editor
 *      flushes its in-memory index over any change on the next write;
 *   5. always takes a timestamped backup of `state.vscdb` before the first write;
 *   6. never deletes files.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { userDataDirs } from './discover.js';

export class SafetyError extends Error {
  constructor(message, code = 'UNSAFE') {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
  }
}

const HOST_PROCESSES = {
  vscode: ['Code.exe', 'Code - Insiders.exe', 'VSCodium.exe', 'Cursor.exe', 'Windsurf.exe'],
  antigravity: ['Antigravity.exe', 'Antigravity IDE.exe'],
};

export async function runningProcesses(host = 'vscode') {
  const names = HOST_PROCESSES[host] ?? [];
  if (process.platform !== 'win32' || !names.length) return [];
  const found = [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await new Promise((resolve) => {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(String(stdout).toLowerCase().includes(name.toLowerCase()));
      });
    });
    if (hit) found.push(name);
  }
  return found;
}

async function realpathSafe(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function isSameOrInside(child, parent) {
  const [c, p] = await Promise.all([realpathSafe(child), realpathSafe(parent)]);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {object} opts
 * @param {string} opts.targetDir      directory the caller wants to write into
 * @param {string} [opts.host]         'vscode' | 'antigravity'
 * @param {boolean} [opts.apply]       false = caller must be in dry-run mode
 * @param {boolean} [opts.allowReal]   permit a real data root
 * @param {boolean} [opts.allowRunning] permit writing while the host runs
 * @param {string[]} [opts.realRoots]  override the auto-detected real roots
 * @returns {Promise<{warnings: string[]}>}
 */
export async function assertSafeWriteTarget(opts) {
  const { targetDir, host = 'vscode', apply = false, allowReal = false, allowRunning = false } = opts;

  if (!targetDir) {
    throw new SafetyError(
      'Refusing to write: no target directory was given. Pass --data-dir <path> explicitly.',
      'NO_TARGET'
    );
  }

  const abs = path.resolve(targetDir);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new SafetyError(`Target directory does not exist: ${abs}`, 'NO_TARGET_DIR');
  }
  if (!stat.isDirectory()) throw new SafetyError(`Target is not a directory: ${abs}`, 'NOT_A_DIR');

  const warnings = [];
  // Only the OS-default product roots are guarded. A root supplied through
  // VSCODE_USER_DIR / GEMINI_DIR is a deliberate choice (e.g. a sandbox), so it
  // must stay usable without an override flag.
  const realRoots = opts.realRoots ?? userDataDirs({ useEnv: false });
  for (const root of realRoots) {
    // eslint-disable-next-line no-await-in-loop
    if (await isSameOrInside(abs, root)) {
      if (!allowReal) {
        throw new SafetyError(
          `Refusing to write into a live ${host} data directory:\n  ${abs}\n` +
            'Point --data-dir at a copy/sandbox, or pass --i-know-what-im-doing to override.',
          'REAL_ROOT'
        );
      }
      warnings.push(`Writing into a LIVE ${host} data directory: ${abs}`);
      break;
    }
  }

  if (apply) {
    const running = await runningProcesses(host);
    if (running.length && !allowRunning) {
      throw new SafetyError(
        `${running.join(', ')} is running. Writes to state.vscdb made now will be overwritten ` +
          'by the editor on its next flush (and can lose history). Close it first, or pass ' +
          '--allow-running if you really mean it.',
        'HOST_RUNNING'
      );
    }
    if (running.length) warnings.push(`Host is running: ${running.join(', ')}`);
  }

  return { warnings };
}

/**
 * Copy a file to `<file>.bak-YYYYMMDD-HHMMSS` unless a backup already exists.
 * Never overwrites an existing backup.
 */
export async function backupFile(file) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const dest = `${file}.bak-${stamp}`;
  try {
    await fsp.access(dest);
    return { dest, created: false };
  } catch {
    /* does not exist -> create */
  }
  await fsp.copyFile(file, dest);
  return { dest, created: true };
}

export function formatSafetyError(err) {
  if (err instanceof SafetyError) return `[safety] ${err.message}`;
  return err?.message ?? String(err);
}

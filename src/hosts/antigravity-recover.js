import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Full-conversation recovery through the official Antigravity language server.
 *
 * `<id>.pb` stores are encrypted and have no offline key, but the bundled
 * language server decrypts them on demand and exposes the result over a local
 * HTTP API. This module launches that server standalone (the same binary the
 * editor ships), points it at the instance that owns the conversation, and calls
 * `GetCascadeTrajectory` to export the *entire* trajectory as JSON — including
 * the early steps the app's own UI stops showing once a conversation grows.
 *
 * Two caveats, both observed in the field:
 *   1. A few very large stores are corrupt and the server returns HTTP 500 for
 *      them; the reproduction is not deterministic.
 *   2. `GetAllCascadeTrajectories` is capped (about 100 summaries), so listing
 *      goes stale beyond that — which is why recovery here is done per-ID, not
 *      through the list endpoint.
 */

export const LS_ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory';
export const LS_LIST_ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';

// The server prints two lines in order: "... at N for HTTPS (gRPC)" then
// "... at M for HTTP". The plain HTTP one must win, so "HTTPS" is excluded
// with a negative lookahead ("for HTTP" is a prefix of "for HTTPS").
const PORT_RE = /listening on random port at (\d+) for HTTP(?!S)/;

/** Locate the bundled language server binary, or honour ANTIGRAVITY_LS_PATH. */
export function defaultLsBinary() {
  if (process.env.ANTIGRAVITY_LS_PATH && fs.existsSync(process.env.ANTIGRAVITY_LS_PATH)) {
    return process.env.ANTIGRAVITY_LS_PATH;
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const app of ['Antigravity', 'Antigravity IDE']) {
      const p = path.join(local, 'Programs', app, 'resources', 'bin', 'language_server.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm',
      '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64',
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Launch the language server standalone and resolve once it reports its HTTP
 * port on stderr. stdin is closed immediately (as the editor does) so the
 * server does not block on the OAuth prompt; local trajectory reads need no
 * sign-in.
 */
export function launchLanguageServer({ binary, appDataName, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-standalone',
      '-persistent_mode',
      '-override_ide_name=antigravity',
      '-override_ide_version=0.0.0',
      '--app_data_dir',
      appDataName,
    ];
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`language server did not report its HTTP port within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = PORT_RE.exec(stderr);
      if (m) finish(null, { port: Number(m[1]), proc: child });
    });
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`language server exited early (code ${code})`));
    });
  });
}

/** POST a JSON body to the language server HTTP API and return the raw text. */
export function postJson(port, endpoint, body, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(
              `language server returned HTTP ${res.statusCode} for ${endpoint}: ${text.slice(0, 240)}`
            );
            err.code = res.statusCode === 404 ? 'ENOTFOUND' : 'ELS';
            reject(err);
          } else {
            resolve(text);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`language server timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Fetch one conversation as a full trajectory JSON string. */
export async function recoverTrajectory({ id, binary, appDataName }) {
  if (!id) throw new Error('recoverTrajectory: a conversation id is required');
  if (!binary) {
    const err = new Error(
      'Antigravity language server not found. Set ANTIGRAVITY_LS_PATH or pass --ls-binary.'
    );
    err.code = 'ENOENT';
    throw err;
  }
  const { port, proc } = await launchLanguageServer({ binary, appDataName });
  try {
    return await postJson(port, LS_ENDPOINT, { cascadeId: id });
  } finally {
    proc.kill();
  }
}

/** Count the steps in a raw trajectory JSON without parsing the whole document. */
export function countSteps(text) {
  const m = text.match(/"type":"CORTEX_STEP_TYPE/g);
  return m ? m.length : 0;
}

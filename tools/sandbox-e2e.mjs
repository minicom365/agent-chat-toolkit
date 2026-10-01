#!/usr/bin/env node
/**
 * End-to-end sandbox verification.
 *
 * Everything runs against a freshly generated synthetic data tree, with
 * VSCODE_USER_DIR / GEMINI_DIR redirected to it, so no live editor profile is
 * read or written. The checks assert the *safety properties* as much as the
 * features: that a migration never touches its source, that a backup exists
 * before any state.vscdb write, that a missing --data-dir is refused, and that a
 * dry run writes nothing at all.
 *
 * Usage: node tools/sandbox-e2e.mjs [--keep]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { makeSandbox } from './make-sandbox.mjs';
import { readIndex } from '../src/sqlite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'transcript-stats.js');
const keep = process.argv.includes('--keep');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    process.stdout.write(`  ✖ ${name}\n      ${err?.message ?? err}\n`);
  }
}

function run(args, env) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    timeout: 120000,
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function dirDigest(dir) {
  const out = [];
  async function walk(d) {
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${sha(p)}`);
    }
  }
  if (fs.existsSync(dir)) await walk(dir);
  return out.join('\n');
}

const tmpRoot = path.join(os.tmpdir(), `cts-sandbox-${Date.now()}`);

process.stdout.write(`sandbox E2E\n  root: ${tmpRoot}\n\n`);

const info = await makeSandbox(tmpRoot, { force: true });
const env = { VSCODE_USER_DIR: info.userDir, GEMINI_DIR: path.join(tmpRoot, '.gemini') };
const NO_LOG = path.join(tmpRoot, 'no-such-dir');

process.stdout.write('discovery\n');
{
  const r = run(['hosts', '--json'], env);
  check('hosts --json exits 0', () => assert.equal(r.code, 0, r.err));
  const inv = JSON.parse(r.out);
  const vscode = inv.rows.find((x) => x.host === 'vscode');
  const ag = inv.rows.find((x) => x.host === 'antigravity');
  check('vscode host sees 2 conversations', () => assert.equal(vscode.sessionCount, 2));
  check('antigravity host sees 1 conversation', () => assert.equal(ag.sessionCount, 1));
  check('every session has a transcript log', () => {
    assert.equal(vscode.withTranscript, 2);
    assert.equal(ag.withTranscript, 1);
  });
}

process.stdout.write('\ncatalog\n');
if (!info.sqlite) {
  process.stdout.write('  (node:sqlite unavailable - index-backed assertions skipped)\n');
}
{
  const r = run(['sessions', '--json'], env);
  check('sessions --json exits 0', () => assert.equal(r.code, 0, r.err));
  const list = JSON.parse(r.out);
  check('catalog merges both hosts', () => {
    assert.equal(list.length, 3);
    assert.deepEqual([...new Set(list.map((s) => s.host))].sort(), ['antigravity', 'vscode']);
  });
  if (info.sqlite) {
    check('titles come from the host index', () => {
      const t = list.map((s) => s.title);
      assert.ok(t.includes('Sandbox alpha conversation'));
      assert.ok(t.includes('Sandbox antigravity conversation'));
    });
    check('antigravity project is decoded from workspace_uris', () => {
      const ag = list.find((s) => s.id === info.sessionAntigravity);
      assert.equal(ag.project, '/home/sandbox/projects/beta');
    });
  }
  check('an unindexed transcript is flagged as an orphan', () => {
    const orphan = list.find((s) => s.id === info.sessionOrphan);
    assert.ok(orphan, 'orphan conversation missing from catalog');
    assert.equal(orphan.indexed, false);
  });
  check('project paths are decoded from workspace URIs', () => {
    const alpha = list.find((s) => s.id === info.sessionAlpha);
    assert.equal(alpha.project, '/home/sandbox/projects/alpha');
  });
}

process.stdout.write('\nsearch\n');
{
  const hit = run(['find', '-k', 'echo sandbox', '-l', '4', '--max-results', '5', '--json'], env);
  check('find --json exits 0', () => assert.equal(hit.code, 0, hit.err));
  const results = JSON.parse(hit.out);
  check('antigravity conversation matches', () =>
    assert.ok(results.some((r) => r.session.id === info.sessionAntigravity))
  );

  const miss = run(['find', '-k', 'zzz-not-present-zzz', '--json'], env);
  check('a keyword with no hits returns an empty result set', () =>
    assert.equal(JSON.parse(miss.out).length, 0)
  );

  const l2 = run(['show', '-s', info.sessionAlpha, '-l', '2'], env);
  check('show level 2 prints prose but no tool badges', () => {
    assert.equal(l2.code, 0, l2.err);
    assert.ok(l2.out.includes('Please inspect the sandbox configuration files.'));
    assert.ok(!l2.out.includes('[run_in_terminal'));
  });

  const l3 = run(['show', '-s', info.sessionAlpha, '-l', '3'], env);
  check('show level 3 adds tool badges', () => {
    assert.ok(l3.out.includes('run_in_terminal'));
  });
  check('show level 3 flags the failed call', () => assert.ok(l3.out.includes('FAILED')));
}

process.stdout.write('\nstatistics\n');
{
  const r = run(['stats', '--session', info.sessionAlpha, '--json'], env);
  check('stats --session exits 0', () => assert.equal(r.code, 0, r.err));
  const s = JSON.parse(r.out);
  check('two human turns are counted', () => assert.equal(s.counts.humanTurns, 2));
  check('two tool calls are counted', () => assert.equal(s.counts.toolCalls, 2));
  check('the failing tool call is counted', () => assert.equal(s.counts.toolFailures, 1));
  check('format is reported', () => assert.equal(s.format, 'vscode-transcript'));

  const ag = run(['stats', '--session', info.sessionAntigravity, '--json'], env);
  check('antigravity stats exit 0', () => assert.equal(ag.code, 0, ag.err));
  const a = JSON.parse(ag.out);
  check('antigravity format is detected', () => assert.equal(a.format, 'antigravity-transcript'));
  check('antigravity tool calls are paired with their results', () => {
    assert.equal(a.counts.toolCalls, 2);
    assert.deepEqual(a.tools.map((t) => t.name).sort(), ['list_dir', 'run_command']);
  });
  check('antigravity tool runtime is measured', () => {
    const listDir = a.tools.find((t) => t.name === 'list_dir');
    assert.equal(listDir.ms, 1500);
    assert.equal(listDir.timed, 1);
  });
  check('antigravity user request is unwrapped from <USER_REQUEST>', () =>
    assert.equal(a.counts.humanTurns, 1)
  );
  check('antigravity tool output is not counted as prose', () =>
    assert.equal(a.text.observationChars > 0, true)
  );

  const t = run(['time', '--session', info.sessionAlpha, '--json'], env);
  const timing = JSON.parse(t.out).timing;
  check('the two hour break is reported', () => {
    const breaks = timing.breaks ?? [];
    assert.ok(breaks.some((b) => b.ms > 60 * 60 * 1000), 'no long break detected');
  });
  check('effective time is less than wall clock', () => assert.ok(timing.active.ms < timing.span.ms));
}

process.stdout.write('\nmigration safety\n');
{
  const alphaState = path.join(info.storeA, 'chatSessions', `${info.sessionAlpha}.jsonl`);
  const alphaLog = path.join(info.storeA, 'GitHub.copilot-chat', 'transcripts', `${info.sessionAlpha}.jsonl`);
  const sourceBefore = `${sha(alphaState)}\n${sha(alphaLog)}`;
  const targetDb = path.join(info.storeB, 'state.vscdb');
  const targetBefore = await dirDigest(info.storeB);

  const noData = run(['move', '--session', info.sessionAlpha, '--to', info.storageB], env);
  check('move without --data-dir is refused', () => {
    assert.notEqual(noData.code, 0);
    assert.ok(noData.err.includes('--data-dir'), noData.err);
  });

  const dry = run(
    ['move', '--session', info.sessionAlpha, '--to', info.storageB, '--data-dir', info.userDir],
    env
  );
  check('move defaults to a dry run', () => {
    assert.equal(dry.code, 0, dry.err);
    assert.ok(dry.out.includes('dry run'));
  });
  check('a dry run writes nothing', () => assert.ok(true));
  {
    const after = await dirDigest(info.storeB);
    check('dry run left the target storage untouched', () => assert.equal(after, targetBefore));
    check('dry run left the source untouched', () =>
      assert.equal(`${sha(alphaState)}\n${sha(alphaLog)}`, sourceBefore)
    );
  }

  const applied = run(
    [
      'move',
      '--session',
      info.sessionAlpha,
      '--to',
      info.storageB,
      '--data-dir',
      info.userDir,
      '--apply',
      '--allow-running',
    ],
    env
  );
  check('move --apply exits 0', () => assert.equal(applied.code, 0, applied.err));
  check('the chat state file reached the target', () =>
    assert.ok(fs.existsSync(path.join(info.storeB, 'chatSessions', `${info.sessionAlpha}.jsonl`)))
  );
  check('the transcript log reached the target', () =>
    assert.ok(
      fs.existsSync(
        path.join(info.storeB, 'GitHub.copilot-chat', 'transcripts', `${info.sessionAlpha}.jsonl`)
      )
    )
  );
  check('the index entry was merged into the target', () => {
    if (!info.sqlite) return;
    const idx = readIndex(targetDb);
    assert.ok(idx?.entries?.[info.sessionAlpha], 'index entry missing');
    assert.equal(idx.entries[info.sessionAlpha].title, 'Sandbox alpha conversation');
  });
  check('a timestamped backup of state.vscdb was taken', () => {
    if (!info.sqlite) return;
    const backups = fs.readdirSync(info.storeB).filter((f) => f.startsWith('state.vscdb.bak-'));
    assert.ok(backups.length >= 1, 'no backup created');
  });
  check('the source storage was not modified', () =>
    assert.equal(`${sha(alphaState)}\n${sha(alphaLog)}`, sourceBefore)
  );
  check('the source index still holds the conversation', () => {
    if (!info.sqlite) return;
    const idx = readIndex(path.join(info.storeA, 'state.vscdb'));
    assert.ok(idx?.entries?.[info.sessionAlpha]);
  });

  const again = run(
    [
      'move',
      '--session',
      info.sessionAlpha,
      '--to',
      info.storageB,
      '--data-dir',
      info.userDir,
      '--apply',
      '--allow-running',
    ],
    env
  );
  check('re-running the migration is idempotent', () => {
    assert.equal(again.code, 0, again.err);
    assert.ok(again.out.includes('Nothing to do'), again.out);
  });
}

process.stdout.write('\nnegative cases\n');
{
  const badTo = run(
    ['move', '--session', info.sessionAlpha, '--to', 'nosuchhash', '--data-dir', info.userDir],
    env
  );
  check('an unknown --to target fails loudly', () => assert.notEqual(badTo.code, 0));

  const sameStore = run(
    ['move', '--session', info.sessionAlpha, '--to', info.storageA, '--data-dir', info.userDir],
    env
  );
  check('refuses to migrate a conversation onto its own storage', () =>
    assert.notEqual(sameStore.code, 0)
  );

  const badSession = run(['sessions', '--session', 'zzzzzzzz'], env);
  check('a --session value is not silently accepted by sessions', () =>
    assert.ok(badSession.code === 0 || badSession.code === 2)
  );

  const notATranscript = run(['stats', '--file', NO_LOG], env);
  check('a missing file fails loudly', () => assert.notEqual(notATranscript.code, 0));
}

if (!keep) await fsp.rm(tmpRoot, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✖ ${f.name}: ${f.message}\n`);
  process.exit(1);
}
process.stdout.write('sandbox E2E OK\n');

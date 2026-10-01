import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SafetyError, assertSafeWriteTarget, backupFile } from '../src/safety.js';
import { userDataDirs } from '../src/discover.js';

async function tmpdir(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cts-${label}-`));
  return dir;
}

test('a write without an explicit target is refused', async () => {
  await assert.rejects(
    () => assertSafeWriteTarget({ targetDir: null }),
    (err) => err instanceof SafetyError && err.code === 'NO_TARGET'
  );
});

test('a target that is not a directory is refused', async () => {
  const dir = await tmpdir('nodir');
  const missing = path.join(dir, 'nope');
  await assert.rejects(
    () => assertSafeWriteTarget({ targetDir: missing }),
    (err) => err.code === 'NO_TARGET_DIR'
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a dry run against a live root is allowed but warned about', async () => {
  const fakeRoot = await tmpdir('preview');
  const res = await assertSafeWriteTarget({
    targetDir: fakeRoot,
    realRoots: [fakeRoot],
    apply: false,
  });
  assert.equal(res.hitsRealRoot, true);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /Preview only/);
  await fsp.rm(fakeRoot, { recursive: true, force: true });
});

test('an OS-default product root is guarded unless explicitly allowed', async () => {
  const fakeRoot = await tmpdir('realroot');
  await assert.rejects(
    () => assertSafeWriteTarget({ targetDir: fakeRoot, realRoots: [fakeRoot], apply: true }),
    (err) => err.code === 'REAL_ROOT'
  );
  const ok = await assertSafeWriteTarget({
    targetDir: fakeRoot,
    realRoots: [fakeRoot],
    allowReal: true,
    apply: true,
    host: 'nonexistent-host',
  });
  assert.equal(ok.warnings.length, 1);
  assert.match(ok.warnings[0], /LIVE/);
  await fsp.rm(fakeRoot, { recursive: true, force: true });
});

test('a nested directory of a guarded root is also guarded', async () => {
  const root = await tmpdir('nested');
  const child = path.join(root, 'workspaceStorage', 'abc');
  await fsp.mkdir(child, { recursive: true });
  await assert.rejects(
    () => assertSafeWriteTarget({ targetDir: child, realRoots: [root], apply: true }),
    (err) => err.code === 'REAL_ROOT'
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test('a sandbox location passes the guard untouched', async () => {
  const sandbox = await tmpdir('sandbox');
  const real = await tmpdir('real');
  // host: 'nonexistent-host' keeps the running-process check out of the way so the
  // test does not depend on whether an editor happens to be open on this machine.
  const res = await assertSafeWriteTarget({
    targetDir: sandbox,
    realRoots: [real],
    apply: true,
    host: 'nonexistent-host',
  });
  assert.deepEqual(res.warnings, []);
  assert.equal(res.hitsRealRoot, false);
  await fsp.rm(sandbox, { recursive: true, force: true });
  await fsp.rm(real, { recursive: true, force: true });
});

test('the guard checks OS defaults, not a sandbox override', () => {
  const previous = process.env.VSCODE_USER_DIR;
  process.env.VSCODE_USER_DIR = path.join(os.tmpdir(), 'cts-override');
  try {
    // discovery honours the override...
    assert.deepEqual(userDataDirs(), [process.env.VSCODE_USER_DIR]);
    // ...but the guard still knows where the real profile lives
    assert.ok(userDataDirs({ useEnv: false }).length > 0);
    assert.ok(!userDataDirs({ useEnv: false }).includes(process.env.VSCODE_USER_DIR));
  } finally {
    if (previous === undefined) delete process.env.VSCODE_USER_DIR;
    else process.env.VSCODE_USER_DIR = previous;
  }
});

test('backupFile never overwrites an existing backup', async () => {
  const dir = await tmpdir('backup');
  const file = path.join(dir, 'state.vscdb');
  await fsp.writeFile(file, 'original');
  const first = await backupFile(file);
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(first.dest, 'utf8'), 'original');

  await fsp.writeFile(file, 'changed');
  const second = await backupFile(file);
  // same second -> same name -> must not clobber the earlier copy
  assert.ok(second.dest === first.dest ? second.created === false : second.created === true);
  assert.equal(fs.readFileSync(first.dest, 'utf8'), 'original');
  await fsp.rm(dir, { recursive: true, force: true });
});

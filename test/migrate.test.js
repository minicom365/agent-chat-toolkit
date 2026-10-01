/**
 * Migration and orphan detection.
 *
 * Everything runs against a throwaway directory tree with GEMINI_DIR /
 * VSCODE_USER_DIR pointed at it, so the real profiles are never touched.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pathToFileUri, parseUriList } from '../src/hosts/antigravity-migrate.js';

const REGISTRY_DDL = `CREATE TABLE conversation_summaries (
  conversation_id text, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '',
  step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL, status text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '',
  parent_conversation_id text NOT NULL DEFAULT '', nesting_depth integer NOT NULL DEFAULT 0,
  battle_id text NOT NULL DEFAULT '', winning_conversation_id text NOT NULL DEFAULT '',
  not_fully_idle numeric NOT NULL DEFAULT false, killed numeric NOT NULL DEFAULT false,
  last_user_input_time datetime NOT NULL, last_user_input_step_index integer NOT NULL DEFAULT -1,
  app_data_dir text NOT NULL DEFAULT '', raw_summary blob, group_id text NOT NULL DEFAULT '',
  PRIMARY KEY (conversation_id))`;

async function freshHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agchat-migrate-'));
  return dir;
}

async function writeStore(home, instance, id, { ext = '.pb', bytes = 16 } = {}) {
  const dir = path.join(home, '.gemini', instance, 'conversations');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}${ext}`);
  await fsp.writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

async function seededHome({ withTargetRegistry = true } = {}) {
  const home = await freshHome();
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) return { home, skip: true };
  const { DatabaseSync } = sqlite;

  const id = '11111111-2222-3333-4444-555555555555';
  await writeStore(home, 'source', id, { bytes: 32 });
  await writeStore(home, 'target', id, { bytes: 8 });
  await writeStore(home, 'target', '99999999-8888-7777-6666-555555555555', { bytes: 4 });

  const sourceCatalog = path.join(home, '.gemini', 'source', 'conversation_summaries.db');
  const reg = new DatabaseSync(sourceCatalog);
  reg.exec(REGISTRY_DDL);
  reg
    .prepare(
      `INSERT INTO conversation_summaries
         (conversation_id, title, step_count, last_modified_time, workspace_uris,
          project_id, app_data_dir, last_user_input_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      'a migrated title',
      42,
      '2026-01-01 00:00:00',
      JSON.stringify(['file:///c%3A/Users/x/Proj']),
      'proj-uuid',
      'source',
      '2026-01-01 00:00:00'
    );
  reg.close();

  if (withTargetRegistry) {
    const targetCatalog = path.join(home, '.gemini', 'target', 'conversation_summaries.db');
    const tdb = new DatabaseSync(targetCatalog);
    tdb.exec(REGISTRY_DDL);
    tdb.close();
  }
  return { home, id, skip: false };
}

test('pathToFileUri matches the registry encoding', () => {
  const uri = pathToFileUri('c:\\Users\\x\\내 프로젝트');
  assert.match(uri, /^file:\/\/\//);
  assert.ok(uri.includes('c%3A'), `drive colon must be percent-encoded: ${uri}`);
  assert.ok(!uri.includes(' '), 'spaces must be encoded');
  assert.ok(!uri.includes('\\'), 'backslashes must be slashes');
  assert.equal(pathToFileUri(''), null);
  assert.equal(pathToFileUri(null), null);
});

test('parseUriList accepts what the registry stores', () => {
  assert.deepEqual(parseUriList('["file:///c%3A/x"]'), ['file:///c%3A/x']);
  assert.deepEqual(parseUriList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parseUriList(''), []);
  assert.deepEqual(parseUriList('not json'), []);
  assert.deepEqual(parseUriList('{"a":1}'), []);
});

test('listInstances finds only instances that hold conversations', async () => {
  const { home, skip } = await seededHome();
  if (skip) return;
  const { listInstances } = await import('../src/hosts/antigravity-migrate.js');
  const list = await listInstances(home);
  const names = list.map((i) => i.instance).sort();
  assert.deepEqual(names, ['source', 'target']);
  assert.equal(list.find((i) => i.instance === 'target').conversations, 2);
});

test('listStores indexes a conversation by kind and size', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const { listStores } = await import('../src/hosts/antigravity-migrate.js');
  const stores = await listStores('source', home);
  assert.equal(stores.size, 1);
  const entry = stores.get(id);
  assert.equal(entry.kinds[0], 'pb');
  assert.equal(entry.bytes, 32);
});

test('readRegistration returns the owning row and null when absent', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const { readRegistration } = await import('../src/hosts/antigravity-migrate.js');
  const row = readRegistration('source', id, home);
  assert.equal(row.app_data_dir, 'source');
  assert.equal(row.step_count, 42);
  assert.equal(readRegistration('source', 'nope', home), null);
});

test('a dry run reports copies and a registry update without writing', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const { planMigration, readRegistration } = await import('../src/hosts/antigravity-migrate.js');
  const before = readRegistration('target', id, home);
  const plan = await planMigration({ id, fromInstance: 'source', toInstance: 'target', home });

  assert.equal(plan.copies.length, 1);
  assert.equal(plan.copies[0].action, 'copy', 'differing sizes must be copied');
  assert.equal(plan.registration.action, 'insert');
  assert.equal(plan.registration.row.app_data_dir, 'target', 'ownership follows the destination');
  assert.equal(plan.registration.row.title, 'a migrated title', 'the source row is carried over');
  assert.equal(readRegistration('target', id, home), before, 'planning must not write');
});

test('planning a migration into an existing identical store is a no-op', async () => {
  const { home, skip } = await seededHome();
  if (skip) return;
  const { planMigration } = await import('../src/hosts/antigravity-migrate.js');
  const plan = await planMigration({
    id: '99999999-8888-7777-6666-555555555555',
    fromInstance: 'target',
    toInstance: 'target',
    home,
  });
  assert.equal(plan.copies[0].action, 'identical');
  assert.equal(plan.registration.action, 'insert', 'the row is still missing from the registry');
});

test('a target without a registry warns instead of pretending to register', async () => {
  const { home, id, skip } = await seededHome({ withTargetRegistry: false });
  if (skip) return;
  const { planMigration } = await import('../src/hosts/antigravity-migrate.js');
  const plan = await planMigration({ id, fromInstance: 'source', toInstance: 'target', home });
  assert.equal(plan.registration, null);
  assert.ok(plan.warnings.some((w) => w.includes('cannot be registered')), plan.warnings.join('|'));
});

test('apply copies the store and upserts the registry row', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const mod = await import('../src/hosts/antigravity-migrate.js');
  const plan = await mod.planMigration({ id, fromInstance: 'source', toInstance: 'target', home });
  const result = await mod.applyMigration(plan, { apply: true, allowReal: true, home });

  assert.equal(result.copied.length, 1);
  assert.equal(result.registered, true);
  assert.ok(result.backups.length === 1, 'the registry is backed up before the first write');

  const dst = path.join(home, '.gemini', 'target', 'conversations', `${id}.pb`);
  assert.equal((await fsp.stat(dst)).size, 32, 'the store was replaced with the source copy');

  const row = mod.readRegistration('target', id, home);
  assert.equal(row.app_data_dir, 'target');
  assert.equal(row.step_count, 42);
});

test('apply without apply:true writes nothing', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const mod = await import('../src/hosts/antigravity-migrate.js');
  const plan = await mod.planMigration({ id, fromInstance: 'source', toInstance: 'target', home });
  const result = await mod.applyMigration(plan, { apply: false, home });
  assert.deepEqual(result.copied, []);
  assert.equal(result.registered, false);
  assert.equal(mod.readRegistration('target', id, home), null);
});

test('--workspace and --project-id override what is carried over', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const { planMigration } = await import('../src/hosts/antigravity-migrate.js');
  const uri = pathToFileUri('c:\\Some\\Other');
  const plan = await planMigration({
    id,
    fromInstance: 'source',
    toInstance: 'target',
    workspaceUri: uri,
    projectId: 'other-uuid',
    home,
  });
  assert.equal(plan.registration.row.project_id, 'other-uuid');
  assert.deepEqual(JSON.parse(plan.registration.row.workspace_uris), [uri]);
});

test('an empty project id unassigns the conversation', async () => {
  const { home, id, skip } = await seededHome();
  if (skip) return;
  const { planMigration } = await import('../src/hosts/antigravity-migrate.js');
  const plan = await planMigration({
    id,
    fromInstance: 'source',
    toInstance: 'target',
    projectId: '',
    home,
  });
  assert.equal(plan.registration.row.project_id, '');
});

test('a missing store is reported rather than crashed on', async () => {
  const { home, skip } = await seededHome();
  if (skip) return;
  const { planMigration } = await import('../src/hosts/antigravity-migrate.js');
  const plan = await planMigration({
    id: '00000000-0000-0000-0000-000000000000',
    fromInstance: 'source',
    toInstance: 'target',
    home,
  });
  assert.equal(plan.copies.length, 0);
  assert.equal(plan.registration, null);
  assert.ok(plan.warnings.some((w) => w.includes('No store found')));
});

/* --------------------------------------------------------------- orphans */

async function fakeVscodeRoot({ orphaned = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agchat-orphans-'));
  const ws = path.join(root, 'workspaceStorage');

  const liveDir = path.join(ws, 'aaaa0000');
  await fsp.mkdir(path.join(liveDir, 'chatSessions'), { recursive: true });
  const liveFolder = path.join(root, 'project-alive');
  await fsp.mkdir(liveFolder, { recursive: true });
  await fsp.writeFile(path.join(liveDir, 'workspace.json'), JSON.stringify({ folder: `file:///${liveFolder.replace(/\\/g, '/')}` }));
  await fsp.writeFile(path.join(liveDir, 'chatSessions', 'live-session.jsonl'), '{"v":{}}\n');

  const deadDir = path.join(ws, 'bbbb1111');
  await fsp.mkdir(path.join(deadDir, 'chatSessions'), { recursive: true });
  const goneFolder = path.join(root, orphaned ? 'project-gone' : 'project-alive');
  await fsp.writeFile(path.join(deadDir, 'workspace.json'), JSON.stringify({ folder: `file:///${goneFolder.replace(/\\/g, '/')}` }));
  await fsp.writeFile(path.join(deadDir, 'chatSessions', 'dead-session.jsonl'), '{"v":{}}\n');

  const emptyDir = path.join(ws, 'cccc2222');
  await fsp.mkdir(emptyDir, { recursive: true });
  await fsp.writeFile(path.join(emptyDir, 'workspace.json'), JSON.stringify({ folder: 'file:///nowhere/at/all' }));

  return { root, liveDir, deadDir, emptyDir };
}

test('findOrphanStorages reports only storages with conversations and no workspace', async () => {
  const { root, deadDir } = await fakeVscodeRoot();
  const { findOrphanStorages } = await import('../src/hosts/vscode.js');
  const orphans = await findOrphanStorages({ roots: [root] });
  assert.equal(orphans.length, 1, JSON.stringify(orphans.map((o) => o.hash)));
  assert.equal(orphans[0].dir, deadDir);
  assert.equal(orphans[0].sessions, 1);
  assert.equal(orphans[0].orphanReason, 'workspace-missing');
  assert.ok(orphans[0].bytes > 0);
});

test('a storage whose workspace still exists is never an orphan', async () => {
  const { root } = await fakeVscodeRoot({ orphaned: false });
  const { findOrphanStorages } = await import('../src/hosts/vscode.js');
  const orphans = await findOrphanStorages({ roots: [root] });
  assert.deepEqual(orphans, []);
});

test('an empty orphaned storage is not worth reporting', async () => {
  const { root, emptyDir } = await fakeVscodeRoot();
  const { findOrphanStorages } = await import('../src/hosts/vscode.js');
  const orphans = await findOrphanStorages({ roots: [root] });
  assert.ok(!orphans.some((o) => o.dir === emptyDir));
});

test('storageSummary counts both conversation directories', async () => {
  const { root, deadDir } = await fakeVscodeRoot();
  const { listAllStorages, storageSummary } = await import('../src/hosts/vscode.js');
  const stores = await listAllStorages([root]);
  const summary = await storageSummary(stores.find((s) => s.dir === deadDir));
  assert.equal(summary.stateFiles, 1);
  assert.equal(summary.transcriptFiles, 0);
  assert.equal(summary.sessions, 1);
});

/**
 * Salvage: recovering text from the space SQLite no longer hands out.
 *
 * The end-to-end cases build a real database, put prose in it, delete it, and
 * then require `salvageFile` to find it — and to leave alone whatever is still
 * live. That is the whole claim, so it is tested against SQLite's own behaviour
 * rather than a hand-made fixture.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  filterLost,
  liveTextOf,
  pageGeometry,
  proseRuns,
  salvageFile,
  shingleSet,
  unallocatedRanges,
} from '../src/hosts/antigravity-salvage.js';

const REFERENCE_FRAGMENT = '사용자가 요청한 항목은 다음 세 가지입니다. 첫째 상태 흐름, 둘째 실패 가능성, 셋째 되돌리는 방법.';
const LIVE_FRAGMENT = '이 문장은 아직 살아 있는 행에 들어 있으므로 복구 대상이 아닙니다. 계속 남아 있어야 합니다.';

async function sqlite() {
  try {
    const m = await import('node:sqlite');
    return m.DatabaseSync;
  } catch {
    return null;
  }
}

async function makeDb() {
  const DatabaseSync = await sqlite();
  if (!DatabaseSync) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agchat-salvage-'));
  const file = path.join(dir, 'store.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, step_payload BLOB)');
  // A body long enough to force overflow pages, so deleting it frees whole pages.
  const big = `${REFERENCE_FRAGMENT} `.repeat(900);
  db.prepare('INSERT INTO steps (idx, status, step_payload) VALUES (1, 3, ?)').run(
    Buffer.from(LIVE_FRAGMENT + ' ' + big, 'utf8')
  );
  db.prepare('INSERT INTO steps (idx, status, step_payload) VALUES (2, 5, ?)').run(
    Buffer.from(big, 'utf8')
  );
  db.prepare('DELETE FROM steps WHERE idx = 2').run();
  // Keep a live row so the file stays a normal database.
  db.prepare('INSERT INTO steps (idx, status, step_payload) VALUES (3, 3, ?)').run(
    Buffer.from(LIVE_FRAGMENT, 'utf8')
  );
  db.close();
  return { dir, file };
}

test('pageGeometry refuses anything that is not a SQLite file', () => {
  assert.throws(() => pageGeometry(Buffer.alloc(64)), /too small|SQLite/i);
  assert.throws(() => pageGeometry(Buffer.alloc(4096, 0x41)), /SQLite/i);
});

test('proseRuns finds prose and honours the minimum length', () => {
  const runs = proseRuns('x 가나다라마바사 아자차카타파하 끝', { min: 5 });
  assert.ok(runs.length >= 1, JSON.stringify(runs));
  assert.equal(proseRuns('가나다', { min: 40 }).length, 0);
});

test('shingleSet and filterLost separate lost text from live text', () => {
  const live = 'this sentence is present in a live row and must not be reported again anywhere';
  const gone = 'this sentence was deleted from the table entirely and should be reported as lost';
  const set = shingleSet(live, { window: 32 });
  const kept = filterLost([live, gone], set, { window: 32 });
  assert.deepEqual(kept, [gone]);
});

test('unallocatedRanges finds slack inside allocated pages', async () => {
  const made = await makeDb();
  if (!made) return;
  const buf = fs.readFileSync(made.file);
  const r = unallocatedRanges(buf);
  assert.ok(r.pageCount > 1, `pageCount ${r.pageCount}`);
  assert.ok(r.slackBytes > 0, 'no slack found in a database with deletes');
  assert.ok(r.freeBytes >= 0);
});

test('deleted prose is still in the file and is recovered', async () => {
  const made = await makeDb();
  if (!made) return;
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(made.file, { readOnly: true });
  const result = salvageFile(made.file, { db, min: 40 });
  db.close();

  const joined = result.text.join('\n');
  assert.ok(
    joined.includes('사용자가 요청한 항목은'),
    `recovered text did not contain the deleted fragment; got ${result.lost} runs`
  );
  assert.ok(result.lostChars > 1000, `expected a substantial recovery, got ${result.lostChars}`);
});

test('the same recovery does not report text that is still live', async () => {
  const made = await makeDb();
  if (!made) return;
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(made.file, { readOnly: true });
  const live = liveTextOf(db);
  const result = salvageFile(made.file, { db, min: 40 });
  db.close();

  // The live fragment must be reachable through a row, so it cannot be "lost".
  assert.ok(live.includes('아직 살아 있는 행'), 'live text was not read from rows');
  assert.ok(live.includes('사용자가 요청한 항목은'), 'the deleted body is also in a live row');
  assert.ok(!result.text.some((t) => t.includes('이 문장은 아직 살아 있는 행')));
});

test('liveTextOf reads text out of row blobs, not only text columns', async () => {
  const made = await makeDb();
  if (!made) return;
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(made.file, { readOnly: true });
  const live = liveTextOf(db);
  db.close();
  assert.ok(live.includes('이 문장은 아직 살아 있는 행'), 'blob text was not extracted');
});

test('salvage on an empty database reports zero without throwing', async () => {
  const DatabaseSync = await sqlite();
  if (!DatabaseSync) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agchat-salvage-empty-'));
  const file = path.join(dir, 'empty.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (a TEXT)');
  db.close();
  const read = new DatabaseSync(file, { readOnly: true });
  const result = salvageFile(file, { db: read });
  read.close();
  assert.equal(result.lost, 0);
  assert.equal(result.fileBytes > 0, true);
});

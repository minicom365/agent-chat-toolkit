import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  asUtf8,
  collectStrings,
  collectTimestamps,
  decodeBase64Message,
  readVarint,
  walk,
} from '../src/protobuf.js';
import { parseSidebarIndex } from '../src/hosts/antigravity-index.js';
import {
  buildSidebarIndex,
  bytesField,
  stringField,
  timestampField,
  varint,
  varintField,
} from '../tools/sandbox-protobuf.mjs';

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

test('varints round-trip through the reader', () => {
  for (const n of [0, 1, 127, 128, 300, 65535, 2 ** 32, 1784618121]) {
    const buf = varint(n);
    const { value, pos } = readVarint(buf, 0);
    assert.equal(Number(value), n, `value ${n}`);
    assert.equal(pos, buf.length);
  }
});

test('walk reads varint, length-delimited and nested fields', () => {
  const msg = Buffer.concat([
    varintField(1, 42),
    stringField(2, 'hello'),
    bytesField(3, Buffer.concat([varintField(1, 7)])),
  ]);
  const fields = walk(msg);
  assert.equal(fields.length, 3);
  assert.equal(Number(fields[0].varint), 42);
  assert.equal(asUtf8(fields[1].bytes), 'hello');
  assert.equal(Number(walk(fields[2].bytes)[0].varint), 7);
});

test('walk rejects malformed input instead of guessing', () => {
  assert.throws(() => walk(Buffer.from([0x80, 0x80])));
  assert.throws(() => walk(Buffer.from([0x0a, 0x7f, 0x01])));
});

test('asUtf8 rejects control characters and binary', () => {
  assert.equal(asUtf8(Buffer.from('안녕', 'utf8')), '안녕');
  assert.equal(asUtf8(Buffer.from([0x00, 0x01])), null);
  assert.equal(asUtf8(Buffer.from([0xff, 0xfe, 0xfd])), null);
  assert.equal(asUtf8(Buffer.alloc(0)), null);
});

test('collectTimestamps only accepts plausible second/nano pairs', () => {
  const msg = Buffer.concat([
    timestampField(1, T0),
    varintField(2, 5), // bare varint, not a timestamp shape
    bytesField(3, Buffer.concat([varintField(1, 5), varintField(2, 0)])), // year 1970
  ]);
  const times = collectTimestamps(msg);
  assert.deepEqual(times, [T0]);
});

test('decodeBase64Message decodes an embedded message', () => {
  const inner = stringField(1, 'boxed');
  const fields = decodeBase64Message(inner.toString('base64'));
  assert.equal(asUtf8(fields[0].bytes), 'boxed');
  assert.equal(decodeBase64Message('not base64 !!'), null);
});

test('the sidebar index parser recovers ids, titles, steps, times and workspaces', () => {
  const payload = buildSidebarIndex([
    {
      id: UUID_A,
      title: 'Sandbox sidebar conversation',
      steps: 42,
      createdMs: T0,
      updatedMs: T0 + 3_600_000,
      workspaceUris: ['file:///home/sandbox/alpha'],
      trajectoryId: UUID_B,
    },
  ]);
  const index = parseSidebarIndex(Buffer.from(payload, 'base64'));
  assert.equal(index.size, 1);
  const entry = index.get(UUID_A);
  assert.equal(entry.title, 'Sandbox sidebar conversation');
  assert.equal(entry.stepCount, 42);
  assert.equal(entry.createdMs, T0);
  assert.equal(entry.updatedMs, T0 + 3_600_000);
  assert.deepEqual(entry.workspaceUris, ['file:///home/sandbox/alpha']);
  assert.equal(entry.trajectoryId, UUID_B);
});

test('the sidebar index parser handles several entries and ignores junk', () => {
  const payload = buildSidebarIndex([
    { id: UUID_A, title: 'first', steps: 1, updatedMs: T0 },
    { id: UUID_B, title: 'second', steps: 2, updatedMs: T0 + 1000 },
  ]);
  const index = parseSidebarIndex(Buffer.from(payload, 'base64'));
  assert.deepEqual([...index.keys()].sort(), [UUID_A, UUID_B]);

  const junk = Buffer.concat([stringField(1, 'not-an-entry'), varintField(9, 1)]);
  assert.equal(parseSidebarIndex(junk).size, 0);
  assert.equal(parseSidebarIndex(Buffer.alloc(0)).size, 0);
});

test('an entry without a title still yields the id and timestamps', () => {
  const payload = buildSidebarIndex([{ id: UUID_A, steps: 0, updatedMs: T0 }]);
  const entry = parseSidebarIndex(Buffer.from(payload, 'base64')).get(UUID_A);
  assert.equal(entry.title, null);
  assert.equal(entry.stepCount, 0);
  assert.equal(entry.updatedMs, T0);
});

test('collectStrings walks deeply nested text', () => {
  const deep = bytesField(1, bytesField(2, bytesField(3, stringField(4, 'buried'))));
  assert.ok(collectStrings(walk(deep)).includes('buried'));
});

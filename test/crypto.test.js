/**
 * `.pb` decryption: the container layout and the built-in disk key.
 *
 * The end-to-end cases build a real container with AES-256-GCM, then require
 * `decryptPb` to read it back — and to fail loudly when a single byte is
 * tampered with, because that is what authenticated encryption buys us. A wrong
 * key that silently produced "plausible" bytes would make every recovery claim
 * in this toolkit untrustworthy.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  DISK_KEY,
  KEY_SIZE,
  NONCE_SIZE,
  TAG_SIZE,
  decryptPb,
  describeTrajectory,
  encryptPb,
  isPbContainer,
  looksLikeProtobuf,
  proseStats,
  readVarint,
  topLevelFields,
} from '../src/hosts/antigravity-crypto.js';

/** Encode a protobuf varint. */
function varint(n) {
  const out = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

/** tag(field, wire 2) + length + body. */
function field(fieldNo, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(buf.length), buf]);
}

const KOREAN = '이 문장은 복호화가 실제로 사람이 읽는 대화를 되돌려 주는지 확인하기 위한 것입니다.';

test('the disk key is the 32-byte ASCII string the language server carries', () => {
  assert.equal(DISK_KEY.length, KEY_SIZE);
  assert.equal(DISK_KEY.toString('utf8'), 'safeCodeiumworldKeYsecretBalloon');
});

test('a container survives a round trip', () => {
  const plain = Buffer.concat([field(1, 'cfad63bc-3553-4270-a381-f1b5bf837898'), field(2, KOREAN)]);
  const boxed = encryptPb(plain);

  assert.equal(boxed.length, plain.length + NONCE_SIZE + TAG_SIZE);
  assert.deepEqual(decryptPb(boxed), plain);
});

test('the nonce is fresh per container and sits in the first 12 bytes', () => {
  const plain = Buffer.from('trajectory');
  const a = encryptPb(plain);
  const b = encryptPb(plain);

  assert.notDeepEqual(a.subarray(0, NONCE_SIZE), b.subarray(0, NONCE_SIZE));
  // Two different nonces must not produce the same ciphertext body.
  assert.notDeepEqual(a.subarray(NONCE_SIZE), b.subarray(NONCE_SIZE));
});

test('a fixed nonce reproduces the container byte for byte', () => {
  const nonce = Buffer.alloc(NONCE_SIZE, 7);
  const plain = Buffer.from('same input, same nonce, same bytes');
  assert.deepEqual(encryptPb(plain, { nonce }), encryptPb(plain, { nonce }));
});

test('a wrong key fails authentication instead of returning garbage', () => {
  const boxed = encryptPb(Buffer.from('secret'));
  const wrong = Buffer.alloc(KEY_SIZE, 0x41);

  assert.throws(() => decryptPb(boxed, { key: wrong }), /authenticate|Unsupported state/i);
});

test('a tampered ciphertext fails authentication', () => {
  const boxed = encryptPb(Buffer.from('a conversation that must not be altered'));
  boxed[NONCE_SIZE + 2] ^= 0xff;

  assert.throws(() => decryptPb(boxed), /authenticate|Unsupported state/i);
});

test('a tampered tag fails authentication', () => {
  const boxed = encryptPb(Buffer.from('a conversation that must not be altered'));
  boxed[boxed.length - 1] ^= 0x01;

  assert.throws(() => decryptPb(boxed), /authenticate|Unsupported state/i);
});

test('a wrong-size key is rejected before any cipher work', () => {
  const boxed = encryptPb(Buffer.from('x'));
  assert.throws(() => decryptPb(boxed, { key: Buffer.alloc(16) }), /32 bytes/);
});

test('buffers too small to be a container are refused', () => {
  assert.equal(isPbContainer(Buffer.alloc(NONCE_SIZE + TAG_SIZE)), false);
  assert.equal(isPbContainer(Buffer.alloc(NONCE_SIZE + TAG_SIZE + 1)), true);
  assert.throws(() => decryptPb(Buffer.alloc(4)), /not a \.pb container/);
});

test('a tiny-but-valid container is accepted', () => {
  const boxed = encryptPb(Buffer.from([0x08, 0x01]));
  assert.deepEqual(decryptPb(boxed), Buffer.from([0x08, 0x01]));
});

test('readVarint handles single and multi byte values', () => {
  assert.deepEqual(readVarint(Buffer.from([0x08]), 0), { value: 8n, at: 1 });
  assert.deepEqual(readVarint(Buffer.from([0xac, 0x02]), 0), { value: 300n, at: 2 });
});

test('topLevelFields walks the framing the server uses', () => {
  const message = Buffer.concat([field(1, 'an-id'), field(2, 'step one'), field(2, 'step two')]);
  const fields = topLevelFields(message);

  assert.equal(fields.length, 3);
  assert.deepEqual(
    fields.map((f) => f.field),
    [1, 2, 2]
  );
  assert.deepEqual(
    fields.map((f) => f.wire),
    [2, 2, 2]
  );
  const first = message.subarray(fields[0].valueOffset, fields[0].valueOffset + fields[0].size);
  assert.equal(first.toString('utf8'), 'an-id');
});

test('topLevelFields stops cleanly on a desynchronised tag', () => {
  const message = Buffer.concat([field(1, 'ok'), Buffer.from([0x0f, 0xff, 0xff, 0xff])]);
  const fields = topLevelFields(message);

  // The first field parses; the bogus wire type 7 must end the walk, not throw.
  assert.equal(fields.length, 1);
  assert.equal(fields[0].field, 1);
});

test('describeTrajectory recovers the id, the step count and the prose', () => {
  const message = Buffer.concat([
    field(1, '0201445e-0d9a-437c-b815-fa7942aea3a9'),
    field(2, KOREAN),
    field(2, KOREAN),
    field(3, 'trailing blob'),
  ]);
  const info = describeTrajectory(decryptPb(encryptPb(message)));

  assert.equal(info.id, '0201445e-0d9a-437c-b815-fa7942aea3a9');
  assert.equal(info.steps, 2);
  assert.equal(info.truncated, false);
  assert.ok(info.prose.hangul > 20, `expected Hangul in the prose stats, got ${info.prose.hangul}`);
});

test('proseStats separates readable text from noise', () => {
  const readable = proseStats(Buffer.from('a'.repeat(600)));
  assert.equal(readable.longestRun, 600);
  assert.equal(readable.runs, 1);

  // Random bytes must not look like prose.
  const noise = proseStats(crypto.randomBytes(4096));
  assert.equal(noise.runs, 0);
  assert.ok(noise.longestRun < 24);
});

test('looksLikeProtobuf accepts real framing and rejects nonsense', () => {
  assert.equal(looksLikeProtobuf(Buffer.concat([varint(0x0a), varint(4), Buffer.from('abcd')])), true);
  assert.equal(looksLikeProtobuf(Buffer.from([0x08, 0x96, 0x01, 0x00])), true, 'varint field');

  // Deterministic negatives. Random bytes cannot be used here: a five-way
  // heuristic over a tag byte accepts a large share of random input by design,
  // so the contract worth pinning is these rejections, not a coin flip.
  assert.equal(looksLikeProtobuf(Buffer.from([0x00, 0x00, 0x00, 0x00])), false, 'field 0');
  assert.equal(looksLikeProtobuf(Buffer.from([0x0f, 0x00, 0x00, 0x00])), false, 'wire type 7');
  assert.equal(
    looksLikeProtobuf(Buffer.concat([Buffer.from([0x0a]), varint(9999), Buffer.from('short')])),
    false,
    'length runs past the end'
  );
  assert.equal(looksLikeProtobuf(Buffer.from([0x0a])), false, 'too short to hold a length');
});

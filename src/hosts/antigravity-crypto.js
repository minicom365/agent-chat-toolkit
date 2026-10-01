/**
 * Decrypt an Antigravity `.pb` conversation store without the language server.
 *
 * Layout of the container (verified: the GCM tag authenticates):
 *
 *   [0 .. 12)        nonce, random per file
 *   [12 .. len-16)   AES-256-GCM ciphertext
 *   [len-16 .. len)  authentication tag
 *
 * The key is a fixed 32-byte ASCII string baked into `language_server.exe`. It
 * was read out of the running process: breaking on `crypto/aes.NewCipher` while
 * a `.pb`-backed conversation was loaded showed `safeCodeiumworldKeYsecretBalloon`
 * as the only stable, printable 32-byte key (TLS session keys are random binary
 * and change every connection). The same bytes sit in the `DiskSaver` receiver
 * at offset 0x40, which is what confirms the two sightings are one key.
 *
 * Only `node:crypto` is used, so this keeps the toolkit dependency free.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Fixed disk-encryption key shipped inside the Antigravity language server. */
export const DISK_KEY = Buffer.from('safeCodeiumworldKeYsecretBalloon', 'utf8');

export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;
export const KEY_SIZE = 32;

/** True when `buf` is large enough to be a container at all. */
export function isPbContainer(buf) {
  return Buffer.isBuffer(buf) && buf.length > NONCE_SIZE + TAG_SIZE;
}

/**
 * Decrypt one `.pb` container.
 *
 * Throws when the key is wrong — GCM is authenticated, so a bad key or a
 * corrupted byte fails rather than returning plausible garbage.
 */
export function decryptPb(buf, { key = DISK_KEY } = {}) {
  if (!isPbContainer(buf)) {
    throw new Error(`not a .pb container: ${buf?.length ?? 0} bytes`);
  }
  if (key.length !== KEY_SIZE) {
    throw new Error(`key must be ${KEY_SIZE} bytes, got ${key.length}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, NONCE_SIZE));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_SIZE));
  return Buffer.concat([
    decipher.update(buf.subarray(NONCE_SIZE, buf.length - TAG_SIZE)),
    decipher.final(),
  ]);
}

/** Encrypt with the same layout. Used by tests and by round-trip checks. */
export function encryptPb(plain, { key = DISK_KEY, nonce = null } = {}) {
  const iv = nonce ?? crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Read and decrypt a `.pb` file. `key` overrides the built-in one. */
export function decryptPbFile(file, options = {}) {
  return decryptPb(fs.readFileSync(file), options);
}

/* ------------------------------------------------------- protobuf reading */

/** Minimal varint reader. Returns the value and the offset just past it. */
export function readVarint(buf, at, limit = buf.length) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < limit) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    i += 1;
    if (!(byte & 0x80)) break;
  }
  return { value, at: i };
}

/**
 * Walk the top-level fields of a protobuf message.
 *
 * Stops as soon as a tag cannot be read, so a truncated or unexpected payload
 * yields what was understood rather than throwing.
 */
export function topLevelFields(buf, { limit = buf.length } = {}) {
  const end = Math.min(limit, buf.length);
  const fields = [];
  let at = 0;
  while (at < end) {
    const start = at;
    const tag = readVarint(buf, at, end);
    at = tag.at;
    if (at > end) break;

    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0 || field > 536870911) break;

    let valueOffset = at;
    let size = 0;
    if (wire === 0) {
      valueOffset = at;
      const v = readVarint(buf, at, end);
      at = v.at;
      size = at - valueOffset;
    } else if (wire === 1) {
      valueOffset = at;
      at += 8;
      size = 8;
    } else if (wire === 2) {
      const len = readVarint(buf, at, end);
      valueOffset = len.at;
      const length = Number(len.value);
      if (length < 0 || valueOffset + length > buf.length) break;
      size = length;
      at = valueOffset + length;
    } else if (wire === 5) {
      valueOffset = at;
      at += 4;
      size = 4;
    } else {
      break;
    }
    // A field that starts inside the sample may reach past it; the next
    // iteration simply finds `at >= end` and stops. Bailing out here instead
    // would undercount steps in a large store read with a small sample.
    fields.push({ field, wire, offset: start, valueOffset, size });
    if (fields.length > 1_000_000) break;
  }
  return fields;
}

/**
 * True when the buffer starts with a protobuf field that actually fits.
 *
 * Checking only the tag byte would accept roughly half of all random input, so
 * the first field is walked far enough to reject a length that runs off the end.
 * This is still a cheap sniff, not validation: it answers "is this plausibly a
 * message" for a file whose bytes were encrypted a moment ago.
 */
export function looksLikeProtobuf(buf) {
  if (!buf || buf.length < 4) return false;
  const wire = buf[0] & 7;
  const field = buf[0] >> 3;
  if (field === 0 || field > 200) return false;
  if (wire === 0) return true;
  if (wire === 1) return buf.length >= 9;
  if (wire === 5) return buf.length >= 5;
  if (wire !== 2) return false;
  const { value, at } = readVarint(buf, 1);
  const length = Number(value);
  return at > 1 && length > 0 && at + length <= buf.length;
}

/* -------------------------------------------------------------- reporting */

/**
 * Describe a decrypted trajectory well enough to tell a real one from garbage.
 *
 * `steps` counts top-level field 2 entries, which is how the server frames a
 * `Trajectory`: field 1 is the id, then one field 2 per step.
 */
export function describeTrajectory(plain, { sampleBytes = 4 * 1024 * 1024 } = {}) {
  const fields = topLevelFields(plain, { limit: Math.min(plain.length, sampleBytes) });
  let steps = 0;
  let id = null;
  for (const f of fields) {
    if (f.field === 2 && f.wire === 2) steps += 1;
    if (f.field === 1 && f.wire === 2 && id === null) {
      id = plain.subarray(f.valueOffset, f.valueOffset + f.size).toString('utf8');
    }
  }
  return {
    bytes: plain.length,
    id,
    steps,
    fields: fields.length,
    truncated: plain.length > sampleBytes,
    prose: proseStats(plain),
  };
}

/** Cheap readability signal: long printable runs and Hangul syllables. */
export function proseStats(buf, { sampleBytes = 4 * 1024 * 1024 } = {}) {
  const n = Math.min(buf.length, sampleBytes);
  let longest = 0;
  let run = 0;
  let runs = 0;
  let hangul = 0;
  for (let i = 0; i < n; i += 1) {
    const byte = buf[i];
    if (byte >= 32 && byte < 127) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      if (run >= 24) runs += 1;
      run = 0;
    }
    if (
      byte >= 0xe1 &&
      byte <= 0xed &&
      i + 1 < n &&
      buf[i + 1] >= 0x80 &&
      buf[i + 1] <= 0xbf &&
      i + 2 < n &&
      buf[i + 2] >= 0x80 &&
      buf[i + 2] <= 0xbf
    ) {
      hangul += 1;
    }
  }
  // The run that reaches the end of the sample has no terminating byte to
  // close it, so it is counted here rather than inside the loop.
  if (run >= 24) runs += 1;
  return { longestRun: longest, runs, hangul, sampled: n };
}

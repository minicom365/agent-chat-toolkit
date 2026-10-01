/**
 * Minimal protobuf wire-format reader.
 *
 * Several hosts persist "opaque" state as protocol buffers. Without a `.proto`
 * schema the field names are unknown, but the *wire format* is still fully
 * self-describing enough to walk: field numbers, wire types, varints and
 * length-delimited payloads. That is enough to pull out identifiers, UTF-8
 * strings, file URIs and timestamps from messages nobody documented.
 *
 * This is a reader only. It never writes, so it cannot corrupt a store.
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

export function readVarint(buf, pos, maxBytes = 10) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  let n = 0;
  while (p < buf.length) {
    if (n >= maxBytes) throw new Error('varint too long');
    const b = buf[p];
    p += 1;
    n += 1;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, pos: p };
    shift += 7n;
  }
  throw new Error('truncated varint');
}

/**
 * Walk a message into a flat list of fields.
 * @param {Buffer} buf
 * @returns {{field:number, wire:number, varint?:bigint, bytes?:Buffer}[]}
 */
export function walk(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const tag = readVarint(buf, p);
    p = tag.pos;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) break;

    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, p);
      p = v.pos;
      out.push({ field, wire, varint: v.value });
    } else if (wire === WIRE_LENGTH) {
      const len = readVarint(buf, p);
      p = len.pos;
      if (len.value > BigInt(buf.length - p)) throw new Error('length overflow');
      const end = p + Number(len.value);
      const slice = buf.subarray(p, end);
      p = end;
      out.push({ field, wire, bytes: slice });
    } else if (wire === WIRE_32BIT) {
      if (p + 4 > buf.length) throw new Error('truncated 32-bit field');
      p += 4;
      out.push({ field, wire, fixed32: buf.readUInt32LE(p - 4) });
    } else if (wire === WIRE_64BIT) {
      if (p + 8 > buf.length) throw new Error('truncated 64-bit field');
      p += 8;
      out.push({ field, wire, fixed64: buf.readBigUInt64LE(p - 8) });
    } else {
      break;
    }
    if (out.length > 20000) throw new Error('message too large');
  }
  return out;
}

/** A length-delimited payload is "text" when it decodes to clean UTF-8. */
export function asUtf8(bytes) {
  if (!bytes || bytes.length === 0) return null;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const ch of decoded) {
      const code = ch.codePointAt(0);
      if (code < 0x09 || (code > 0x0d && code < 0x20)) return null;
      if (code === 0xfffd) return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function walkNested(field) {
  if (!field?.bytes || field.bytes.length < 2) return null;
  try {
    const kids = walk(field.bytes);
    return kids.length ? kids : null;
  } catch {
    return null;
  }
}

/** Every nested message, breadth-first, including the root. */
export function* descend(fields, depth = 0) {
  yield { fields, depth };
  if (depth > 8) return;
  for (const f of fields) {
    const kids = walkNested(f);
    if (kids) yield* descend(kids, depth + 1);
  }
}

function asFields(input) {
  if (Buffer.isBuffer(input)) return walk(input);
  if (Array.isArray(input)) return input;
  return [];
}

export function collectStrings(fields, out = []) {
  for (const { fields: f } of descend(asFields(fields))) {
    for (const field of f) {
      if (!field.bytes) continue;
      const text = asUtf8(field.bytes);
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Protobuf `Timestamp` is `{1: seconds, 2: nanos}`. Return every nested message
 * that has that shape, as epoch milliseconds.
 *
 * The plausibility window rejects the sentinel values stores write for "never"
 * (`0001-01-01`, the epoch) instead of reporting them as real dates.
 */
export function collectTimestamps(fields, out = []) {
  for (const { fields: f } of descend(asFields(fields))) {
    const seconds = f.find((x) => x.field === 1 && x.wire === WIRE_VARINT);
    if (!seconds) continue;
    const sec = Number(seconds.varint);
    if (!Number.isFinite(sec) || sec < 1_000_000_000 || sec > 4_000_000_000) continue;
    const nanos = Number(f.find((x) => x.field === 2 && x.wire === WIRE_VARINT)?.varint ?? 0n);
    if (!Number.isFinite(nanos) || nanos < 0 || nanos >= 1e9) continue;
    out.push(sec * 1000 + Math.round(nanos / 1e6));
  }
  return out;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function firstUuid(strings) {
  for (const s of strings) {
    const m = UUID_RE.exec(s);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Decode a base64 string that holds an embedded message. */
export function decodeBase64Message(text) {
  if (typeof text !== 'string' || text.length < 8) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
  try {
    const buf = Buffer.from(text, 'base64');
    if (!buf.length) return null;
    return walk(buf);
  } catch {
    return null;
  }
}

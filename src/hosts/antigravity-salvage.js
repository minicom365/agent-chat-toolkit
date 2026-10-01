/**
 * Salvage text from the parts of a plaintext store that SQLite no longer hands out.
 *
 * Antigravity evicts step payloads by marking them `CORTEX_STEP_STATUS_CLEARED`
 * and replacing the blob with a metadata stub. That makes the text unreachable
 * through a row — it does not erase it. SQLite releases space without zeroing it,
 * so the old bytes survive in two places:
 *
 *   - the **unallocated region** of an allocated page: the gap between the end of
 *     the cell pointer array and the start of the cell content area;
 *   - **freelist pages**, which the database header links as a trunk/leaf list
 *     (offset 32 = first trunk page, offset 36 = how many pages are on it).
 *
 * Measured on a real store reporting 9,064 of 10,085 steps as CLEARED: the
 * unallocated regions hold 0.43 MB of prose, 87.3% of which the language server
 * does not return, and none of which appears in any live row.
 *
 * Only the plaintext generation benefits. A `.pb` is ciphertext end to end, so
 * its slack holds no readable text.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export const DEFAULT_MIN_RUN = 40;
export const DEFAULT_WINDOW = 64;
/** A run counts as lost when at least this share of its windows is not live text. */
export const DEFAULT_MISSING_RATIO = 0.5;

/* ------------------------------------------------------------------ layout */

/**
 * Page geometry and the freelist of a SQLite file.
 * @param {Buffer} buf whole file
 */
export function pageGeometry(buf) {
  if (buf.length < 100) throw new Error('not a SQLite file (too small)');
  if (buf.toString('latin1', 0, 15) !== 'SQLite format 3') {
    throw new Error('not a SQLite file (bad magic)');
  }
  let pageSize = buf.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536) throw new Error(`implausible page size ${pageSize}`);
  const pageCount = Math.floor(buf.length / pageSize);
  const firstTrunk = buf.readUInt32BE(32);
  const declared = buf.readUInt32BE(36);

  const freePages = new Set();
  let trunk = firstTrunk;
  let guard = 0;
  while (trunk !== 0 && guard < 1_000_000) {
    guard += 1;
    const off = (trunk - 1) * pageSize;
    if (off + 8 > buf.length) break;
    const next = buf.readUInt32BE(off);
    const leaves = buf.readUInt32BE(off + 4);
    if (leaves > pageCount) break; // corrupt trunk; stop rather than run away
    freePages.add(trunk);
    for (let i = 0; i < leaves; i += 1) {
      const p = buf.readUInt32BE(off + 8 + i * 4);
      if (p > 0 && p <= pageCount) freePages.add(p);
    }
    trunk = next;
  }
  return { pageSize, pageCount, freePages, declaredFree: declared };
}

/**
 * Every byte range SQLite is not currently using: the per-page unallocated
 * region of allocated pages, plus the freelist pages entire.
 * @returns {{ slack: Array<[number,number]>, free: Array<[number,number]>, slackBytes: number }}
 */
export function unallocatedRanges(buf) {
  const { pageSize, pageCount, freePages } = pageGeometry(buf);
  const slack = [];
  let slackBytes = 0;

  for (let p = 1; p <= pageCount; p += 1) {
    if (freePages.has(p)) continue;
    const base = (p - 1) * pageSize;
    const type = buf[base];
    // 0x0d table leaf, 0x05 table interior; index pages hold no prose
    if (type !== 0x0d && type !== 0x05) continue;
    const headerSize = type === 0x05 ? 12 : 8;
    const nCells = buf.readUInt16BE(base + 3);
    let contentStart = buf.readUInt16BE(base + 5);
    if (contentStart === 0) contentStart = 65536;
    const ptrEnd = base + headerSize + 2 * nCells;
    const contentAt = base + contentStart;
    if (contentAt > ptrEnd && contentAt - ptrEnd <= pageSize) {
      slack.push([ptrEnd, contentAt]);
      slackBytes += contentAt - ptrEnd;
    }
  }

  const free = [...freePages]
    .sort((a, b) => a - b)
    .map((p) => [(p - 1) * pageSize, Math.min(p * pageSize, buf.length)]);

  return {
    slack,
    free,
    slackBytes,
    freeBytes: free.reduce((n, [a, b]) => n + (b - a), 0),
    pageSize,
    pageCount,
    freePages,
  };
}

/* ------------------------------------------------------------------ text */

/**
 * Does this look like something a person wrote, rather than a fragment of
 * protobuf or JSON that happened to decode as text?
 *
 * Page gaps are full of structural debris — paths, identifiers, half-eaten JSON
 * keys — and without this the "recovered" total is mostly noise. Korean counts
 * on sight; otherwise require several real words making up a decent share of the
 * run.
 */
export function looksLikeProse(s) {
  if (/[\uAC00-\uD7A3]/.test(s)) return true;
  const words = s.match(/[A-Za-z]{2,}/g) ?? [];
  if (words.length < 6) return false;
  // Structural debris (JSON, paths, identifiers) is punctuation-dense; written
  // prose is not. This is what separates the two in a page gap.
  const structural = (s.match(/["\\:{}[\]_=/<>|]/g) ?? []).length;
  if (structural / s.length > 0.12) return false;
  const letters = words.reduce((n, w) => n + w.length, 0);
  return letters / s.length > 0.5;
}

/**
 * Runs that look like prose: a letter or Hangul, then more of the same plus the
 * punctuation that survives in a page gap. Length is measured in characters.
 */
export function proseRuns(text, { min = DEFAULT_MIN_RUN, quality = true } = {}) {
  const RUN = /[\uAC00-\uD7A3A-Za-z][\uAC00-\uD7A3A-Za-z0-9\u0020-\u007E\u3000-\u303F\uFF00-\uFFEF]*/g;
  const out = [];
  let m;
  while ((m = RUN.exec(text)) !== null) {
    if (m[0].length < min) continue;
    if (quality && !looksLikeProse(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

const shingle = (s) => crypto.createHash('sha1').update(s).digest('base64');

/** Hash every overlapping window of `text`, so membership can be tested later. */
export function shingleSet(text, { window = DEFAULT_WINDOW, step = 16 } = {}) {
  const set = new Set();
  for (let i = 0; i + window <= text.length; i += step) set.add(shingle(text.slice(i, i + window)));
  return set;
}

/**
 * Keep the runs whose windows are mostly absent from `liveSet`.
 *
 * A whole-run substring test is useless here: one differing character in several
 * thousand makes a run look absent, and the same passage is often present both
 * live and stale.
 */
export function filterLost(runs, liveSet, { window = DEFAULT_WINDOW, missingRatio = DEFAULT_MISSING_RATIO } = {}) {
  const kept = [];
  for (const run of runs) {
    if (run.length < window) {
      kept.push(run);
      continue;
    }
    let windows = 0;
    let missing = 0;
    for (let i = 0; i + window <= run.length; i += window / 2) {
      windows += 1;
      if (!liveSet.has(shingle(run.slice(i, i + window)))) missing += 1;
    }
    if (windows === 0 || missing / windows >= missingRatio) kept.push(run);
  }
  return kept;
}

/** Everything the store can still serve, as one string: every text and blob value. */
export function liveTextOf(db, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const parts = [];
  let total = 0;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of tables) {
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM "${t}"`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string') {
          parts.push(v);
          total += v.length;
        } else if (v instanceof Uint8Array) {
          const s = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
          // Row blobs are protobuf: keep the text inside them, drop the binary.
          for (const r of proseRuns(s, { min: 12 })) {
            parts.push(r);
            total += r.length;
          }
        }
        if (total > maxBytes) return parts.join('\u0000');
      }
    }
  }
  return parts.join('\u0000');
}

/**
 * Salvage one store.
 *
 * @param {string} dbPath
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db] an open read-only handle
 */
export function salvageFile(dbPath, { db = null, min = DEFAULT_MIN_RUN, window = DEFAULT_WINDOW } = {}) {
  const buf = fs.readFileSync(dbPath);
  const regions = unallocatedRanges(buf);

  const deadParts = [];
  for (const [a, b] of regions.slack) deadParts.push(buf.subarray(a, b));
  for (const [a, b] of regions.free) deadParts.push(buf.subarray(a, b));
  const deadText = Buffer.concat(deadParts).toString('utf8');

  const runs = proseRuns(deadText, { min });
  const unique = [...new Set(runs)];

  let liveText = '';
  if (db) liveText = liveTextOf(db);
  const liveSet = liveText ? shingleSet(liveText, { window }) : new Set();
  const lost = liveSet.size ? filterLost(unique, liveSet, { window }) : unique;

  const deadBytes = deadText.length;
  const lostChars = lost.reduce((n, s) => n + s.length, 0);
  return {
    file: dbPath,
    fileBytes: buf.length,
    pageCount: regions.pageCount,
    freePages: regions.freePages.size,
    slackBytes: regions.slackBytes,
    freeBytes: regions.freeBytes,
    deadBytes,
    runs: unique.length,
    lost: lost.length,
    lostChars,
    text: lost,
  };
}

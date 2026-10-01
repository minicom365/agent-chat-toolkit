/**
 * Minimal protobuf *writer*, used only to build sandbox fixtures.
 *
 * The tool itself is read-only with respect to host stores, so this encoder lives
 * in `tools/` and is never imported by `src/`. It exists so the sandbox can
 * produce a realistic `trajectorySummaries` payload instead of shipping a captured
 * blob — a captured blob would be real user data, and would silently stop testing
 * anything the moment the real format changed.
 */

export function varint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

export function varintField(field, value) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

export function bytesField(field, buf) {
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

export function stringField(field, text) {
  return bytesField(field, Buffer.from(String(text), 'utf8'));
}

/** protobuf `Timestamp`. */
export function timestampField(field, epochMs) {
  const seconds = Math.floor(epochMs / 1000);
  const nanos = Math.round((epochMs % 1000) * 1e6);
  return bytesField(field, Buffer.concat([varintField(1, seconds), varintField(2, nanos)]));
}

/**
 * Build an Antigravity `trajectorySummaries` value (the sidebar index).
 * @param {{id:string, title?:string, steps?:number, createdMs?:number, updatedMs?:number, workspaceUris?:string[], trajectoryId?:string}[]} entries
 */
export function buildSidebarIndex(entries) {
  const parts = [];
  for (const e of entries) {
    const summaryParts = [];
    if (e.title) summaryParts.push(stringField(1, e.title));
    if (e.steps != null) summaryParts.push(varintField(2, e.steps));
    if (e.createdMs != null) summaryParts.push(timestampField(3, e.createdMs));
    if (e.trajectoryId) summaryParts.push(stringField(4, e.trajectoryId));
    for (const uri of e.workspaceUris ?? []) summaryParts.push(bytesField(9, stringField(1, uri)));
    if (e.updatedMs != null) summaryParts.push(timestampField(10, e.updatedMs));
    const summary = Buffer.concat(summaryParts);
    const wrapped = bytesField(1, Buffer.from(summary.toString('base64'), 'utf8'));
    parts.push(bytesField(1, Buffer.concat([stringField(1, e.id), bytesField(2, wrapped)])));
  }
  return Buffer.concat(parts).toString('base64');
}

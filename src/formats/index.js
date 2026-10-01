/**
 * Format adapter registry.
 *
 * An adapter maps one on-disk conversation format onto the normalised event
 * shape. Contract:
 *
 *   FORMAT_ID          string   stable id used by --format
 *   FORMAT_DESCRIPTION string   one line for `formats`
 *   looksLike(sample)  boolean  cheap sniff of the first bytes
 *   normalize(line, i, opts)    -> normalised event | null
 *   finalize?(events)           optional post-pass (cross-event pairing)
 *   extractMeta(events)         -> session metadata
 *   knownTypes?()               -> string[] for diagnostics
 */
import * as vscodeTranscript from './vscode-transcript.js';
import * as antigravityTranscript from './antigravity-transcript.js';

export const ADAPTERS = [antigravityTranscript, vscodeTranscript];

export function byId(id) {
  if (!id) return null;
  const wanted = String(id).toLowerCase();
  return (
    ADAPTERS.find((a) => a.FORMAT_ID.toLowerCase() === wanted) ??
    ADAPTERS.find((a) => a.FORMAT_ID.toLowerCase().includes(wanted)) ??
    null
  );
}

export function detect(sampleText) {
  for (const a of ADAPTERS) {
    try {
      if (a.looksLike(sampleText)) return a;
    } catch {
      /* a broken adapter must not break detection of the others */
    }
  }
  return null;
}

export function formatList() {
  return ADAPTERS.map((a) => ({
    id: a.FORMAT_ID,
    description: a.FORMAT_DESCRIPTION,
    types: typeof a.knownTypes === 'function' ? a.knownTypes() : [],
  }));
}

export { vscodeTranscript, antigravityTranscript };

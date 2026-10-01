/**
 * Programmatic API.
 *
 * @example
 * import { findTranscriptFiles, parseTranscript, computeStats } from 'copilot-transcript-stats';
 *
 * const [newest] = await findTranscriptFiles();
 * const parsed = await parseTranscript(newest.file);
 * const stats = computeStats(parsed);
 * console.log(stats.counts.humanTurns, stats.timing.active.ms);
 */
export { findTranscriptFiles, listTranscripts, userDataDirs, resolveSingle } from './discover.js';
export { parseTranscript, peekTranscript, foldTranscripts } from './parse.js';
export { computeStats, sanityWarnings, countWords } from './stats.js';
export { analyzeTiming, timelineOf, capLabel, DEFAULT_CAP_MS, DEFAULT_BREAK_MS, DEFAULT_CAPS_MS } from './timing.js';
export { buildFilter, queryEvents, toRows, previewOf } from './query.js';
export * as format from './formats/vscode-transcript.js';
export {
  exportCsv,
  exportJson,
  exportMarkdown,
  renderList,
  renderStats,
  renderTime,
  renderTools,
  renderTimeline,
  renderSegments,
  renderQuery,
} from './render.js';
export { fmtBytes, fmtDuration, fmtInt, fmtPct } from './util.js';
export { main as run } from './cli.js';

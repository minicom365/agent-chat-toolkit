/**
 * Programmatic API.
 *
 * @example
 * import { allSessions, findSession, parseTranscript, computeStats } from 'agent-chat-toolkit';
 *
 * const sessions = await allSessions();                  // every host, newest first
 * const one = findSession(sessions, '6f36e30a');
 * const parsed = await parseTranscript(one.transcriptPath, { format: 'antigravity-transcript' });
 * const stats = computeStats(parsed, { capMs: 300_000 });
 * console.log(stats.counts.humanTurns, stats.timing.active.ms);
 */
export {
  findTranscriptFiles,
  listTranscripts,
  userDataDirs,
  resolveSingle,
  TRANSCRIPT_GLOBS,
} from './discover.js';
export { parseTranscript, parseLines, peekTranscript, foldTranscripts, detectFormat, readHead } from './parse.js';
export { computeStats, sanityWarnings, countWords } from './stats.js';
export {
  analyzeTiming,
  timelineOf,
  capLabel,
  DEFAULT_CAP_MS,
  DEFAULT_BREAK_MS,
  DEFAULT_CAPS_MS,
} from './timing.js';
export { buildFilter, queryEvents, toRows, previewOf, grepHaystack } from './query.js';
export { ADAPTERS, byId as formatById, detect as detectFormatAdapter, formatList } from './formats/index.js';
export { vscodeTranscript, antigravityTranscript } from './formats/index.js';
export {
  exportCsv,
  exportJson,
  exportMarkdown,
  renderHosts,
  renderSessions,
  renderSearchResults,
  renderMovePlan,
  renderStats,
  renderTime,
  renderTools,
  renderTimeline,
  renderSegments,
  renderQuery,
} from './render.js';
export { HOSTS, allSessions, findSession, inventory, hostIds } from './hosts/index.js';
export { vscode as vscodeHost, antigravity as antigravityHost } from './hosts/index.js';
export { moveSession } from './hosts/vscode.js';
export {
  searchSessions,
  projectLevel,
  artifactsOf,
  LEVEL_NAMES,
  LEVEL_DEFAULT_CHARS,
  levelName,
} from './search.js';
export { assertSafeWriteTarget, backupFile, SafetyError, runningProcesses } from './safety.js';
export { sqliteAvailable, readIndex, writeIndex, readItem, INDEX_KEY } from './sqlite.js';
export { fmtBytes, fmtDuration, fmtInt, fmtPct, localStamp, dayKey } from './util.js';
export { main as run, parseArgs, parseDuration, VERSION } from './cli.js';

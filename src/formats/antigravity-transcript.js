/**
 * Format adapter: Antigravity Brain transcript (JSONL step log).
 *
 * Location:
 *   <brain>/<conversationId>/.system_generated/logs/transcript.jsonl
 *   <brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl   (untruncated superset)
 *
 * Envelope (one JSON object per line, ordered by `step_index`):
 *   { "step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT",
 *     "status": "DONE", "created_at": "2026-09-28T06:01:26Z", "content": "…" }
 *
 * Extra fields seen per type:
 *   PLANNER_RESPONSE  thinking, content?, tool_calls[{name,args}], truncated_fields
 *   RUN_COMMAND       content, exit_code, truncated_fields
 *   ERROR_MESSAGE     error, error_code
 *   GENERIC           content, media, error
 *
 * Differences from the VS Code adapter that matter
 * ------------------------------------------------
 * 1. There is no separate "tool start" event. A tool *request* lives in the
 *    `tool_calls` array of a `PLANNER_RESPONSE`, and the *result* arrives later
 *    as its own event whose `type` names the tool kind. Requests and results are
 *    paired here in step order by `finalize()`, which is what makes tool timing
 *    and tool names available at all.
 * 2. `step_index` is the ordering key; there is no event id or parent id.
 * 3. `content` is overloaded: prose for USER_INPUT/PLANNER_RESPONSE, tool output
 *    for every other MODEL type. Tool output is therefore parked in
 *    `observation`, never in `text`, so it cannot pollute prose statistics.
 */

export const FORMAT_ID = 'antigravity-transcript';
export const FORMAT_DESCRIPTION = 'Antigravity Brain transcript (JSONL step log)';

export const ARGS_TEXT_CAP = 8000;
export const OBSERVATION_CAP = 4000;

const USER_TYPE = 'USER_INPUT';
const PROSE_TYPE = 'PLANNER_RESPONSE';
const ERROR_TYPE = 'ERROR_MESSAGE';

/** Answer/observation events emitted by the model after a tool call. */
const TOOL_RESULT_TYPES = new Set([
  'GENERIC',
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'SEARCH_WEB',
  'READ_URL_CONTENT',
  'CODE_ACTION',
  'CHECKPOINT',
  'INVOKE_SUBAGENT',
  'ASK_QUESTION',
]);

const SYSTEM_TYPES = new Set(['SYSTEM_MESSAGE', 'CONVERSATION_HISTORY', 'EPHEMERAL_MESSAGE']);

const ROLE_BY_TYPE = {
  [USER_TYPE]: 'user',
  [PROSE_TYPE]: 'assistant',
  [ERROR_TYPE]: 'system',
};

for (const t of TOOL_RESULT_TYPES) ROLE_BY_TYPE[t] = 'tool';
for (const t of SYSTEM_TYPES) ROLE_BY_TYPE[t] = 'system';

export function roleForType(type) {
  return ROLE_BY_TYPE[type] ?? 'system';
}

export function knownTypes() {
  return Object.keys(ROLE_BY_TYPE);
}

/**
 * Antigravity step logs are identified by `step_index` + `created_at`; VS Code
 * transcripts use `timestamp`/`id`/`parentId` and never carry `step_index`.
 * Checking structure instead of a type allow-list means every Antigravity event
 * type is recognised, including ones a future build adds.
 */
export function looksLike(sampleText) {
  if (!sampleText) return false;
  if (!/"step_index"\s*:/.test(sampleText)) return false;
  if (!/"created_at"\s*:/.test(sampleText)) return false;
  for (const raw of sampleText.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s[0] !== '{') continue;
    try {
      const o = JSON.parse(s);
      if (o && Number.isFinite(Number(o.step_index)) && typeof o.type === 'string') return true;
    } catch {
      /* not a complete line */
    }
  }
  return false;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanText(s) {
  if (!s) return '';
  return String(s).replace(ANSI, '').trim();
}

/** `<USER_REQUEST>…</USER_REQUEST>` holds the human's actual words. */
export function extractUserRequest(content) {
  if (!content) return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  return cleanText(m ? m[1] : content);
}

/** One-line summary of a tool call, mirroring Antigravity's own arg shapes. */
export function summarizeToolCall(tc) {
  const name = tc?.name ?? 'tool';
  const args = tc?.args ?? {};
  let detail = '';
  if (name === 'run_command') detail = str(args.CommandLine).slice(0, 80);
  else if (name === 'view_file' || name === 'write_to_file' || name === 'replace_file_content' || name === 'multi_replace_file_content')
    detail = baseName(args.AbsolutePath ?? args.TargetFile ?? '');
  else if (name === 'list_dir') detail = str(args.DirectoryPath);
  else if (name === 'grep_search') detail = str(args.Query ?? args.SearchPath);
  else if (name === 'search_web') detail = str(args.query ?? args.Query);
  else if (name === 'manage_task' || name === 'invoke_subagent') detail = str(args.Action ?? args.TaskId);
  else detail = str(args.toolSummary ?? args.toolAction ?? args.Description ?? '');
  return detail ? `${name}(${strip(detail)})` : name;
}

export function normalize(raw, index, opts = {}) {
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.type !== 'string') return null;
  if (!('step_index' in o)) return null;

  const type = o.type;
  const ts = Date.parse(o.created_at);
  const stepIndex = Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : index;

  const ev = {
    i: index,
    stepIndex,
    id: null,
    parentId: null,
    type,
    role: roleForType(type),
    ts: Number.isFinite(ts) ? ts : null,
    control: false,
    unknown: !(type in ROLE_BY_TYPE),
    text: '',
    chars: 0,
    reasoningChars: 0,
    observation: '',
    observationChars: 0,
    toolName: null,
    toolCallId: null,
    toolMs: null,
    success: null,
    argsChars: 0,
    argsText: '',
    argsTruncated: false,
    requestCount: 0,
    requestedTools: [],
    attachmentCount: 0,
    session: null,
    status: typeof o.status === 'string' ? o.status : null,
    source: typeof o.source === 'string' ? o.source : null,
    exitCode: Number.isFinite(Number(o.exit_code)) ? Number(o.exit_code) : null,
    /** pending requests carried until `finalize()` pairs them with results */
    pending: null,
  };

  if (type === USER_TYPE) {
    ev.text = extractUserRequest(o.content);
    ev.chars = ev.text.length;
  } else if (type === PROSE_TYPE) {
    ev.text = cleanText(o.content);
    ev.chars = ev.text.length;
    ev.reasoningChars = typeof o.thinking === 'string' ? o.thinking.length : 0;
    const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
    ev.requestCount = calls.length;
    ev.requestedTools = calls.map((c) => c?.name ?? 'unknown');
    if (calls.length) {
      ev.pending = calls.map((c) => {
        const text = safeStringify(c?.args ?? {});
        return {
          name: c?.name ?? 'unknown',
          argsChars: text.length,
          argsText: text.length > ARGS_TEXT_CAP ? text.slice(0, ARGS_TEXT_CAP) : text,
          argsTruncated: text.length > ARGS_TEXT_CAP,
          summary: summarizeToolCall(c),
        };
      });
    }
  } else if (TOOL_RESULT_TYPES.has(type) || type === ERROR_TYPE) {
    const text = cleanText(o.content);
    ev.observationChars = text.length;
    ev.observation = text.length > OBSERVATION_CAP ? text.slice(0, OBSERVATION_CAP) : text;
    if (type === ERROR_TYPE) {
      ev.success = false;
      ev.errorKind = typeof o.error === 'string' ? o.error : null;
      ev.errorCode = o.error_code ?? null;
    } else if (o.status === 'DONE') {
      ev.success = ev.exitCode == null || ev.exitCode === 0;
    } else if (o.status === 'ERROR') {
      ev.success = false;
    }
    if (o.truncated_fields) ev.truncatedFields = true;
  } else {
    const text = cleanText(o.content);
    ev.text = text;
    ev.chars = text.length;
  }

  if (opts.keepData) ev.data = o;
  return ev;
}

/**
 * Pair each tool result with the request that produced it, in step order.
 * Mutates the events, removes the temporary `pending` list, and returns nothing.
 */
export function finalize(events) {
  let queue = [];
  let queueSource = null;
  for (const ev of events) {
    if (ev.pending) {
      queue = ev.pending;
      queueSource = ev;
      delete ev.pending;
      continue;
    }
    if (ev.role !== 'tool') {
      // a new assistant turn invalidates anything still unanswered
      if (ev.type === PROSE_TYPE || ev.type === USER_TYPE) queue = [];
      continue;
    }
    const req = queue.shift() ?? null;
    if (!req) {
      ev.toolName = ev.type === 'GENERIC' ? 'generic' : ev.type.toLowerCase();
      continue;
    }
    ev.toolName = req.name;
    ev.argsText = req.argsText;
    ev.argsChars = req.argsChars;
    ev.argsTruncated = req.argsTruncated;
    ev.argsSummary = req.summary;
    ev.toolCallId = `step${queueSource?.stepIndex ?? '?'}:${ev.stepIndex}`;
    ev.requestedBy = queueSource?.stepIndex ?? null;
    if (queueSource?.ts != null && ev.ts != null) {
      ev.toolMs = Math.max(0, ev.ts - queueSource.ts);
    }
  }
  for (const ev of events) delete ev.pending;
}

/** Session metadata is not in the transcript; it lives in the session folder. */
export function extractMeta() {
  return {
    sessionId: null,
    producer: 'antigravity',
    copilotVersion: null,
    vscodeVersion: null,
    declaredStartTime: null,
  };
}

function str(v) {
  return v == null ? '' : String(v);
}

function strip(v) {
  return str(v).replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
}

function baseName(p) {
  const s = strip(p);
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function safeStringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

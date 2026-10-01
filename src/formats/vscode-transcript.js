/**
 * Format adapter: VS Code Copilot Chat "agent transcript" (append-only JSONL event log).
 *
 * Every line is a self-describing envelope:
 *   { "type": "...", "data": { ... }, "id": "<uuid>", "timestamp": "<ISO-8601>", "parentId": "<uuid>|null" }
 *
 * Known event types (producers may add more; unknown types are kept, not dropped):
 *   session.start              data: sessionId, version, producer, copilotVersion, vscodeVersion, startTime
 *   user.message               data: content, attachments
 *   assistant.turn_start       data: turnId                                  (control)
 *   assistant.message          data: messageId, content, toolRequests[], reasoningText?
 *   assistant.turn_end         data: turnId                                  (control)
 *   tool.execution_start       data: toolCallId, toolName, arguments
 *   tool.execution_complete    data: toolCallId, success
 *
 * Design notes
 * ------------
 * A transcript mixes three very different kinds of "turns":
 *   1. real conversation  - `user.message`  <->  `assistant.message`
 *   2. agent bookkeeping  - `assistant.turn_start` / `assistant.turn_end`
 *   3. tool round-trips   - `tool.execution_start` / `tool.execution_complete`
 * Counting raw lines therefore massively overstates "conversation turns".
 * This adapter exposes `role` so callers can separate them.
 */

export const FORMAT_ID = 'vscode-transcript';
export const FORMAT_DESCRIPTION =
  'VS Code Copilot Chat agent transcript (append-only JSONL event log)';

/** Cap on how much of a tool-call argument blob is retained for `query --tool-grep`. */
export const ARGS_TEXT_CAP = 8000;

const ROLE_BY_TYPE = {
  'session.start': 'system',
  'session.end': 'system',
  'user.message': 'user',
  'assistant.turn_start': 'assistant',
  'assistant.message': 'assistant',
  'assistant.turn_end': 'assistant',
  'tool.execution_start': 'tool',
  'tool.execution_complete': 'tool',
};

export function roleForType(type) {
  return ROLE_BY_TYPE[type] ?? 'system';
}

export function knownTypes() {
  return Object.keys(ROLE_BY_TYPE);
}

/** Cheap probe used while discovering files: does this text look like our format? */
export function looksLike(sampleText) {
  if (!sampleText) return false;
  return /"type"\s*:\s*"(?:session\.start|user\.message|assistant\.message|tool\.execution_start)"/.test(
    sampleText
  );
}

/**
 * Parse a single JSONL line into a normalised event, or null when unusable.
 * @param {string} raw
 * @param {number} index
 * @param {{ keepData?: boolean }} [opts]
 */
export function normalize(raw, index, opts = {}) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;

  const type = typeof envelope.type === 'string' ? envelope.type : 'unknown';
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const ts = Date.parse(envelope.timestamp);

  const event = {
    i: index,
    id: envelope.id ?? null,
    parentId: envelope.parentId ?? null,
    type,
    role: roleForType(type),
    ts: Number.isFinite(ts) ? ts : null,
    control: false,
    unknown: !(type in ROLE_BY_TYPE),
    text: '',
    chars: 0,
    reasoningChars: 0,
    toolName: null,
    toolCallId: null,
    success: null,
    argsChars: 0,
    argsText: '',
    argsTruncated: false,
    requestCount: 0,
    requestedTools: [],
    attachmentCount: 0,
    session: null,
  };

  switch (type) {
    case 'user.message': {
      event.text = typeof data.content === 'string' ? data.content : '';
      event.chars = event.text.length;
      event.attachmentCount = Array.isArray(data.attachments) ? data.attachments.length : 0;
      break;
    }
    case 'assistant.message': {
      event.text = typeof data.content === 'string' ? data.content : '';
      event.chars = event.text.length;
      event.reasoningChars =
        typeof data.reasoningText === 'string' ? data.reasoningText.length : 0;
      event.requestCount = Array.isArray(data.toolRequests) ? data.toolRequests.length : 0;
      event.requestedTools = Array.isArray(data.toolRequests)
        ? data.toolRequests.map((t) => (t && typeof t.name === 'string' ? t.name : 'unknown'))
        : [];
      break;
    }
    case 'assistant.turn_start':
    case 'assistant.turn_end': {
      event.control = true;
      break;
    }
    case 'session.start': {
      event.control = true;
      event.session = {
        sessionId: data.sessionId ?? null,
        producer: data.producer ?? null,
        copilotVersion: data.copilotVersion ?? null,
        vscodeVersion: data.vscodeVersion ?? null,
        startTime: data.startTime ?? null,
      };
      break;
    }
    case 'session.end': {
      event.control = true;
      break;
    }
    case 'tool.execution_start': {
      event.toolName = typeof data.toolName === 'string' ? data.toolName : 'unknown';
      event.toolCallId = data.toolCallId ?? null;
      const text = safeStringify(data.arguments);
      event.argsChars = text.length;
      event.argsTruncated = text.length > ARGS_TEXT_CAP;
      event.argsText = event.argsTruncated ? text.slice(0, ARGS_TEXT_CAP) : text;
      break;
    }
    case 'tool.execution_complete': {
      event.toolCallId = data.toolCallId ?? null;
      event.success = data.success === true ? true : data.success === false ? false : null;
      break;
    }
    default: {
      if (typeof data.content === 'string') {
        event.text = data.content;
        event.chars = event.text.length;
      }
      break;
    }
  }

  if (opts.keepData) event.data = data;
  return event;
}

/** Session metadata taken from the `session.start` event (falls back to the first timestamp). */
export function extractMeta(events) {
  const start = events.find((e) => e.type === 'session.start');
  const s = start?.session ?? {};
  return {
    sessionId: s.sessionId ?? null,
    producer: s.producer ?? null,
    copilotVersion: s.copilotVersion ?? null,
    vscodeVersion: s.vscodeVersion ?? null,
    declaredStartTime: s.startTime ?? null,
  };
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

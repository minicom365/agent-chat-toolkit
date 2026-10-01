/**
 * Fully synthetic transcript used by the test-suite.
 * No real prompt, path or identifier appears here on purpose.
 */

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export const t0 = T0;
export const at = (seconds) => T0 + Math.round(seconds * 1000);

function line(type, ts, data, id) {
  return JSON.stringify({
    type,
    data,
    id: id ?? `${type}:${ts}`,
    timestamp: new Date(ts).toISOString(),
    parentId: null,
  });
}

/**
 * A tiny but structurally complete session:
 *   0s   session.start
 *   1s   assistant.message (tool request)         assistant turn 1
 *   2s   tool.execution_start
 *   6s   tool.execution_complete                  tool takes 4s
 *   8s   assistant.turn_end
 *   60s  user.message   <- human thought for 52s
 *   61s  assistant.message
 *   62s  tool.execution_start
 *   63s  tool.execution_complete
 *   64s  assistant.turn_end
 *   5000s user.message  <- long break (82m)
 *   5001s assistant.message
 *   5002s assistant.turn_end
 */
export function syntheticLines() {
  return [
    line('session.start', at(0), {
      sessionId: 'synthetic-session',
      version: 1,
      producer: 'copilot-agent',
      copilotVersion: '0.0.0-test',
      vscodeVersion: '0.0.0-test',
      startTime: new Date(at(0)).toISOString(),
    }),
    line('assistant.turn_start', at(1), { turnId: '1' }),
    line('assistant.message', at(1), {
      messageId: 'm1',
      content: 'first reply',
      toolRequests: [{ toolCallId: 'c1', name: 'read_file', type: 'function' }],
      reasoningText: 'thinking about the first reply',
    }),
    line('tool.execution_start', at(2), { toolCallId: 'c1', toolName: 'read_file', arguments: { filePath: 'a.txt' } }),
    line('tool.execution_complete', at(6), { toolCallId: 'c1', success: true }),
    line('assistant.turn_end', at(8), { turnId: '1' }),

    line('user.message', at(60), { content: 'second ask', attachments: [] }),
    line('assistant.turn_start', at(61), { turnId: '2' }),
    line('assistant.message', at(61), { messageId: 'm2', content: 'second reply', toolRequests: [] }),
    line('tool.execution_start', at(62), { toolCallId: 'c2', toolName: 'run_in_terminal', arguments: { command: 'echo hi' } }),
    line('tool.execution_complete', at(63), { toolCallId: 'c2', success: false }),
    line('assistant.turn_end', at(64), { turnId: '2' }),

    line('user.message', at(5000), { content: 'third ask after a long break', attachments: [] }),
    line('assistant.turn_start', at(5001), { turnId: '3' }),
    line('assistant.message', at(5001), { messageId: 'm3', content: 'third reply', toolRequests: [] }),
    line('assistant.turn_end', at(5002), { turnId: '3' }),
  ];
}

export function syntheticStatsLines() {
  return [
    line('session.start', at(0), { sessionId: 's2', producer: 'copilot-agent' }),
    line('user.message', at(10), { content: 'hi', attachments: [] }),
    line('assistant.message', at(11), {
      messageId: 'x',
      content: 'hello',
      toolRequests: [
        { toolCallId: 'c1', name: 'grep_search', type: 'function' },
        { toolCallId: 'c2', name: 'read_file', type: 'function' },
      ],
    }),
    line('tool.execution_start', at(12), { toolCallId: 'c1', toolName: 'grep_search', arguments: { q: 'x' } }),
    line('tool.execution_complete', at(13), { toolCallId: 'c1', success: true }),
    line('tool.execution_start', at(14), { toolCallId: 'c2', toolName: 'read_file', arguments: { p: 'y' } }),
    line('tool.execution_complete', at(20), { toolCallId: 'c2', success: false }),
    line('user.message', at(30), { content: 'bye', attachments: [] }),
  ];
}

export { line as syntheticLine };

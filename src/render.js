import {
  fmtBytes,
  fmtDuration,
  fmtInt,
  fmtPct,
  localStamp,
  table,
  toCsv,
  truncate,
} from './util.js';
import { capLabel } from './timing.js';
import { previewOf, toRows } from './query.js';

const SEP = '─'.repeat(72);

function h(st, title) {
  return `\n${st.bold(title)}\n${st.gray(SEP)}`;
}

function kv(st, rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, v]) => `${st.gray(k.padEnd(width))}  ${v}`)
    .join('\n');
}

/* ------------------------------------------------------------------ list */

export function renderList(rows, { styler: st, total }) {
  if (!rows.length) return 'No transcripts found.';
  const body = rows.map((r, n) => [
    String(n + 1),
    localStamp(r.mtimeMs),
    fmtBytes(r.bytes),
    r.workspace ?? '-',
    r.name.slice(0, 8),
    truncate(r.firstTimestamp ? localStamp(r.firstTimestamp) : '-', 16),
    truncate(r.firstUserMessage ?? '(no user message in first 256KB)', 46),
  ]);
  return [
    h(st, `Transcripts (${rows.length}${total > rows.length ? ` of ${total}` : ''})`),
    '',
    table(
      ['#', 'modified', 'size', 'workspace', 'session', 'first event', 'first prompt'],
      body,
      ['right', 'left', 'right', 'left', 'left', 'left', 'left']
    ),
    '',
    st.gray('Use the `#` or the `session` prefix with --file (prefix matching is supported).'),
  ].join('\n');
}

/* ----------------------------------------------------------------- stats */

export function renderStats(stats, { styler: st, warnings = [] }) {
  const c = stats.counts;
  const t = stats.timing;
  const out = [];

  out.push(h(st, 'Session'));
  out.push(
    kv(st, [
      ['file', stats.file],
      ['size / lines', `${fmtBytes(stats.bytes)} / ${fmtInt(stats.totalLines)}`],
      ['session id', stats.meta.sessionId ?? '-'],
      ['producer', `${stats.meta.producer ?? '-'} (copilot ${stats.meta.copilotVersion ?? '?'}, vscode ${stats.meta.vscodeVersion ?? '?'})`],
      ['window', t.span.first ? `${localStamp(t.span.first)} → ${localStamp(t.span.last)}` : '-'],
      ['wall-clock span', fmtDuration(t.span.ms)],
    ])
  );
  if (stats.parseErrors) {
    out.push(st.yellow(`  ${stats.parseErrors} unparsable line(s) skipped`));
  }

  out.push(h(st, '1. Conversation statistics'));
  out.push(
    kv(st, [
      ['human turns (user.message)', st.bold(fmtInt(c.humanTurns))],
      ['assistant messages', fmtInt(c.assistantMessages)],
      ['agent turn markers (turn_start)', fmtInt(c.agentSegments)],
      ['tool calls executed', fmtInt(c.toolCalls) + (c.toolFailures ? st.red(` (${fmtInt(c.toolFailures)} failed)`) : '')],
      ['tool calls requested by model', fmtInt(c.toolRequests)],
      ['distinct tools', fmtInt(c.uniqueTools)],
      ['total events (raw lines)', fmtInt(c.events)],
    ])
  );
  out.push('');
  out.push(st.gray('  Derived ratios (this is where tool traffic contaminates naive counts):'));
  out.push(
    kv(st, [
      ['agent markers per human turn', stats.ratios.agentSegmentsPerHumanTurn.toFixed(2)],
      ['tool calls per human turn', stats.ratios.toolCallsPerHumanTurn.toFixed(2)],
      ['assistant msgs per human turn', stats.ratios.assistantPerHumanTurn.toFixed(2)],
      ['tool failure rate', fmtPct(stats.ratios.toolFailureRate * 100, 100)],
      ['machine-only line share', st.yellow(fmtPct(stats.ratios.machineLineShare * 100, 100))],
    ])
  );
  out.push('');
  out.push(
    st.gray(
      `  → ${fmtInt(c.humanTurns)} real ask(s) produced ${fmtInt(c.toolCalls)} tool round-trip(s) and ` +
        `${fmtInt(c.assistantMessages)} assistant message(s).`
    )
  );

  out.push(h(st, '2. Volume'));
  const proseTotal = stats.text.userChars + stats.text.assistantChars;
  out.push(
    kv(st, [
      ['user text', `${fmtInt(stats.text.userChars)} chars / ~${fmtInt(stats.text.userWords)} words`],
      [
        'assistant text',
        `${fmtInt(stats.text.assistantChars)} chars (${fmtInt(stats.text.assistantCodeBlocks)} code blocks)`,
      ],
      ['assistant reasoning text', `${fmtInt(stats.text.reasoningChars)} chars`],
      [
        'tool arguments (machine text)',
        `${st.gray(fmtInt(stats.text.toolArgsChars) + ' chars')}  ${st.gray('← not human prose')}`,
      ],
      ['human share of prose', fmtPct(stats.text.userChars, proseTotal)],
    ])
  );

  out.push(h(st, '3. Tool usage'));
  const tools = stats.tools.slice(0, 15);
  if (tools.length) {
    out.push(
      table(
        ['tool', 'calls', 'failed', 'args chars', 'meas. runtime'],
        tools.map((x) => [
          x.name,
          fmtInt(x.calls),
          x.failed ? st.red(fmtInt(x.failed)) : '0',
          fmtInt(x.argsChars),
          x.timed ? fmtDuration(x.ms) : '-',
        ]),
        ['left', 'right', 'right', 'right', 'right']
      )
    );
    if (stats.tools.length > tools.length) {
      out.push(st.gray(`  … ${stats.tools.length - tools.length} more tool(s)`));
    }
    const totalMs = stats.timing.toolRuntimeTotals?.ms ?? 0;
    out.push(
      st.gray(
        `  total measured tool runtime ${fmtDuration(totalMs)} · ` +
          `${fmtInt(stats.timing.toolRuntimeTotals?.calls ?? 0)} completed call(s)`
      )
    );
  } else {
    out.push('  (no tool executions)');
  }

  out.push(h(st, '4. Effective development time'));
  out.push(...timingBody(st, t));

  out.push(h(st, '5. Per-day activity'));
  if (t.days.length) {
    out.push(
      table(
        ['day', 'first', 'last', 'events', 'asks', 'tools', 'active(capped)'],
        t.days.map((d) => [
          d.day,
          localStamp(d.first).slice(11),
          localStamp(d.last).slice(11),
          fmtInt(d.events),
          fmtInt(d.humanTurns),
          fmtInt(d.toolCalls),
          fmtDuration(d.activeMs),
        ]),
        ['left', 'right', 'right', 'right', 'right', 'right', 'right']
      )
    );
    out.push(
      st.gray(
        `  ${t.activeDayCount} active day(s); capped at ${capLabel(t.capMs)} of counted silence per gap.`
      )
    );
  } else {
    out.push('  (no dateable events)');
  }

  if (warnings.length) {
    out.push(h(st, 'Notes'));
    for (const w of warnings) out.push(st.yellow(`  • ${w}`));
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ time */

export function renderTime(t, { styler: st, title = 'Effective development time' }) {
  return [h(st, title), ...timingBody(st, t), ...breaksBody(st, t), ...daysBody(st, t)].join('\n');
}

function timingBody(st, t) {
  const out = [];
  if (!t.span.first) return ['  (no timestamped events)'];
  out.push(
    kv(st, [
      ['window', `${localStamp(t.span.first)} → ${localStamp(t.span.last)}`],
      ['wall-clock span', fmtDuration(t.span.ms)],
      ['timestamped events', fmtInt(t.eventCount)],
      [
        st.bold(`effective time (cap ${capLabel(t.capMs)})`),
        st.bold(st.green(fmtDuration(t.active.ms))) +
          st.gray(`  = ${fmtPct(t.active.ratio * 100, 100)} of span`),
      ],
      ['idle (breaks + untouched)', fmtDuration(Math.max(0, t.span.ms - t.active.ms))],
      ['breaks > ' + capLabel(t.breakMs), fmtInt(t.breakCount ?? 0)],
    ])
  );
  out.push('');
  out.push(st.gray('  Sensitivity of the cap (the cap is a modelling choice, not a measurement):'));
  out.push(
    table(
      ['cap / gap', 'effective time', 'idle', 'active ratio'],
      t.byCap.map((r) => [
        capLabel(r.capMs) + (r.isDefault ? st.cyan(' *') : ''),
        fmtDuration(r.activeMs),
        fmtDuration(r.idleMs),
        fmtPct(r.ratio * 100, 100),
      ]),
      ['right', 'right', 'right', 'right']
    )
  );
  out.push(st.gray('  * = cap used for the headline number'));
  out.push('');
  out.push(st.gray('  Phase attribution (a gap is charged to the event that ends it):'));
  const phases = t.phases ? Object.values(t.phases).filter((p) => p.count > 0) : [];
  if (phases.length) {
    out.push(
      table(
        ['phase', 'gaps', 'raw', `capped(${capLabel(t.capMs)})`],
        phases.map((p) => [p.label, fmtInt(p.count), fmtDuration(p.raw), fmtDuration(p.byCap[t.capMs] ?? 0)]),
        ['left', 'right', 'right', 'right']
      )
    );
    const think = t.phases.human.byCap[t.capMs] ?? 0;
    const model = t.phases.model.byCap[t.capMs] ?? 0;
    const tool = t.phases.tool.byCap[t.capMs] ?? 0;
    out.push('');
    out.push(
      st.gray(
        `  human ${fmtDuration(think)} + agent ${fmtDuration(model)} + tool ${fmtDuration(tool)} ` +
          `≈ ${fmtDuration(think + model + tool)}`
      )
    );
  }
  return out;
}

function breaksBody(st, t) {
  if (!t.breaks?.length) return [];
  const out = ['', st.bold('  Longest interruptions'), ''];
  out.push(
    table(
      ['duration', 'last event before break', 'resumed at', 'resumed with'],
      t.breaks.map((b) => [
        fmtDuration(b.ms),
        b.from.slice(0, 26),
        localStamp(b.toTs),
        truncate(b.resumedWith ?? b.to.slice(0, 26), 42),
      ]),
      ['right', 'left', 'left', 'left']
    )
  );
  return out;
}

function daysBody(st, t) {
  if (!t.days?.length) return [];
  return [
    '',
    st.bold('  Per-day active time'),
    '',
    table(
      ['day', 'span', 'active(capped)', 'asks', 'tools'],
      t.days.map((d) => [
        d.day,
        fmtDuration(d.last - d.first),
        fmtDuration(d.activeMs),
        fmtInt(d.humanTurns),
        fmtInt(d.toolCalls),
      ]),
      ['left', 'right', 'right', 'right', 'right']
    ),
  ];
}

/* ----------------------------------------------------------------- tools */

export function renderTools(stats, { styler: st }) {
  const rows = stats.tools.map((x) => [
    x.name,
    fmtInt(x.calls),
    x.failed ? st.red(fmtInt(x.failed)) : '0',
    fmtPct(x.failRate * 100, 100),
    fmtInt(x.argsChars),
    x.timed ? fmtDuration(x.ms) : '-',
    x.timed ? fmtDuration(x.calls ? x.ms / x.timed : 0) : '-',
  ]);
  const out = [
    h(st, `Tool usage (${stats.tools.length} distinct)`),
    '',
    table(['tool', 'calls', 'failed', 'fail rate', 'args chars', 'total runtime', 'mean'], rows, [
      'left',
      'right',
      'right',
      'right',
      'right',
      'right',
      'right',
    ]),
  ];
  if (stats.requestedTools?.length) {
    out.push('', st.bold('  Requested by model (assistant.toolRequests)'));
    out.push(
      table(
        ['tool', 'requests'],
        stats.requestedTools.slice(0, 25).map((r) => [r.name, fmtInt(r.n)]),
        ['left', 'right']
      )
    );
  }
  return out.join('\n');
}

/* -------------------------------------------------------------- timeline */

export function renderTimeline(events, { styler: st, limit = 200, showText = false }) {
  const limited = events.slice(0, limit);
  let prev = null;
  const rows = limited.map((e) => {
    const gap = prev && e.ts != null && prev.ts != null ? e.ts - prev.ts : null;
    prev = e;
    return [
      fmtInt(e.i),
      e.ts == null ? '-' : localStamp(e.ts),
      gap == null || gap < 0 ? '' : gap >= 1000 ? `+${fmtDuration(gap)}` : `+${gap}ms`,
      e.type,
      e.toolName ?? '',
      e.chars ? `${fmtInt(e.chars)}c` : e.argsChars ? `${fmtInt(e.argsChars)}c` : '',
      truncate(showText && e.text ? e.text : previewOf(e), showText ? 90 : 60),
    ];
  });
  const out = [
    h(st, `Timeline (${Math.min(events.length, limit)} of ${events.length} events)`),
    '',
    table(['#', 'time', 'Δ', 'type', 'tool', 'size', 'preview'], rows, [
      'right',
      'left',
      'right',
      'left',
      'left',
      'right',
      'left',
    ]),
  ];
  if (events.length > limited.length) {
    out.push('', st.gray(`  … ${events.length - limited.length} more event(s); use --limit to widen.`));
  }
  return out.join('\n');
}

export function renderSegments(timing, { styler: st, limit = 50 }) {
  const rows = timing.segments.slice(0, limit).map((s) => [
    String(s.n),
    localStamp(s.startTs),
    fmtDuration(s.agentMs),
    fmtDuration(s.thinkMs),
    fmtInt(s.events),
    fmtInt(s.toolCalls),
    truncate(s.prompt, 52),
  ]);
  return [
    h(st, `Turns (${Math.min(timing.segments.length, limit)} of ${timing.segments.length})`),
    '',
    table(
      ['#', 'asked at', 'agent time', 'think time', 'events', 'tools', 'prompt'],
      rows,
      ['right', 'left', 'right', 'right', 'right', 'right', 'left']
    ),
  ].join('\n');
}

/* ----------------------------------------------------------------- query */

export function renderQuery(events, { styler: st, limit }) {
  if (!events.length) return 'No events matched.';
  const rows = toRows(events).map((r) => [
    fmtInt(r.i),
    r.local,
    r.type,
    r.role,
    r.tool,
    r.success,
    r.preview,
  ]);
  return table(['#', 'time', 'type', 'role', 'tool', 'ok', 'preview'], rows, [
    'right',
    'left',
    'left',
    'left',
    'left',
    'left',
    'left',
  ]);
}

/* ---------------------------------------------------------------- exports */

export function exportJson(stats, extra = {}) {
  return JSON.stringify({ ...stats, ...extra }, null, 2);
}

export function exportCsv(events) {
  const rows = toRows(events);
  return toCsv(
    ['index', 'timestamp', 'type', 'role', 'tool', 'chars', 'argsChars', 'success', 'preview'],
    rows.map((r) => [r.i, r.time, r.type, r.role, r.tool, r.chars, r.argsChars, r.success, r.preview])
  );
}

export function exportMarkdown(stats) {
  const c = stats.counts;
  const t = stats.timing;
  const lines = [];
  lines.push(`# Transcript report`);
  lines.push('');
  lines.push(`- **File**: \`${stats.file}\``);
  lines.push(`- **Session**: \`${stats.meta.sessionId ?? '-'}\``);
  lines.push(`- **Producer**: ${stats.meta.producer ?? '-'} (copilot ${stats.meta.copilotVersion ?? '?'})`);
  lines.push(
    `- **Window**: ${t.span.first ? `${localStamp(t.span.first)} → ${localStamp(t.span.last)}` : '-'} (${fmtDuration(t.span.ms)})`
  );
  lines.push('');
  lines.push(`## 1. Conversation statistics`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| human turns | ${c.humanTurns} |`);
  lines.push(`| assistant messages | ${c.assistantMessages} |`);
  lines.push(`| agent turn markers | ${c.agentSegments} |`);
  lines.push(`| tool calls (executed) | ${c.toolCalls} |`);
  lines.push(`| tool calls failed | ${c.toolFailures} |`);
  lines.push(`| tool calls requested | ${c.toolRequests} |`);
  lines.push(`| total events | ${c.events} |`);
  lines.push('');
  lines.push(`## 2. Effective development time`);
  lines.push('');
  lines.push(`Headline (cap ${capLabel(t.capMs)}): **${fmtDuration(t.active.ms)}** of ${fmtDuration(t.span.ms)} wall-clock.`);
  lines.push('');
  lines.push('| cap / gap | effective | idle | ratio |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of t.byCap) {
    lines.push(`| ${capLabel(r.capMs)} | ${fmtDuration(r.activeMs)} | ${fmtDuration(r.idleMs)} | ${fmtPct(r.ratio * 100, 100)} |`);
  }
  lines.push('');
  lines.push('## 3. Tool usage');
  lines.push('');
  lines.push('| tool | calls | failed | total runtime |');
  lines.push('| --- | --- | --- | --- |');
  for (const x of stats.tools) {
    lines.push(`| ${x.name} | ${x.calls} | ${x.failed} | ${x.timed ? fmtDuration(x.ms) : '-'} |`);
  }
  lines.push('');
  lines.push('## 4. Per-day activity');
  lines.push('');
  lines.push('| day | events | asks | tools | active |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of t.days) {
    lines.push(`| ${d.day} | ${d.events} | ${d.humanTurns} | ${d.toolCalls} | ${fmtDuration(d.activeMs)} |`);
  }
  return `${lines.join('\n')}\n`;
}

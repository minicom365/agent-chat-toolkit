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

/** Last path segment, for either separator, without importing node:path. */
function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

function h(st, title) {
  return `\n${st.bold(title)}\n${st.gray(SEP)}`;
}

function kv(st, rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, v]) => `${st.gray(k.padEnd(width))}  ${v}`)
    .join('\n');
}


/* ----------------------------------------------------------------- stats */

/** Antigravity does not name its session inside the log; the folder does. */
function sessionIdFromPath(file) {
  if (!file) return null;
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  const logsAt = parts.lastIndexOf('logs');
  const candidate = logsAt >= 2 ? parts[logsAt - 2] : null;
  return candidate && /^[0-9a-f-]{8,}$/i.test(candidate) ? candidate : null;
}

function producerLine(meta) {
  const parts = [];
  if (meta.producer) parts.push(meta.producer);
  if (meta.copilotVersion) parts.push(`copilot ${meta.copilotVersion}`);
  if (meta.vscodeVersion) parts.push(`vscode ${meta.vscodeVersion}`);
  return parts.length ? parts.join(' · ') : '-';
}

/**
 * Report how complete the merged logs are. Antigravity keeps a conversation in
 * several places and none of them is guaranteed complete, so a bare total is
 * misleading: "1,234 steps" says nothing about how many still have their text.
 */
export function coverageLines(coverage, st) {
  const { stepSpan, steps, textSteps, firstTextStep, headLostSteps, sources = [] } = coverage;
  const out = [];
  const kinds = sources.length
    ? sources.map((s) => s.kind).join(', ')
    : 'single file';
  out.push(
    kv(st, [
      ['logs merged', kinds],
      ['steps (merged)', stepSpan ? `${fmtInt(steps)} · step ${fmtInt(stepSpan.first)}…${fmtInt(stepSpan.last)}` : fmtInt(steps)],
      ['steps with text', `${fmtInt(textSteps)}${firstTextStep != null ? ` (from step ${fmtInt(firstTextStep)})` : ''}`],
    ])
  );
  if (headLostSteps > 0) {
    out.push(
      st.red(
        `  ⚠ the first ${fmtInt(headLostSteps)} step(s) are not in any readable log, and the store ` +
          'no longer holds them either: they are marked CORTEX_STEP_STATUS_CLEARED, which means the ' +
          'payload was deleted on disk. Use `agchat recover` for the rest of the conversation.'
      )
    );
  } else if (firstTextStep != null && stepSpan && firstTextStep > stepSpan.first) {
    out.push(
      st.yellow(
        `  ⚠ steps ${fmtInt(stepSpan.first)}…${fmtInt(firstTextStep - 1)} have no text in the log. ` +
          'Re-run with `agchat recover --session <id>` if the app still holds a live copy of them.'
      )
    );
  }
  return out;
}

export function renderStats(stats, { styler: st, warnings = [] }) {
  const c = stats.counts;
  const t = stats.timing;
  const out = [];

  out.push(h(st, 'Session'));
  out.push(
    kv(st, [
      ['file', stats.file],
      ['format', stats.format ?? '-'],
      ['size / lines', `${fmtBytes(stats.bytes)} / ${fmtInt(stats.totalLines)}`],
      ['session id', stats.meta.sessionId ?? sessionIdFromPath(stats.file) ?? '-'],
      ['producer', producerLine(stats.meta)],
      ['window', t.span.first ? `${localStamp(t.span.first)} → ${localStamp(t.span.last)}` : '-'],
      ['wall-clock span', fmtDuration(t.span.ms)],
    ])
  );
  if (stats.coverage) out.push(...coverageLines(stats.coverage, st));
  if (stats.parseErrors) {
    out.push(st.yellow(`  ${stats.parseErrors} unparsable line(s) skipped`));
  }

  out.push(h(st, '1. Conversation statistics'));
  out.push(
    kv(st, [
      ['human turns (user.message)', st.bold(fmtInt(c.humanTurns))],
      ['assistant messages', fmtInt(c.assistantMessages)],
      ['agent steps (turn markers)', fmtInt(c.agentSegments)],
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

/* --------------------------------------------------------------- catalog */

export function renderHosts(inventory, { styler: st }) {
  const { rows, sqlite } = inventory;
  const out = [h(st, 'Hosts')];
  out.push(
    table(
      ['host', 'format', 'sessions', 'with transcript', 'latest', 'size'],
      rows.map((r) => [
        r.host,
        r.format,
        fmtInt(r.sessionCount),
        fmtInt(r.withTranscript),
        r.latestMs ? localStamp(r.latestMs) : '-',
        fmtBytes(r.totalBytes),
      ]),
      ['left', 'left', 'right', 'right', 'left', 'right']
    )
  );
  out.push('');
  for (const r of rows) {
    out.push(st.gray(`  ${r.host} roots:`));
    for (const root of r.roots) out.push(st.gray(`    ${root}`));
  }
  if (!sqlite) {
    out.push('');
    out.push(
      st.yellow(
        '  node:sqlite is unavailable - conversation titles and index-backed operations are limited.'
      )
    );
  }
  return out.join('\n');
}

export function renderSessions(sessions, { styler: st, limit = 60, total = null }) {
  if (!sessions.length) return 'No conversations found.';
  const shown = sessions.slice(0, limit);
  const idxMark = (s) => (s.inIndex === true ? st.green('yes') : s.inIndex === false ? st.red('no') : st.gray('?'));
  // `head` flags how complete the readable content is. `locked` is the severe
  // case: the conversation is there, but only inside the encrypted `.pb` store,
  // which no key on the machine opens.
  const headMark = (s) => {
    if (s.locked) return st.red('lock');
    if (!s.transcriptPath) return st.gray('-');
    if (s.unrecoverableHeadSteps > 0) return st.red('lost');
    if (s.headLostSteps > 0) return st.yellow('skel');
    return s.hasOverview ? st.green('full') : st.gray('-');
  };
  const rows = shown.map((s, n) => [
    String(n + 1),
    s.host,
    s.instance ?? '',
    s.updatedMs ? localStamp(s.updatedMs) : '-',
    idxMark(s),
    s.storeKind ?? st.gray('-'),
    headMark(s),
    s.indexed === false ? st.yellow('orphan') : '',
    truncate(s.title ?? '', 40),
    truncate(s.project ?? '', 34),
    s.id.slice(0, 8),
    s.transcriptPath ? '' : st.gray('no-log'),
    fmtBytes(s.sizeBytes ?? 0),
  ]);
  const out = [
    h(
      st,
      `Conversations (${shown.length}${total != null && total > shown.length ? ` of ${total}` : ''})`
    ),
    '',
    table(
      ['#', 'host', 'instance', 'updated', 'idx', 'store', 'head', 'index', 'title', 'project', 'session', 'log', 'size'],
      rows,
      ['right', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'right']
    ),
    '',
    st.gray('  idx   = listed in the app own conversation index (yes/no/? = unknown)'),
    st.gray('  store = per-conversation store: pb (encrypted, older) | db (plaintext, newer) | -'),
    st.gray('  head  = readable content: full | skel (head is skeleton only) |'),
    st.gray('          lost (head missing from every log) | lock (only in the encrypted pb) | -'),
    st.gray('  log   = this tool found a readable transcript for it'),
    st.gray('  session id prefix works with `show`, `stats --session`, `move`.'),
  ];
  if (sessions.length > shown.length) {
    out.push(st.gray(`  … ${sessions.length - shown.length} more; raise --limit.`));
  }
  return out.join('\n');
}

export function renderSearchResults(results, { styler: st, level }) {
  if (!results.length) return 'No conversations matched.';
  const out = [];
  for (const r of results) {
    const s = r.session;
    out.push('');
    out.push(st.bold('─'.repeat(72)));
    out.push(`${st.bold('■')} ${st.cyan(s.host)}  ${st.bold(s.title ?? '(untitled)')}`);
    out.push(
      `  ${st.gray('id')} ${s.id}   ${st.gray('updated')} ${s.updatedMs ? localStamp(s.updatedMs) : '-'}`
    );
    if (s.project) out.push(`  ${st.gray('project')} ${s.project}`);
    if (s.transcriptPath) out.push(`  ${st.gray('log')} ${s.transcriptPath}`);
    if (s.host === 'antigravity' && s.transcriptVariant) {
      out.push(`  ${st.gray('variant')} transcript_${s.transcriptVariant === 'full' ? 'full' : ''}.jsonl`);
    }
    if (r.parseError) out.push(`  ${st.red(`parse error: ${r.parseError}`)}`);
    if (r.matchedCount) out.push(`  ${st.gray(`matches: ${r.matchedCount} at level ${level}`)}`);
    if (r.artifactHit) {
      out.push(`  ${st.gray('artifact name matched:')}`);
      for (const a of [...r.artifacts, ...r.scratch]) out.push(`    ${st.gray('-')} ${a}`);
    }
    if (!r.entries.length) {
      out.push(st.gray('  (no content at this level)'));
      continue;
    }
    out.push('');
    for (const e of r.entries) {
      const mark = e.matched ? '⭐' : '  ';
      const who = e.kind === 'user' ? '👤 User' : e.kind === 'assistant' ? '🤖 Agent' : `⚙ ${e.label}`;
      out.push(`${mark} ${st.bold(who)}`);
      for (const line of String(e.text).split('\n')) out.push(`   ${line}`);
    }
    if (r.truncated) {
      out.push(st.gray(`  … context trimmed (${r.totalEntries} entries at this level; use --level 4)`));
    }
  }
  return out.join('\n');
}

export function renderMovePlan(plan, { styler: st, session, target }) {
  const out = [h(st, plan.apply ? 'Conversation migration (applied)' : 'Conversation migration (dry run)')];
  out.push(
    kv(st, [
      ['session', `${session.id}\n             ${session.title ?? ''}`],
      ['from', session.storageDir ?? '-'],
      ['to', target],
      ['mode', plan.apply ? st.red('APPLY (files written)') : st.green('dry-run (nothing written)')],
    ])
  );
  out.push('');
  if (!plan.copies.length && !plan.indexMerges.length) {
    out.push(st.gray('  Nothing to do: the target already has this conversation.'));
  }
  if (plan.copies.length) {
    out.push(st.bold('  Files'));
    out.push(
      table(
        ['file', 'bytes'],
        plan.copies.map((c) => [c.dst, fmtInt(c.bytes)]),
        ['left', 'right']
      )
    );
  }
  if (plan.indexMerges.length) {
    out.push('');
    out.push(st.bold('  Index entries'));
    for (const m of plan.indexMerges) out.push(`    + ${m.sessionId}  ${m.title}`);
  }
  if (plan.backups?.length) {
    out.push('');
    out.push(st.bold('  Backups'));
    for (const b of plan.backups) out.push(`    ${b}`);
  }
  if (plan.warnings?.length) {
    out.push('');
    for (const w of plan.warnings) out.push(st.yellow(`  ! ${w}`));
  }
  if (!plan.apply) {
    out.push('');
    out.push(st.gray('  Re-run with --apply to write. A timestamped backup of state.vscdb is taken first.'));
  }
  return out.join('\n');
}

/* --------------------------------------------------------------- orphans */

/**
 * Workspace storages whose workspace is gone but whose conversations are not.
 * These cannot be reached from the editor any more, so the report is about what
 * is stranded and how much of it there is.
 */
export function renderOrphans(orphans, { styler: st, totalStorages = 0 }) {
  const out = [h(st, 'Orphaned workspace storages')];
  if (!orphans.length) {
    out.push(st.green('  No storage holds conversations for a workspace that no longer exists.'));
    return out.join('\n');
  }
  const bytes = orphans.reduce((n, o) => n + o.bytes, 0);
  const sessions = orphans.reduce((n, o) => n + o.sessions, 0);
  out.push(
    kv(st, [
      ['storages', `${orphans.length} of ${totalStorages} hold conversations but have no workspace`],
      ['conversations', fmtInt(sessions)],
      ['on disk', fmtBytes(bytes)],
    ])
  );
  out.push('');
  out.push(
    table(
      ['storage', 'conversations', 'size', 'last activity', 'workspace'],
      orphans.map((o) => [
        o.hash,
        fmtInt(o.sessions),
        fmtBytes(o.bytes),
        o.newestMs ? new Date(o.newestMs).toISOString().slice(0, 16).replace('T', ' ') : '-',
        o.project ?? st.yellow('(no workspace.json)'),
      ]),
      ['left', 'right', 'right', 'left', 'left']
    )
  );
  out.push('');
  out.push(
    st.gray(
      '  Each is reachable again with:\n' +
        '    agchat move --session <id> --data-dir <user-data root> --to <live storage hash> --apply\n' +
        '  List the stranded conversations with:  agchat sessions --orphans-only'
    )
  );
  return out.join('\n');
}

/* -------------------------------------------------------------- migration */

export function renderMigrationPlan(plan, { styler: st, apply }) {
  const out = [h(st, apply ? 'Antigravity migration (applied)' : 'Antigravity migration (dry run)')];
  out.push(
    kv(st, [
      ['conversation', plan.id],
      ['from', plan.fromInstance],
      ['to', plan.toInstance],
      ['mode', apply ? st.red('APPLY (files written)') : st.green('dry-run (nothing written)')],
    ])
  );
  out.push('');
  if (plan.copies.length) {
    out.push(st.bold('  Store files'));
    out.push(
      table(
        ['file', 'action', 'bytes'],
        plan.copies.map((c) => [
          baseName(c.dst),
          c.action === 'identical' ? st.gray('already present') : st.green(c.action),
          fmtInt(c.bytes),
        ]),
        ['left', 'left', 'right']
      )
    );
    for (const c of plan.copies) out.push(st.gray(`      ${c.dst}`));
  } else {
    out.push(st.gray('  No store files to copy.'));
  }

  const reg = plan.registration;
  if (reg) {
    out.push('');
    out.push(st.bold('  Registry row (conversation_summaries)'));
    out.push(
      kv(st, [
        ['action', reg.action === 'insert' ? st.green('insert') : reg.action === 'update' ? st.yellow('update') : st.gray('unchanged')],
        ['app_data_dir', reg.row.app_data_dir],
        ['workspace_uris', reg.row.workspace_uris],
        ['project_id', reg.row.project_id || st.gray('(unassigned)')],
        ['step_count', String(reg.row.step_count)],
      ])
    );
    if (reg.action === 'update') out.push(st.gray(`      changed: ${reg.changed.join(', ')}`));
  }

  if (plan.applied) {
    out.push('');
    out.push(st.bold('  Written'));
    for (const f of plan.applied.copied) out.push(`    + ${f}`);
    if (plan.applied.registered) out.push('    + registry row upserted');
    for (const b of plan.applied.backups) out.push(`    backup ${b}`);
  }

  if (plan.warnings?.length) {
    out.push('');
    for (const w of plan.warnings) out.push(st.yellow(`  ! ${w}`));
  }
  if (!apply) {
    out.push('');
    out.push(
      st.gray(
        '  Re-run with --apply to write. Close Antigravity first; the registry is backed up before the row is written.'
      )
    );
  }
  return out.join('\n');
}

/* --------------------------------------------------------------- salvage */

/**
 * What was found in the space SQLite released, and a preview of it.
 * The full text belongs in a file, not in a terminal.
 */
export function renderSalvage(result, { styler: st, preview = 12, out = null }) {
  const outLines = [h(st, 'Salvaged text (plaintext store)')];
  outLines.push(
    kv(st, [
      ['store', result.file],
      ['file', `${fmtBytes(result.fileBytes)} · ${fmtInt(result.pageCount)} pages`],
      ['released', `${fmtBytes(result.slackBytes)} slack + ${fmtBytes(result.freeBytes)} freelist (${fmtInt(result.freePages)} pages)`],
      ['scanned', fmtBytes(result.deadBytes)],
      ['runs found', `${fmtInt(result.runs)} · kept ${fmtInt(result.lost)}`],
      ['recovered', `${fmtBytes(result.lostChars)} of text`],
    ])
  );
  if (!result.lost) {
    outLines.push('');
    outLines.push(st.gray('  Nothing readable in the released space that the store does not already serve.'));
    return outLines.join('\n');
  }
  outLines.push('');
  outLines.push(st.bold(`  Preview (first ${Math.min(preview, result.lost)} of ${fmtInt(result.lost)})`));
  for (const t of result.text.slice(0, preview)) {
    outLines.push('');
    outLines.push(st.gray('  ───'));
    outLines.push(
      t
        .split('\n')
        .slice(0, 4)
        .map((l) => `  ${l.slice(0, 150)}`)
        .join('\n')
    );
  }
  outLines.push('');
  outLines.push(
    out
      ? st.green(`  Full text written to ${out}`)
      : st.gray('  Pass --out <file> to write the recovered text.')
  );
  return outLines.join('\n');
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

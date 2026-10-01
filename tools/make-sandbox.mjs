#!/usr/bin/env node
/**
 * Generate a disposable, fully synthetic user-data tree for both hosts.
 *
 * Everything written here is invented: no real path, prompt or identifier is
 * used. Point the tool at the result with
 *   VSCODE_USER_DIR=<out>/Code/User  GEMINI_DIR=<out>/.gemini
 * and every read/write lands in the sandbox instead of a live profile.
 *
 * Usage: node tools/make-sandbox.mjs --out <dir> [--force]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { writeIndex, writeItem, sqliteAvailable } from '../src/sqlite.js';
import { SIDEBAR_KEY } from '../src/hosts/antigravity-index.js';
import { buildSidebarIndex } from './sandbox-protobuf.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = sqliteAvailable() ? require('node:sqlite') : {};

const T0 = Date.parse('2026-01-05T09:00:00Z');
const MIN = 60_000;

const SESSIONS = {
  alpha: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Sandbox alpha conversation',
    workspace: 'file:///home/sandbox/projects/alpha',
  },
  orphan: {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Sandbox orphan conversation',
    workspace: 'file:///home/sandbox/projects/alpha',
  },
};

const ANTIGRAVITY = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Sandbox antigravity conversation',
  workspace: 'file:///home/sandbox/projects/beta',
};

/** Same instance, but absent from the sidebar index (the "lost" case). */
const AG_LEGACY = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Sandbox legacy conversation',
  workspace: 'file:///home/sandbox/projects/beta',
};

/** A second instance (`antigravity-ide`) with its own app profile. */
const AG_IDE = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Sandbox IDE conversation',
  workspace: 'file:///home/sandbox/projects/gamma',
};

/** A third instance that is a snapshot: no app profile indexes it. */
const AG_BACKUP = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Sandbox backup conversation',
  workspace: 'file:///home/sandbox/projects/delta',
};

const STORAGE_A = 'aaaaaaaa11111111';
const STORAGE_B = 'bbbbbbbb22222222';

function vscodeLine(type, at, data, i) {
  return `${JSON.stringify({
    type,
    data,
    id: `evt-${i}`,
    timestamp: new Date(at).toISOString(),
    parentId: null,
  })}\n`;
}

/** A VS Code agent transcript: two asks, a long break, one failing tool call. */
export function vscodeTranscript({ id, ask1, ask2 }) {
  const t = (min) => T0 + min * MIN;
  const lines = [];
  let i = 0;
  lines.push(
    vscodeLine(
      'session.start',
      t(0),
      {
        sessionId: id,
        version: 1,
        producer: 'copilot-agent',
        copilotVersion: '0.0.0-sandbox',
        vscodeVersion: '0.0.0-sandbox',
        startTime: new Date(t(0)).toISOString(),
      },
      i++
    )
  );
  lines.push(vscodeLine('assistant.turn_start', t(0), { turnId: '1' }, i++));
  lines.push(
    vscodeLine(
      'assistant.message',
      t(0),
      { messageId: 'm1', content: 'Starting the first task.', toolRequests: [], reasoningText: 'planning' },
      i++
    )
  );
  lines.push(vscodeLine('assistant.turn_end', t(0), { turnId: '1' }, i++));

  lines.push(
    vscodeLine('user.message', t(5), { content: ask1, attachments: [] }, i++)
  );
  lines.push(vscodeLine('assistant.turn_start', t(5), { turnId: '2' }, i++));
  lines.push(
    vscodeLine(
      'assistant.message',
      t(5),
      {
        messageId: 'm2',
        content: 'Reading the file now.',
        toolRequests: [
          { toolCallId: 'c1', name: 'read_file', type: 'function' },
          { toolCallId: 'c2', name: 'run_in_terminal', type: 'function' },
        ],
      },
      i++
    )
  );
  lines.push(vscodeLine('tool.execution_start', t(6), { toolCallId: 'c1', toolName: 'read_file', arguments: { filePath: '/sandbox/a.txt' } }, i++));
  lines.push(vscodeLine('tool.execution_complete', t(6) + 4000, { toolCallId: 'c1', success: true }, i++));
  lines.push(vscodeLine('tool.execution_start', t(7), { toolCallId: 'c2', toolName: 'run_in_terminal', arguments: { command: 'echo sandbox' } }, i++));
  lines.push(vscodeLine('tool.execution_complete', t(7) + 30000, { toolCallId: 'c2', success: false }, i++));
  lines.push(vscodeLine('assistant.turn_end', t(10), { turnId: '2' }, i++));

  // a real break of two hours
  lines.push(vscodeLine('user.message', t(130), { content: ask2, attachments: [] }, i++));
  lines.push(vscodeLine('assistant.turn_start', t(130), { turnId: '3' }, i++));
  lines.push(
    vscodeLine('assistant.message', t(130), { messageId: 'm3', content: 'Second task done.', toolRequests: [] }, i++)
  );
  lines.push(vscodeLine('assistant.turn_end', t(131), { turnId: '3' }, i++));
  return lines.join('');
}

/** A VS Code chat-state patch log (the file the history panel reads). */
export function chatSessionFile({ id, title }) {
  const header = {
    kind: 0,
    v: {
      version: 3,
      creationDate: T0,
      initialLocation: 'panel',
      responderUsername: 'Agent',
      sessionId: id,
      customTitle: title,
      hasPendingEdits: false,
      requests: [],
      pendingRequests: [],
      inputState: { attachments: [], mode: { id: 'agent', kind: 'agent' } },
    },
  };
  const response = {
    kind: 1,
    k: ['requests', 0],
    v: { requestId: 'req-1', timestamp: T0 + 130 * MIN, response: [] },
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(response)}\n`;
}

function antigravityLine(step, source, type, at, extra) {
  return `${JSON.stringify({
    step_index: step,
    source,
    type,
    status: 'DONE',
    created_at: new Date(at).toISOString(),
    ...extra,
  })}\n`;
}

/** An Antigravity step log: request, plan with tool calls, results, final answer. */
export function antigravityTranscript({ id, ask, final }) {
  const t = (min) => T0 + min * MIN;
  const lines = [];
  lines.push(
    antigravityLine(0, 'USER_EXPLICIT', 'USER_INPUT', t(0), {
      content: `<USER_REQUEST>\n${ask}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-01-05T18:00:00+09:00.\n</ADDITIONAL_METADATA>`,
    })
  );
  lines.push(
    antigravityLine(1, 'MODEL', 'PLANNER_RESPONSE', t(0), {
      thinking: 'Deciding which tool to use first.',
      content: 'Let me look at the directory first.',
      tool_calls: [
        { name: 'list_dir', args: { DirectoryPath: '"/sandbox"', toolAction: '"Listing"', toolSummary: '"List sandbox"' } },
      ],
    })
  );
  lines.push(
    antigravityLine(2, 'MODEL', 'GENERIC', t(0) + 1500, {
      content: 'Created At: 2026-01-05T18:00:01+09:00\nCompleted At: 2026-01-05T18:00:02+09:00\n\nOutput:\na.txt\nb.txt\n',
    })
  );
  lines.push(
    antigravityLine(3, 'MODEL', 'PLANNER_RESPONSE', t(1), {
      thinking: 'Now run the command.',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"echo sandbox"', Cwd: '"C:\\\\sandbox"', toolAction: '"Running"', toolSummary: '"Echo"' } },
      ],
    })
  );
  lines.push(
    antigravityLine(4, 'MODEL', 'RUN_COMMAND', t(1) + 20000, {
      content: 'The command exited with code 0.\nOutput:\nsandbox\n',
      exit_code: 0,
    })
  );
  lines.push(
    antigravityLine(5, 'MODEL', 'PLANNER_RESPONSE', t(3), {
      thinking: 'Summarising for the user.',
      content: final,
      tool_calls: [],
    })
  );
  lines.push(antigravityLine(6, 'SYSTEM', 'SYSTEM_MESSAGE', t(4), { content: '<SYSTEM_MESSAGE>noop</SYSTEM_MESSAGE>' }));
  return lines.join('');
}

function antigravitySummaryDb(file, rows) {
  if (!sqliteAvailable()) return false;
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        last_user_input_time DATETIME,
        app_data_dir TEXT NOT NULL DEFAULT ''
      );
    `);
    const stmt = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,app_data_dir,last_user_input_time,nesting_depth) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    for (const r of rows) stmt.run(...r);
  } finally {
    db.close();
  }
  return true;
}

/** Create (or refresh) the sandbox tree and return its root. */
export async function makeSandbox(outDir, { force = false } = {}) {
  const root = path.resolve(outDir);
  if (fs.existsSync(root)) {
    if (!force) throw new Error(`${root} already exists (pass --force to recreate)`);
    await fsp.rm(root, { recursive: true, force: true });
  }

  const userDir = path.join(root, 'Code', 'User');
  const storeA = path.join(userDir, 'workspaceStorage', STORAGE_A);
  const storeB = path.join(userDir, 'workspaceStorage', STORAGE_B);
  const agDir = path.join(root, '.gemini', 'antigravity');

  await fsp.mkdir(path.join(storeA, 'chatSessions'), { recursive: true });
  await fsp.mkdir(path.join(storeA, 'GitHub.copilot-chat', 'transcripts'), { recursive: true });
  await fsp.mkdir(path.join(storeB, 'chatSessions'), { recursive: true });
  await fsp.mkdir(path.join(storeB, 'GitHub.copilot-chat', 'transcripts'), { recursive: true });
  await fsp.mkdir(path.join(agDir, 'brain', ANTIGRAVITY.id, '.system_generated', 'logs'), { recursive: true });
  await fsp.mkdir(path.join(agDir, 'brain', ANTIGRAVITY.id, 'scratch'), { recursive: true });
  await fsp.mkdir(path.join(agDir, 'annotations'), { recursive: true });

  await fsp.writeFile(
    path.join(storeA, 'workspace.json'),
    JSON.stringify({ folder: SESSIONS.alpha.workspace }, null, 2)
  );
  await fsp.writeFile(
    path.join(storeB, 'workspace.json'),
    JSON.stringify({ folder: 'file:///home/sandbox/projects/beta' }, null, 2)
  );

  await fsp.writeFile(
    path.join(storeA, 'chatSessions', `${SESSIONS.alpha.id}.jsonl`),
    chatSessionFile({ id: SESSIONS.alpha.id, title: SESSIONS.alpha.title })
  );
  await fsp.writeFile(
    path.join(storeA, 'GitHub.copilot-chat', 'transcripts', `${SESSIONS.alpha.id}.jsonl`),
    vscodeTranscript({
      id: SESSIONS.alpha.id,
      ask1: 'Please inspect the sandbox configuration files.',
      ask2: 'Now summarise what you found in two sentences.',
    })
  );
  // an orphan: file present, index entry missing (the recovery use case)
  await fsp.writeFile(
    path.join(storeA, 'GitHub.copilot-chat', 'transcripts', `${SESSIONS.orphan.id}.jsonl`),
    vscodeTranscript({
      id: SESSIONS.orphan.id,
      ask1: 'This conversation was never indexed.',
      ask2: 'Show that orphan detection works.',
    })
  );

  if (sqliteAvailable()) {
    for (const [store, entries] of [
      [
        storeA,
        {
          [SESSIONS.alpha.id]: {
            sessionId: SESSIONS.alpha.id,
            title: SESSIONS.alpha.title,
            lastMessageDate: T0 + 131 * MIN,
            timing: { created: T0, lastRequestStarted: T0 + 130 * MIN, lastRequestEnded: T0 + 131 * MIN },
            initialLocation: 'panel',
            hasPendingEdits: false,
            isEmpty: false,
            isExternal: false,
            lastResponseState: 1,
            permissionLevel: 'default',
          },
        },
      ],
      [storeB, {}],
    ]) {
      const dbFile = path.join(store, 'state.vscdb');
      const db = new DatabaseSync(dbFile);
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.close();
      writeIndex(dbFile, { version: 1, entries });
    }
  }

  await fsp.writeFile(
    path.join(agDir, 'brain', ANTIGRAVITY.id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    antigravityTranscript({
      id: ANTIGRAVITY.id,
      ask: 'List the sandbox directory and run the echo command.',
      final: 'I listed `/sandbox` and executed `echo sandbox`, which printed `sandbox`.',
    })
  );
  await fsp.writeFile(
    path.join(agDir, 'brain', ANTIGRAVITY.id, '.system_generated', 'logs', 'transcript.jsonl'),
    antigravityTranscript({
      id: ANTIGRAVITY.id,
      ask: 'List the sandbox directory and run the echo command.',
      final: 'I listed `/sandbox` and executed `echo sandbox`, which printed `sandbox`.',
    })
  );
  await fsp.writeFile(path.join(agDir, 'brain', ANTIGRAVITY.id, 'notes.md'), '# Sandbox notes\n');
  await fsp.writeFile(path.join(agDir, 'brain', ANTIGRAVITY.id, 'scratch', 'helper.py'), 'print("sandbox")\n');
  await fsp.writeFile(
    path.join(agDir, 'annotations', `${ANTIGRAVITY.id}.pbtxt`),
    `title:"${ANTIGRAVITY.title}" last_user_view_time:{seconds:1767600000}\n`
  );

  // --- second conversation in the same instance, missing from the sidebar index ---
  await fsp.mkdir(path.join(agDir, 'brain', AG_LEGACY.id, '.system_generated', 'logs'), { recursive: true });
  await fsp.mkdir(path.join(agDir, 'conversations'), { recursive: true });
  await fsp.writeFile(
    path.join(agDir, 'brain', AG_LEGACY.id, '.system_generated', 'logs', 'transcript.jsonl'),
    antigravityTranscript({
      id: AG_LEGACY.id,
      ask: 'This conversation is not in the sidebar index.',
      final: 'Its content is still on disk and readable.',
    })
  );
  // legacy per-conversation store (`.db`), the state that correlates with the loss
  await fsp.writeFile(path.join(agDir, 'conversations', `${AG_LEGACY.id}.db`), 'sandbox-legacy-store\n');
  await fsp.writeFile(path.join(agDir, 'conversations', `${ANTIGRAVITY.id}.pb`), 'sandbox-current-store\n');

  const wroteDb = antigravitySummaryDb(path.join(agDir, 'conversation_summaries.db'), [
    [
      ANTIGRAVITY.id,
      ANTIGRAVITY.title,
      'List the sandbox directory and run the echo command.',
      7,
      '2026-01-05 09:04:00.0000000+00:00',
      JSON.stringify([ANTIGRAVITY.workspace]),
      'CASCADE_RUN_STATUS_IDLE',
      'antigravity',
      '2026-01-05 09:00:00.0000000+00:00',
      0,
    ],
    [
      AG_LEGACY.id,
      AG_LEGACY.title,
      'This conversation is not in the sidebar index.',
      9,
      '2026-01-04 09:04:00.0000000+00:00',
      JSON.stringify([AG_LEGACY.workspace]),
      'CASCADE_RUN_STATUS_IDLE',
      'antigravity',
      '2026-01-04 09:00:00.0000000+00:00',
      0,
    ],
  ]);

  // --- second instance: the IDE build, with its own app profile ---
  const agIdeDir = path.join(root, '.gemini', 'antigravity-ide');
  await fsp.mkdir(path.join(agIdeDir, 'brain', AG_IDE.id, '.system_generated', 'logs'), { recursive: true });
  await fsp.mkdir(path.join(agIdeDir, 'conversations'), { recursive: true });
  await fsp.writeFile(
    path.join(agIdeDir, 'brain', AG_IDE.id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    antigravityTranscript({
      id: AG_IDE.id,
      ask: 'The IDE build keeps its own conversations.',
      final: 'Read from the antigravity-ide instance.',
    })
  );
  await fsp.writeFile(path.join(agIdeDir, 'conversations', `${AG_IDE.id}.pb`), 'sandbox-ide-store\n');
  antigravitySummaryDb(path.join(agIdeDir, 'conversation_summaries.db'), [
    [
      AG_IDE.id,
      AG_IDE.title,
      'The IDE build keeps its own conversations.',
      4,
      '2026-01-03 09:04:00.0000000+00:00',
      JSON.stringify([AG_IDE.workspace]),
      'CASCADE_RUN_STATUS_IDLE',
      'antigravity-ide',
      '2026-01-03 09:00:00.0000000+00:00',
      0,
    ],
  ]);

  // --- third instance: a snapshot no live app profile indexes ---
  const agBackupDir = path.join(root, '.gemini', 'antigravity-backup');
  await fsp.mkdir(path.join(agBackupDir, 'brain', AG_BACKUP.id, '.system_generated', 'logs'), { recursive: true });
  await fsp.mkdir(path.join(agBackupDir, 'conversations'), { recursive: true });
  await fsp.writeFile(
    path.join(agBackupDir, 'brain', AG_BACKUP.id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    antigravityTranscript({
      id: AG_BACKUP.id,
      ask: 'This instance is a snapshot of an older profile.',
      final: 'No live app profile lists it.',
    })
  );
  await fsp.writeFile(path.join(agBackupDir, 'conversations', `${AG_BACKUP.id}.pb`), 'sandbox-backup-store\n');

  // --- app profiles: the state that decides what the sidebar shows ---
  const profileRoot = path.join(root, 'profiles');
  const profiles = [
    { product: 'Antigravity', ids: [ANTIGRAVITY.id] },
    { product: 'Antigravity IDE', ids: [AG_IDE.id] },
  ];
  if (sqliteAvailable()) {
    for (const p of profiles) {
      const dbFile = path.join(profileRoot, p.product, 'User', 'globalStorage', 'state.vscdb');
      await fsp.mkdir(path.dirname(dbFile), { recursive: true });
      const db = new DatabaseSync(dbFile);
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.close();
      const payload = buildSidebarIndex(
        p.ids.map((id, n) => {
          const meta = [ANTIGRAVITY, AG_LEGACY, AG_IDE, AG_BACKUP].find((x) => x.id === id) ?? {};
          return {
            id,
            title: meta.title,
            steps: 7 + n,
            createdMs: T0,
            updatedMs: T0 + (10 + n) * MIN,
            workspaceUris: [meta.workspace].filter(Boolean),
          };
        })
      );
      writeItem(dbFile, SIDEBAR_KEY, payload);
    }
  }

  return {
    root,
    userDir,
    storeA,
    storeB,
    agDir,
    agIdeDir,
    agBackupDir,
    profileRoot,
    storageA: STORAGE_A,
    storageB: STORAGE_B,
    sessionAlpha: SESSIONS.alpha.id,
    sessionOrphan: SESSIONS.orphan.id,
    sessionAntigravity: ANTIGRAVITY.id,
    sessionAgLegacy: AG_LEGACY.id,
    sessionAgIde: AG_IDE.id,
    sessionAgBackup: AG_BACKUP.id,
    sqlite: sqliteAvailable(),
    antigravityCatalog: wroteDb,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('make-sandbox.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(process.cwd(), '.sandbox');
  if (!out) {
    process.stderr.write('usage: node tools/make-sandbox.mjs --out <dir> [--force]\n');
    process.exit(2);
  }
  const info = await makeSandbox(out, { force: args.includes('--force') });
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  if (!info.sqlite) {
    process.stderr.write('warning: node:sqlite unavailable - state.vscdb fixtures were skipped\n');
  }
}

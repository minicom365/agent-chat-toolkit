import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countSteps, defaultLsBinary, LS_ENDPOINT, LS_LIST_ENDPOINT } from '../src/hosts/antigravity-recover.js';

test('countSteps counts trajectory step markers without parsing JSON', () => {
  const text = `{"steps":[{"type":"CORTEX_STEP_TYPE_USER_INPUT"},{"type":"CORTEX_STEP_TYPE_PLANNER_RESPONSE"},{"type":"CORTEX_STEP_TYPE_TASK_BOUNDARY"}]}`;
  assert.equal(countSteps(text), 3);
  assert.equal(countSteps('{}'), 0);
  assert.equal(countSteps(''), 0);
});

test('countSteps counts every marker, not distinct types', () => {
  const text = '{"type":"CORTEX_STEP_TYPE_A"}{"type":"CORTEX_STEP_TYPE_A"}{"type":"CORTEX_STEP_TYPE_A"}';
  assert.equal(countSteps(text), 3);
});

test('the endpoint is the language server trajectory RPC', () => {
  assert.ok(LS_ENDPOINT.endsWith('/GetCascadeTrajectory'));
  assert.ok(LS_LIST_ENDPOINT.endsWith('/GetAllCascadeTrajectories'));
});

test('defaultLsBinary never returns a nonexistent ANTIGRAVITY_LS_PATH', async () => {
  const prev = process.env.ANTIGRAVITY_LS_PATH;
  try {
    process.env.ANTIGRAVITY_LS_PATH = '/nonexistent/does/not/exist/language_server';
    const result = defaultLsBinary();
    // A missing path must not be returned; a real install may still be
    // auto-discovered, so the only safe assertion is that the bad path is not it.
    assert.notEqual(result, '/nonexistent/does/not/exist/language_server');
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_LS_PATH;
    else process.env.ANTIGRAVITY_LS_PATH = prev;
  }
});

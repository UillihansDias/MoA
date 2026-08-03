import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getAvailablePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitFor = async (probe, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(40);
  }
  throw lastError || new Error('Timed out waiting for correction approval state.');
};

const stopServer = async (server) => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(2_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
};

const createFixture = async (scenario) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-correction-approval-'));
  const runsDir = path.join(temporary, 'runs');
  const runName = `approval_${scenario}`;
  const runDir = path.join(runsDir, runName);
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const mockState = path.join(temporary, 'mock-state.json');
  await Promise.all([mkdir(runDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(runDir, 'task.txt'), 'Implement the requested behavior.\n'),
    writeFile(path.join(runDir, 'workspace.txt'), `${workspace}\n`),
    writeFile(path.join(runDir, 'judge.md'), 'Implement only the requested behavior.\n'),
    writeFile(path.join(runDir, 'investigation-brief.md'), 'The requested behavior must be independently verified.\n'),
    writeFile(path.join(runDir, 'evidence.md'), 'The change is bounded and safe.\n'),
    writeFile(path.join(runDir, 'run.json'), `${JSON.stringify({ schemaVersion: 1, state: 'awaiting_execution', stages: {} }, null, 2)}\n`),
    writeFile(mockState, `${JSON.stringify({ calls: [], verifierCount: 0 }, null, 2)}\n`),
  ]);
  await writeFile(mockCodex, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const prompt = args.at(-1);
const state = JSON.parse(await readFile(process.env.MOA_TEST_STATE, 'utf8'));
let kind;
let report;
if (prompt.includes('corrective Execute pass')) {
  kind = 'correction';
  report = 'EXECUTION_COMPLETED\\nApplied only the approved corrective scope.\\n';
} else if (prompt.includes('independent Verify stage')) {
  kind = 'verify';
  state.verifierCount += 1;
  if (process.env.MOA_TEST_SCENARIO === 'success' || state.verifierCount > 1) {
    report = 'VERIFICATION_PASSED\\nStructured iteration feedback: None.\\n';
  } else if (process.env.MOA_TEST_SCENARIO === 'nonactionable') {
    report = 'VERIFICATION_FAILED\\nCorrection actionable: no\\nVerifier summary: A required external credential is unavailable.\\nActionable findings:\\n- None\\nProposed correction scope: None\\nAffected files or areas:\\n- Unknown\\nJudge re-evaluation may be required: no\\nStructured iteration feedback: Cannot proceed without a credential.\\n';
  } else {
    report = 'VERIFICATION_FAILED\\nCorrection actionable: yes\\nVerifier summary: One bounded behavior is missing.\\nActionable findings:\\n- The expected result is absent.\\nProposed correction scope: Add only the missing result handling.\\nAffected files or areas:\\n- src/result.mjs\\nJudge re-evaluation may be required: no\\nStructured iteration feedback: Add the result handling and rerun its focused check.\\n';
  }
} else if (prompt.includes('You own only the Execute stage')) {
  kind = 'execute';
  report = 'EXECUTION_COMPLETED\\nApplied the approved plan.\\n';
} else {
  throw new Error('Unexpected prompt: ' + prompt.slice(0, 80));
}
state.calls.push(kind);
await writeFile(process.env.MOA_TEST_STATE, JSON.stringify(state, null, 2));
await writeFile(output, report);
`);
  await chmod(mockCodex, 0o755);
  return { temporary, runsDir, runName, runDir, mockCodex, mockState, scenario };
};

const startFixtureServer = async (fixture) => {
  const port = await getAvailablePort();
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOA_PORT: String(port),
      MOA_RUNS_DIR: fixture.runsDir,
      MOA_CODEX_BIN: fixture.mockCodex,
      MOA_TEST_STATE: fixture.mockState,
      MOA_TEST_SCENARIO: fixture.scenario,
      MOA_EXECUTION_IDLE_TIMEOUT_MS: '5000',
      MOA_EXECUTION_MAX_RUNTIME_MS: '20000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  return { server, port };
};

const beginExecution = async (fixture, port) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runName: fixture.runName }),
  });
  assert.equal(response.status, 202);
};

const readStatus = (fixture) => readFile(path.join(fixture.runDir, 'execution.status.json'), 'utf8').then(JSON.parse);
const readCalls = (fixture) => readFile(fixture.mockState, 'utf8').then(JSON.parse).then(({ calls }) => calls);

test('successful verification bypasses correction approval unchanged', { timeout: 20_000 }, async () => {
  const fixture = await createFixture('success');
  let server;
  try {
    const started = await startFixtureServer(fixture);
    ({ server } = started);
    await beginExecution(fixture, started.port);
    const status = await waitFor(async () => {
      const value = await readStatus(fixture);
      return value.state === 'completed' ? value : null;
    });
    assert.equal(status.reason, 'completed');
    assert.equal(status.correctionAttempts, 0);
    assert.deepEqual(await readCalls(fixture), ['execute', 'verify']);
  } finally {
    await stopServer(server);
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('non-actionable verification failure stops without a corrective Executor', { timeout: 20_000 }, async () => {
  const fixture = await createFixture('nonactionable');
  let server;
  try {
    const started = await startFixtureServer(fixture);
    ({ server } = started);
    await beginExecution(fixture, started.port);
    const status = await waitFor(async () => {
      const value = await readStatus(fixture);
      return value.state === 'failed' ? value : null;
    });
    assert.equal(status.reason, 'verification_failed');
    assert.equal(status.correctionAttempts, 0);
    assert.deepEqual(await readCalls(fixture), ['execute', 'verify']);
  } finally {
    await stopServer(server);
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('actionable failure restores after service restart and approval runs correction then fresh Verify', { timeout: 30_000 }, async () => {
  const fixture = await createFixture('actionable');
  let server;
  try {
    let started = await startFixtureServer(fixture);
    ({ server } = started);
    await beginExecution(fixture, started.port);
    const paused = await waitFor(async () => {
      const value = await readStatus(fixture);
      return value.state === 'awaiting_correction_approval' ? value : null;
    });
    assert.deepEqual(await readCalls(fixture), ['execute', 'verify']);
    assert.equal(paused.correctionApproval.proposedCorrectionScope, 'Add only the missing result handling.');

    await stopServer(server);
    started = await startFixtureServer(fixture);
    ({ server } = started);
    const overview = await (await fetch(`http://127.0.0.1:${started.port}/api/status`)).json();
    const restored = overview.executions.find(({ id }) => id === paused.id);
    assert.equal(restored.state, 'awaiting_correction_approval');
    assert.equal(restored.correctionApproval.decisionId, paused.correctionApproval.decisionId);

    const approved = await fetch(`http://127.0.0.1:${started.port}/api/runs/${fixture.runName}/correction/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: paused.correctionApproval.decisionId }),
    });
    assert.equal(approved.status, 202);
    const duplicate = await fetch(`http://127.0.0.1:${started.port}/api/runs/${fixture.runName}/correction/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: paused.correctionApproval.decisionId }),
    });
    assert.equal(duplicate.status, 409);

    const completed = await waitFor(async () => {
      const value = await readStatus(fixture);
      return value.state === 'completed' ? value : null;
    });
    assert.equal(completed.correctionAttempts, 1);
    assert.deepEqual(await readCalls(fixture), ['execute', 'verify', 'correction', 'verify']);
    const decision = JSON.parse(await readFile(path.join(fixture.runDir, 'correction-approval-attempt-1.json'), 'utf8'));
    assert.equal(decision.decision, 'approved');
  } finally {
    await stopServer(server);
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('stopping at correction approval makes no further workspace changes and rejects stale decisions', { timeout: 20_000 }, async () => {
  const fixture = await createFixture('cancel');
  let server;
  try {
    const started = await startFixtureServer(fixture);
    ({ server } = started);
    await beginExecution(fixture, started.port);
    const paused = await waitFor(async () => {
      const value = await readStatus(fixture);
      return value.state === 'awaiting_correction_approval' ? value : null;
    });
    const stopped = await fetch(`http://127.0.0.1:${started.port}/api/runs/${fixture.runName}/correction/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: paused.correctionApproval.decisionId }),
    });
    assert.equal(stopped.status, 200);
    const status = await readStatus(fixture);
    assert.equal(status.state, 'failed');
    assert.equal(status.reason, 'stopped_by_user');
    assert.deepEqual(await readCalls(fixture), ['execute', 'verify']);

    const stale = await fetch(`http://127.0.0.1:${started.port}/api/runs/${fixture.runName}/correction/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: paused.correctionApproval.decisionId }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await stopServer(server);
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

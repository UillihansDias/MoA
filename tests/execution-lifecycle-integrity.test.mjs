import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateExecutionEligibility, finalizeRun } from '../run-state.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const completeStages = () => ({
  initialize: { status: 'complete' },
  plan: { status: 'complete' },
  explore: { status: 'complete' },
  consolidate: { status: 'complete' },
  judge: { status: 'complete' },
  execute: { status: 'pending' },
  verify: { status: 'pending' },
});
const v2Manifest = (runName, workspace, patch = {}) => ({
  schemaVersion: 2,
  harness: 'MoA',
  runName,
  runId: `${runName}-id`,
  parentRunId: null,
  rootRunId: `${runName}-id`,
  revision: 1,
  workspace,
  state: 'awaiting_execution',
  currentStage: 'judge',
  stages: completeStages(),
  ...patch,
});

const getAvailablePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});

const waitFor = async (probe, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(30);
  }
  throw lastError || new Error('Timed out waiting for lifecycle state.');
};

const startServer = async ({ temporary, runsDir, mockCodex, workflow, extraEnv = {} }) => {
  const port = await getAvailablePort();
  const stderr = path.join(temporary, 'server.stderr.log');
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOA_PORT: String(port),
      MOA_RUNS_DIR: runsDir,
      MOA_UPLOADS_DIR: path.join(temporary, 'uploads'),
      MOA_CODEX_BIN: mockCodex,
      MOA_TEST_CALLS: path.join(temporary, 'calls.txt'),
      MOA_WORKFLOW_SCRIPT: workflow || path.join(projectRoot, 'MoA.command'),
      MOA_EXECUTION_IDLE_TIMEOUT_MS: '5000',
      MOA_EXECUTION_MAX_RUNTIME_MS: '15000',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.pipe((await import('node:fs')).createWriteStream(stderr));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
  return { server, port, stderr };
};

const stopServer = async (server) => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(2_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
};

const createRun = async (runsDir, workspace, runName, manifest, extra = {}) => {
  const runDir = path.join(runsDir, runName);
  await mkdir(runDir, { recursive: true });
  const files = {
    'task.txt': `${extra.task || 'Apply the judged change.'}\n`,
    'workspace.txt': `${workspace}\n`,
    'judge.md': extra.judge === undefined ? 'Apply one deterministic change.\n' : extra.judge,
    'investigation-brief.md': 'The result must be independently verified.\n',
    ...extra.files,
  };
  if (manifest !== undefined) files['run.json'] = typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(path.join(runDir, name), value)));
  return runDir;
};

const requestExecute = (port, runName) => fetch(`http://127.0.0.1:${port}/api/execute`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runName }),
});

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

const snapshotDirectory = async (dir) => {
  const names = (await readdir(dir)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const details = await stat(file);
    return [name, details.isFile() ? digest(await readFile(file)) : `directory:${details.mode & 0o777}`];
  })));
};

const assertManifestHashes = async (runDir) => {
  const manifest = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
  for (const [name, record] of Object.entries(manifest.artifacts || {})) {
    if (record.sha256) assert.equal(digest(await readFile(path.join(runDir, name))), record.sha256, name);
  }
  return manifest;
};

const writeMockCodex = async (file) => {
  await writeFile(file, `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('mock-codex 1.0'); process.exit(0); }
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const prompt = args.at(-1);
await appendFile(process.env.MOA_TEST_CALLS, prompt.includes('independent Verify stage') ? 'verify\\n' : 'execute\\n');
if (prompt.includes('independent Verify stage')) {
  await writeFile(output, 'VERIFICATION_PASSED\\nStructured iteration feedback: None.\\n');
} else {
  await writeFile(output, 'EXECUTION_COMPLETED\\nApplied the plan.\\n');
  if (prompt.includes('SABOTAGE_FINALIZATION')) await writeFile(path.join(path.dirname(output), 'run.json'), '{broken');
  if (prompt.includes('LATE_OUTPUT')) process.stdout.write('LATE_OUTPUT_BEGIN\\n' + 'x'.repeat(512 * 1024) + '\\nLATE_OUTPUT_END\\n');
  else await new Promise((resolve) => setTimeout(resolve, 150));
  if (prompt.includes('FAIL_EXECUTION')) process.exitCode = 2;
}
`);
  await chmod(file, 0o755);
};

test('execution eligibility is deterministic for schema-v1, schema-v2, lifecycle, and footprint cases', () => {
  const runName = 'eligibility';
  const workspace = '/tmp/workspace';
  const eligibleV2 = evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace), runName, judge: 'Plan', artifactNames: ['judge.md'] });
  assert.deepEqual(eligibleV2, { eligible: true, code: null, reason: null });
  assert.equal(evaluateExecutionEligibility({ manifest: { schemaVersion: 1, state: 'awaiting_execution', stages: {} }, runName, judge: 'Plan' }).eligible, true);
  assert.equal(evaluateExecutionEligibility({ manifest: null, runName, judge: 'Plan' }).code, 'invalid_run_manifest');
  for (const state of ['running', 'failed', 'completed', 'continuation_created']) {
    assert.equal(evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace, { state }), runName, judge: 'Plan' }).code, 'run_not_awaiting_execution');
  }
  assert.equal(evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace), runName, judge: '' }).code, 'judge_not_complete');
  assert.equal(evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace, { stages: { ...completeStages(), judge: { status: 'running' } } }), runName, judge: 'Plan' }).code, 'judge_not_complete');
  assert.equal(evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace), runName, judge: 'Plan', artifactNames: ['execution-attempt-1.md'] }).code, 'run_already_attempted');
  assert.equal(evaluateExecutionEligibility({ manifest: v2Manifest(runName, workspace, { stages: { ...completeStages(), verify: { status: 'failed' } } }), runName, judge: 'Plan' }).code, 'run_already_attempted');
  assert.equal(evaluateExecutionEligibility({ manifest: { schemaVersion: 1, state: 'awaiting_execution', stages: { judge: { status: 'running' } } }, runName, judge: 'Plan' }).code, 'judge_not_complete');
});

test('terminal finalization inventories exact bytes and is idempotent without reviving outcomes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-finalize-'));
  try {
    for (const [name, state, reason, statusName] of [
      ['execution_success', 'completed', 'completed', 'execution.status.json'],
      ['execution_failure', 'failed', 'verification_failed', 'execution.status.json'],
      ['workflow_success', 'completed', 'completed', 'workflow.status.json'],
      ['workflow_failure', 'failed', 'workflow_idle_timeout', 'workflow.status.json'],
    ]) {
      const runDir = path.join(temporary, name);
      await mkdir(runDir);
      await writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(v2Manifest(name, temporary), null, 2)}\n`);
      await writeFile(path.join(runDir, 'events.jsonl'), '');
      await writeFile(path.join(runDir, statusName), `${JSON.stringify({ state, reason })}\n`);
      await finalizeRun(runDir, state, reason);
      const once = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
      await finalizeRun(runDir, state, reason);
      assert.equal(await readFile(path.join(runDir, 'events.jsonl'), 'utf8'), once);
      const manifest = await assertManifestHashes(runDir);
      assert.equal(manifest.artifacts[statusName].sha256, digest(await readFile(path.join(runDir, statusName))));
      await assert.rejects(() => finalizeRun(runDir, state === 'completed' ? 'failed' : 'completed', 'different'), /terminal run/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('API rejects every ineligible run without mutating artifacts or launching Codex', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-rejections-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const calls = path.join(temporary, 'calls.txt');
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(calls, '')]);
    await writeMockCodex(mockCodex);
    const cases = [
      ['missing_manifest', undefined, {}, 422, 'invalid_run_manifest'],
      ['malformed_manifest', '{broken', {}, 422, 'invalid_run_manifest'],
      ['incompatible_manifest', { schemaVersion: 99, state: 'awaiting_execution' }, {}, 422, 'invalid_run_manifest'],
      ['running_manifest', v2Manifest('running_manifest', workspace, { state: 'running' }), {}, 409, 'run_not_awaiting_execution'],
      ['failed_manifest', v2Manifest('failed_manifest', workspace, { state: 'failed' }), {}, 409, 'run_not_awaiting_execution'],
      ['completed_manifest', v2Manifest('completed_manifest', workspace, { state: 'completed' }), {}, 409, 'run_not_awaiting_execution'],
      ['other_manifest', v2Manifest('other_manifest', workspace, { state: 'continuation_created' }), {}, 409, 'run_not_awaiting_execution'],
      ['judge_incomplete', v2Manifest('judge_incomplete', workspace, { stages: { ...completeStages(), judge: { status: 'running' } } }), {}, 409, 'judge_not_complete'],
      ['execute_nonpending', v2Manifest('execute_nonpending', workspace, { stages: { ...completeStages(), execute: { status: 'running' } } }), {}, 409, 'run_already_attempted'],
      ['footprint', v2Manifest('footprint', workspace), { files: { 'git-pre-execution.json': '{}\n', 'execution.md': 'historical\n' } }, 409, 'run_already_attempted'],
    ];
    const directories = new Map();
    for (const [name, manifest, extra] of cases) directories.set(name, await createRun(runsDir, workspace, name, manifest, extra));
    const started = await startServer({ temporary, runsDir, mockCodex });
    server = started.server;
    for (const [name, , , expectedStatus, expectedCode] of cases) {
      const before = await snapshotDirectory(directories.get(name));
      const response = await requestExecute(started.port, name);
      assert.equal(response.status, expectedStatus, name);
      const payload = await response.json();
      assert.equal(payload.code, expectedCode, name);
      assert.match(payload.error, /resume/i, name);
      assert.deepEqual(await snapshotDirectory(directories.get(name)), before, name);
    }
    assert.equal(await readFile(calls, 'utf8'), '');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('schema-v2 and schema-v1 runs execute once, concurrent admission launches once, and terminal hashes match', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-acceptance-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const calls = path.join(temporary, 'calls.txt');
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(calls, '')]);
    await writeMockCodex(mockCodex);
    const v2Dir = await createRun(runsDir, workspace, 'schema_v2', v2Manifest('schema_v2', workspace));
    const v1Dir = await createRun(runsDir, workspace, 'schema_v1', { schemaVersion: 1, state: 'awaiting_execution', stages: {} });
    const started = await startServer({ temporary, runsDir, mockCodex });
    server = started.server;

    const [left, right] = await Promise.all([requestExecute(started.port, 'schema_v2'), requestExecute(started.port, 'schema_v2')]);
    assert.deepEqual([left.status, right.status].sort(), [202, 409]);
    const terminalV2 = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(v2Dir, 'execution.status.json'), 'utf8'));
      return value.state === 'completed' || value.state === 'failed' ? value : null;
    });
    assert.equal(terminalV2.state, 'completed');
    const manifestV2 = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(v2Dir, 'run.json'), 'utf8'));
      return value.state === 'completed' && value.artifacts?.['execution.status.json'] ? value : null;
    });
    await assertManifestHashes(v2Dir);
    assert.equal(manifestV2.state, 'completed');
    assert.equal(manifestV2.artifacts['execution.status.json'].sha256, digest(await readFile(path.join(v2Dir, 'execution.status.json'))));
    assert.equal((await stat(v2Dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(v2Dir, 'run.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(v2Dir, 'execution.status.json'))).mode & 0o777, 0o600);

    const acceptedV1 = await requestExecute(started.port, 'schema_v1');
    assert.equal(acceptedV1.status, 202);
    const terminalV1 = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(v1Dir, 'execution.status.json'), 'utf8'));
      return value.state === 'completed' || value.state === 'failed' ? value : null;
    });
    assert.equal(terminalV1.state, 'completed');
    await assertManifestHashes(v1Dir);

    const callsList = (await readFile(calls, 'utf8')).trim().split('\n');
    assert.deepEqual(callsList, ['execute', 'verify', 'execute', 'verify']);
    const completedSnapshot = await snapshotDirectory(v2Dir);
    const rejectedReplay = await requestExecute(started.port, 'schema_v2');
    assert.equal(rejectedReplay.status, 409);
    assert.equal((await rejectedReplay.json()).code, 'run_not_awaiting_execution');
    assert.deepEqual(await snapshotDirectory(v2Dir), completedSnapshot);
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a terminal parent remains byte-for-byte immutable after rejected execution and continuation creation', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-parent-immutable-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const calls = path.join(temporary, 'calls.txt');
  const workflow = path.join(temporary, 'workflow.command');
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(calls, '')]);
    await writeMockCodex(mockCodex);
    await writeFile(workflow, '#!/bin/bash\nexit 0\n');
    await chmod(workflow, 0o755);
    const parentName = 'terminal_parent';
    const parentDir = await createRun(runsDir, workspace, parentName, v2Manifest(parentName, workspace, {
      state: 'completed',
      currentStage: 'verify',
      endedAt: new Date().toISOString(),
      stages: { ...completeStages(), execute: { status: 'complete' }, verify: { status: 'complete' } },
    }), { files: { 'git-after-execution.json': `${JSON.stringify({ schemaVersion: 1, workspace, repository: false })}\n`, 'execution.md': 'historical execution\n', 'verification.md': 'VERIFICATION_PASSED\n' } });
    const started = await startServer({ temporary, runsDir, mockCodex, workflow });
    server = started.server;
    const before = await snapshotDirectory(parentDir);
    const rejected = await requestExecute(started.port, parentName);
    assert.equal(rejected.status, 409);
    assert.deepEqual(await snapshotDirectory(parentDir), before);
    const resumed = await fetch(`http://127.0.0.1:${started.port}/api/runs/${parentName}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'Continue in a fresh revision.', mode: 'continue' }),
    });
    assert.equal(resumed.status, 202);
    assert.deepEqual(await snapshotDirectory(parentDir), before);
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('finalization failure is fail-closed, reports failure, and releases admission', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-finalization-failure-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const calls = path.join(temporary, 'calls.txt');
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(calls, '')]);
    await writeMockCodex(mockCodex);
    const brokenDir = await createRun(runsDir, workspace, 'broken_finalization', v2Manifest('broken_finalization', workspace), { task: 'SABOTAGE_FINALIZATION' });
    const healthyDir = await createRun(runsDir, workspace, 'healthy_after_failure', v2Manifest('healthy_after_failure', workspace));
    const started = await startServer({ temporary, runsDir, mockCodex });
    server = started.server;
    assert.equal((await requestExecute(started.port, 'broken_finalization')).status, 202);
    const failed = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(brokenDir, 'execution.status.json'), 'utf8'));
      if (['completed', 'failed'].includes(value.state) && value.reason !== 'finalization_failed') throw new Error(`Unexpected terminal status: ${JSON.stringify(value)}`);
      return value.reason === 'finalization_failed' ? value : null;
    });
    assert.equal(failed.state, 'failed');
    const overview = await waitFor(async () => {
      const value = await (await fetch(`http://127.0.0.1:${started.port}/api/status`)).json();
      return value.active.length === 0 ? value : null;
    });
    const outcome = overview.executions.find(({ id }) => id === failed.id);
    assert.equal(outcome?.reason, 'finalization_failed');
    assert.notEqual(outcome?.state, 'completed');

    assert.equal((await requestExecute(started.port, 'healthy_after_failure')).status, 202);
    const healthy = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(healthyDir, 'execution.status.json'), 'utf8'));
      return value.state === 'completed' ? value : null;
    });
    assert.equal(healthy.state, 'completed');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('workflow refresh failure persists fail-closed status and remains failed after restart', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-workflow-finalization-failure-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const workflow = path.join(temporary, 'workflow.command');
  const runName = 'workflow_refresh_failure';
  const runDir = path.join(runsDir, runName);
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(path.join(temporary, 'calls.txt'), '')]);
    await writeMockCodex(mockCodex);
    await writeFile(workflow, `#!/bin/bash
run_dir="$MOA_RUNS_DIR/${runName}"
mkdir -p "$run_dir"
printf '%s\\n' "$2" > "$run_dir/workspace.txt"
printf '%s\\n' "$3" > "$run_dir/task.txt"
printf '%s\\n' '{"schemaVersion":1,"state":"awaiting_execution","currentStage":"judge","stages":{"initialize":{"status":"complete"},"plan":{"status":"complete"},"explore":{"status":"complete"},"consolidate":{"status":"complete"},"judge":{"status":"complete"},"execute":{"status":"pending"},"verify":{"status":"pending"}}}' > "$run_dir/run.json"
printf '%s\\n' 'Apply one deterministic change.' > "$run_dir/judge.md"
printf 'MOA_RUN_DIR=%s\\n' "$run_dir"
`);
    await chmod(workflow, 0o755);
    let started = await startServer({
      temporary,
      runsDir,
      mockCodex,
      workflow,
      extraEnv: { NODE_ENV: 'test', MOA_TEST_FAIL_WORKFLOW_REFRESH: runName },
    });
    server = started.server;
    const response = await fetch(`http://127.0.0.1:${started.port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, task: 'Produce a safe execution plan.' }),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    const failedStatus = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'workflow.status.json'), 'utf8'));
      return value.reason === 'finalization_failed' ? value : null;
    });
    assert.equal(failedStatus.id, accepted.id);
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.detail, /Injected workflow artifact refresh failure/);
    const failedManifest = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
      return value.reason === 'finalization_failed' ? value : null;
    });
    assert.equal(failedManifest.state, 'failed');
    assert.equal(failedManifest.reason, 'finalization_failed');
    await waitFor(async () => {
      const overview = await (await fetch(`http://127.0.0.1:${started.port}/api/status`)).json();
      return overview.active.length === 0 ? overview : null;
    });

    await stopServer(server);
    server = null;
    started = await startServer({ temporary, runsDir, mockCodex, workflow });
    server = started.server;
    const recovered = await (await fetch(`http://127.0.0.1:${started.port}/api/status`)).json();
    const persisted = recovered.executions.find(({ id }) => id === accepted.id);
    assert.equal(persisted?.state, 'failed');
    assert.equal(persisted?.reason, 'finalization_failed');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('successful and failed output emitted immediately before exit is flushed before terminal hashing', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-late-output-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const calls = path.join(temporary, 'calls.txt');
  const runName = 'late_output';
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(workspace), writeFile(calls, '')]);
    await writeMockCodex(mockCodex);
    const runDir = await createRun(runsDir, workspace, runName, v2Manifest(runName, workspace), { task: 'LATE_OUTPUT' });
    const failedRunName = 'late_output_failure';
    const failedRunDir = await createRun(runsDir, workspace, failedRunName, v2Manifest(failedRunName, workspace), { task: 'LATE_OUTPUT FAIL_EXECUTION' });
    const started = await startServer({ temporary, runsDir, mockCodex });
    server = started.server;
    assert.equal((await requestExecute(started.port, runName)).status, 202);
    const manifest = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
      return value.state === 'completed' && value.artifacts?.['execution.log'] ? value : null;
    });
    const log = await readFile(path.join(runDir, 'execution.log'), 'utf8');
    assert.match(log, /LATE_OUTPUT_BEGIN/);
    assert.match(log, /LATE_OUTPUT_END/);
    await assertManifestHashes(runDir);
    assert.equal(manifest.artifacts['execution.log'].size, Buffer.byteLength(log));
    assert.equal(manifest.artifacts['execution.log'].sha256, digest(log));

    assert.equal((await requestExecute(started.port, failedRunName)).status, 202);
    const failedManifest = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(failedRunDir, 'run.json'), 'utf8'));
      return value.state === 'failed' && value.artifacts?.['execution.log'] ? value : null;
    });
    const failedStatus = JSON.parse(await readFile(path.join(failedRunDir, 'execution.status.json'), 'utf8'));
    assert.equal(failedStatus.state, 'failed');
    assert.equal(failedStatus.reason, 'failed');
    const failedLog = await readFile(path.join(failedRunDir, 'execution.log'), 'utf8');
    assert.match(failedLog, /LATE_OUTPUT_END/);
    await assertManifestHashes(failedRunDir);
    assert.equal(failedManifest.artifacts['execution.log'].size, Buffer.byteLength(failedLog));
    assert.equal(failedManifest.artifacts['execution.log'].sha256, digest(failedLog));
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
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
    await wait(50);
  }
  throw lastError || new Error('Timed out waiting for the recovery workflow.');
};

test('a blocked corrective pass is re-judged and reaches verified completion', { timeout: 25_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-recovery-'));
  const runsDir = path.join(temporary, 'runs');
  const runName = 'recovery_test';
  const runDir = path.join(runsDir, runName);
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const mockState = path.join(temporary, 'mock-state.json');
  const port = await getAvailablePort();
  let server;

  try {
    await Promise.all([mkdir(runDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(runDir, 'task.txt'), 'Implement the requested feature completely.\n'),
      writeFile(path.join(runDir, 'workspace.txt'), `${workspace}\n`),
      writeFile(path.join(runDir, 'judge.md'), 'Implement and verify the complete objective.\n'),
      writeFile(path.join(runDir, 'investigation-brief.md'), 'Every material success criterion must pass.\n'),
      writeFile(path.join(runDir, 'evidence.md'), 'A safe complete implementation is possible.\n'),
      writeFile(path.join(runDir, 'run.json'), `${JSON.stringify({ schemaVersion: 1, state: 'awaiting_execution', stages: {} }, null, 2)}\n`),
      writeFile(mockState, `${JSON.stringify({ calls: [], executorCount: 0, verifierCount: 0, correctionCount: 0 }, null, 2)}\n`),
    ]);

    await writeFile(mockCodex, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const output = args[outputIndex + 1];
const prompt = args.at(-1);
const statePath = process.env.MOA_TEST_STATE;
const state = JSON.parse(await readFile(statePath, 'utf8'));
const workspaceWrite = args.includes('workspace-write');
const networkEnabled = args.some((arg, index) => arg === '-c' && args[index + 1] === 'sandbox_workspace_write.network_access=true');
let kind;
let report;
if (prompt.includes('bounded Judge-stage recovery')) {
  kind = 'blocked-plan-judge';
  report = 'REVISED_EXECUTION_PLAN\\nApply a complete first revision, then verify every original criterion.\\n';
} else if (prompt.includes('bounded Judge re-evaluation')) {
  kind = 'correction-judge';
  report = 'REVISED_EXECUTION_PLAN\\nResolve the verified gap completely without narrowing the original objective.\\n';
	} else if (prompt.includes('corrective Execute pass')) {
	  kind = 'correction';
	  if (!workspaceWrite || !networkEnabled) throw new Error('Corrective executor lacks workspace-scoped network access.');
	  state.correctionCount += 1;
	  report = state.correctionCount === 1
	    ? 'EXECUTION_BLOCKED: verification requires work forbidden by the current plan.\\n'
	    : 'EXECUTION_COMPLETED\\nThe reconciled corrective scope was applied.\\n';
} else if (prompt.includes('independent Verify stage')) {
  kind = 'verify';
  state.verifierCount += 1;
	  report = state.verifierCount === 1
	    ? 'VERIFICATION_FAILED\\nCorrection actionable: yes\\nVerifier summary: A material criterion remains incomplete.\\nActionable findings:\\n- The required behavior is missing.\\nProposed correction scope: Implement only the missing behavior.\\nAffected files or areas:\\n- src/feature.mjs\\nJudge re-evaluation may be required: yes\\nStructured iteration feedback: complete the material missing criterion.\\n'
	    : 'VERIFICATION_PASSED\\nStructured iteration feedback: None.\\n';
} else if (prompt.includes('You own only the Execute stage')) {
  kind = 'execute';
  if (!workspaceWrite || !networkEnabled) throw new Error('Executor lacks workspace-scoped network access.');
  state.executorCount += 1;
  report = state.executorCount === 1
    ? 'EXECUTION_BLOCKED: the first plan cannot be applied as written.\\n'
    : 'EXECUTION_COMPLETED\\nThe current judge plan was applied.\\n';
} else {
  throw new Error('Unexpected prompt.');
}
state.calls.push({ kind, workspaceWrite, networkEnabled });
await writeFile(statePath, JSON.stringify(state, null, 2));
await writeFile(output, report);
process.stdout.write(kind + ' complete\\n');
`);
    await chmod(mockCodex, 0o755);

    server = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MOA_PORT: String(port),
        MOA_RUNS_DIR: runsDir,
        MOA_CODEX_BIN: mockCodex,
        MOA_TEST_STATE: mockState,
        MOA_EXECUTION_IDLE_TIMEOUT_MS: '5000',
        MOA_EXECUTION_MAX_RUNTIME_MS: '20000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const response = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runName }),
    });
    assert.equal(response.status, 202);

    const paused = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'execution.status.json'), 'utf8'));
      return value.state === 'awaiting_correction_approval' ? value : null;
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.correctionApproval.attemptNumber, 1);
    assert.equal(paused.correctionApproval.judgeReevaluationMayBeRequired, true);
    assert.deepEqual((JSON.parse(await readFile(mockState, 'utf8'))).calls.map(({ kind }) => kind), [
      'execute',
      'blocked-plan-judge',
      'execute',
      'verify',
    ]);

    const approvalResponse = await fetch(`http://127.0.0.1:${port}/api/runs/${runName}/correction/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId: paused.correctionApproval.decisionId }),
    });
    assert.equal(approvalResponse.status, 202);

    const status = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'execution.status.json'), 'utf8'));
      return value.state === 'completed' || value.state === 'failed' ? value : null;
    });
    assert.equal(status.state, 'completed', JSON.stringify(status));
    assert.equal(status.reason, 'completed');
    assert.equal(status.correctionAttempts, 1);
    assert.equal(status.planRevisionAttempts, 1);
    assert.equal(status.correctionPlanRevisionAttempts, 1);

    const state = JSON.parse(await readFile(mockState, 'utf8'));
    assert.deepEqual(state.calls.map(({ kind }) => kind), [
      'execute',
      'blocked-plan-judge',
      'execute',
      'verify',
      'correction',
      'correction-judge',
      'correction',
      'verify',
    ]);
    for (const call of state.calls.filter(({ kind }) => kind === 'execute' || kind === 'correction')) {
      assert.equal(call.workspaceWrite, true);
      assert.equal(call.networkEnabled, true);
    }
    assert.match(await readFile(path.join(runDir, 'judge-correction-revision-attempt-1.md'), 'utf8'), /^REVISED_EXECUTION_PLAN/);
    assert.match(await readFile(path.join(runDir, 'verification.md'), 'utf8'), /^VERIFICATION_PASSED/);
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(2_000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

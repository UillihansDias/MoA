import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { inspectGitState } from '../run-state.mjs';
import { groupProjectRuns, readResumeDraft, writeResumeDraft } from '../src/resume-state.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const availablePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolve(port)); });
});
const waitFor = async (probe, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe().catch(() => null); if (value) return value; await wait(40); }
  throw new Error('Timed out waiting for MoA.');
};
const request = async (port, route, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('resumable run endpoint links immutable revisions, guards drift, and recovers atomic creation', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-resume-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const parentName = '2026-01-01_10-00-00';
  const parentDir = path.join(runsDir, parentName);
  const invalidDir = path.join(runsDir, 'invalid_manifest');
  const deletedDir = path.join(runsDir, 'deleted_workspace');
  const interruptedDir = path.join(runsDir, '.continuation-interrupted.tmp');
  const mockWorkflow = path.join(temporary, 'mock-workflow.command');
  const port = await availablePort();
  let server;
  try {
    await Promise.all([mkdir(parentDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(invalidDir, { recursive: true }), mkdir(deletedDir, { recursive: true }), mkdir(interruptedDir, { recursive: true })]);
    await writeFile(path.join(workspace, 'project.txt'), 'baseline\n');
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    await execFileAsync('git', ['add', 'project.txt'], { cwd: workspace });
    await execFileAsync('git', ['-c', 'user.name=MoA Test', '-c', 'user.email=moa@example.test', 'commit', '-qm', 'baseline'], { cwd: workspace });
    const gitAfter = await inspectGitState(workspace, 'after-execution');
    const parentManifest = { schemaVersion: 2, harness: 'MoA', runName: parentName, runId: 'parent-id', parentRunId: null, rootRunId: 'parent-id', revision: 1, workspace, state: 'completed', currentStage: 'verify', stages: { initialize: { status: 'complete' }, plan: { status: 'complete' }, explore: { status: 'complete' }, consolidate: { status: 'complete' }, judge: { status: 'complete' }, execute: { status: 'complete' }, verify: { status: 'complete' } } };
    await Promise.all([
      writeFile(path.join(parentDir, 'run.json'), `${JSON.stringify(parentManifest)}\n`),
      writeFile(path.join(parentDir, 'workspace.txt'), `${workspace}\n`),
      writeFile(path.join(parentDir, 'task.txt'), 'Build export support without changing existing behaviour.\n'),
      writeFile(path.join(parentDir, 'investigation-brief.md'), 'Preserve compatibility and verify export behaviour.\n'),
      writeFile(path.join(parentDir, 'judge.md'), 'Add export support and test it.\n'),
      writeFile(path.join(parentDir, 'execution.md'), 'EXECUTION_COMPLETED\nChanged project.txt.\n'),
      writeFile(path.join(parentDir, 'verification.md'), 'VERIFICATION_PASSED\n'),
      writeFile(path.join(parentDir, 'git-after-execution.json'), `${JSON.stringify(gitAfter)}\n`),
      writeFile(path.join(invalidDir, 'run.json'), '{broken'),
      writeFile(path.join(invalidDir, 'workspace.txt'), `${workspace}\n`),
      writeFile(path.join(deletedDir, 'run.json'), `${JSON.stringify({ ...parentManifest, runName: 'deleted_workspace', runId: 'deleted-id', rootRunId: 'deleted-id', workspace: path.join(temporary, 'gone') })}\n`),
      writeFile(path.join(deletedDir, 'workspace.txt'), `${path.join(temporary, 'gone')}\n`),
      writeFile(path.join(deletedDir, 'task.txt'), 'Old objective\n'),
      writeFile(path.join(interruptedDir, 'run.json'), '{}'),
      writeFile(mockWorkflow, '#!/bin/bash\nsleep 0.35\nprintf "MOA_RUN_DIR=%s\\n" "$2"\n'),
    ]);
    await chmod(mockWorkflow, 0o700);
    const parentSnapshot = digest(await readFile(path.join(parentDir, 'run.json')) + await readFile(path.join(parentDir, 'investigation-brief.md')));

    server = execFile(process.execPath, ['server.mjs'], { cwd: projectRoot, env: { ...process.env, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_WORKFLOW_SCRIPT: mockWorkflow } });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    await assert.rejects(stat(interruptedDir));

    assert.equal((await request(port, '/api/runs/missing/resume', { instruction: 'Continue', mode: 'continue' })).status, 404);
    assert.equal((await request(port, '/api/runs/invalid_manifest/resume', { instruction: 'Continue', mode: 'continue' })).status, 422);
    assert.equal((await request(port, '/api/runs/deleted_workspace/resume', { instruction: 'Continue', mode: 'continue' })).status, 410);

    const continued = await request(port, `/api/runs/${parentName}/resume`, { instruction: 'Add CSV export.', mode: 'continue' });
    assert.equal(continued.status, 202, JSON.stringify(continued.body));
    assert.equal(continued.body.parentRunId, 'parent-id');
    assert.equal(continued.body.rootRunId, 'parent-id');
    assert.equal(continued.body.revision, 2);
    const childDir = path.join(runsDir, continued.body.runName);
    const childManifest = JSON.parse(await readFile(path.join(childDir, 'run.json'), 'utf8'));
    assert.equal(childManifest.schemaVersion, 2);
    assert.equal(childManifest.parentRunId, 'parent-id');
    assert.equal(childManifest.rootRunId, 'parent-id');
    assert.equal(childManifest.revision, 2);
    assert.equal(childManifest.resumeInstruction, 'Add CSV export.');
    assert.ok(childManifest.resumedAt);
    assert.equal(childManifest.continuation.startingStage, 'plan');
    assert.ok(childManifest.inheritedFrom.judge.sha256);
    const eventTypes = (await readFile(path.join(childDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).type);
    assert.deepEqual(eventTypes.slice(0, 5), ['resume_requested', 'parent_context_loaded', 'workspace_drift_checked', 'continuation_created', 'resume_started']);
    assert.equal(digest(await readFile(path.join(parentDir, 'run.json')) + await readFile(path.join(parentDir, 'investigation-brief.md'))), parentSnapshot, 'parent evidence must remain immutable');

    const conflict = await request(port, `/api/runs/${parentName}/resume`, { instruction: 'Start concurrently.', mode: 'continue' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'active_run_conflict');
    await waitFor(async () => (await request(port, '/api/status')).body.active.length === 0);

    await writeFile(path.join(workspace, 'project.txt'), 'external change\n');
    const drifted = await request(port, `/api/runs/${parentName}/resume`, { instruction: 'Add JSON export.', mode: 'continue' });
    assert.equal(drifted.status, 409);
    assert.equal(drifted.body.code, 'workspace_drift');
    assert.equal(drifted.body.requiresConfirmation, true);
    assert.equal(drifted.body.drift.detected, true);
    const confirmed = await request(port, `/api/runs/${parentName}/resume`, { instruction: 'Add JSON export.', mode: 'continue', confirmDrift: true });
    assert.equal(confirmed.status, 202);
    assert.equal(confirmed.body.revision, 3);
    assert.equal(confirmed.body.drift.detected, true);
    await waitFor(async () => (await request(port, '/api/status')).body.active.length === 0);

    const list = (await request(port, '/api/runs')).body.runs;
    const revisions = list.filter(({ rootRunId }) => rootRunId === 'parent-id').map(({ revision }) => revision).sort();
    assert.deepEqual(revisions, [1, 2, 3]);
    const deletion = await fetch(`http://127.0.0.1:${port}/api/runs`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: [parentName] }) });
    assert.equal(deletion.status, 409, 'a referenced immutable parent cannot be deleted alone');
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('resume draft survives refresh and project history remains grouped after SSE-style list refreshes', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const draft = { runName: 'child', instruction: 'Add export support', drift: { detected: true }, inheritedFrom: null };
  writeResumeDraft(storage, draft);
  assert.deepEqual(readResumeDraft(storage), draft);
  const refreshed = [{ name: 'child', runId: 'child-id', parentRunId: 'root-id', rootRunId: 'root-id', revision: 2 }, { name: 'root', runId: 'root-id', parentRunId: null, rootRunId: 'root-id', revision: 1 }];
  const groups = groupProjectRuns(refreshed);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].runs.map(({ name }) => name), ['root', 'child']);
});

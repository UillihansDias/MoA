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
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
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
  throw lastError || new Error('Timed out waiting for watchdog recovery.');
};

const stopServer = async (server) => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(2_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
};

test('a silent Judge workflow is bounded, persisted, and removed from active state', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-workflow-watchdog-'));
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const workflow = path.join(temporary, 'hanging-workflow.command');
  const runName = 'judge_hang';
  const runDir = path.join(runsDir, runName);
  const port = await getAvailablePort();
  let server;

  try {
    await Promise.all([mkdir(runsDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await writeFile(workflow, `#!/bin/bash
run_dir="$MOA_RUNS_DIR/${runName}"
mkdir -p "$run_dir"
printf '%s\\n' "$2" > "$run_dir/workspace.txt"
printf '%s\\n' "$3" > "$run_dir/task.txt"
printf '%s\\n' '{"schemaVersion":1,"state":"running","currentStage":"judge","stages":{"initialize":{"status":"complete"},"plan":{"status":"complete"},"explore":{"status":"complete"},"consolidate":{"status":"complete"},"judge":{"status":"running"}}}' > "$run_dir/run.json"
: > "$run_dir/judge.log"
printf 'MOA_RUN_DIR=%s\\n' "$run_dir"
printf 'Independent judge producing execution plan...\\n'
trap 'exit 143' TERM INT
while :; do sleep 10; done
`);
    await chmod(workflow, 0o755);
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_WORKFLOW_SCRIPT: workflow, MOA_WORKFLOW_IDLE_TIMEOUT_MS: '300', MOA_WORKFLOW_MAX_RUNTIME_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const response = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, task: 'Produce a safe execution plan.' }) });
    assert.equal(response.status, 202);
    const started = await response.json();
    const status = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'workflow.status.json'), 'utf8'));
      return value.state === 'failed' ? value : null;
    });
    assert.equal(status.id, started.id);
    assert.equal(status.stage, 'judge');
    assert.equal(status.reason, 'workflow_idle_timeout');
    const overview = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(overview.active.length, 0);
    assert.equal(overview.executions.find(({ id }) => id === started.id)?.reason, 'workflow_idle_timeout');
    const manifest = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(manifest.state, 'failed');
    assert.equal(manifest.stages.judge.status, 'failed');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('an unresponsive executor restarts once from persisted intent and completes verification', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-executor-watchdog-'));
  const runsDir = path.join(temporary, 'runs');
  const runName = 'executor_hang';
  const runDir = path.join(runsDir, runName);
  const workspace = path.join(temporary, 'workspace');
  const mockCodex = path.join(temporary, 'mock-codex.mjs');
  const stateFile = path.join(temporary, 'state.json');
  const port = await getAvailablePort();
  let server;

  try {
    await Promise.all([mkdir(runDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(runDir, 'task.txt'), 'Apply the judged change and verify it.\n'),
      writeFile(path.join(runDir, 'workspace.txt'), `${workspace}\n`),
      writeFile(path.join(runDir, 'judge.md'), 'Apply one deterministic change, then verify it.\n'),
      writeFile(path.join(runDir, 'investigation-brief.md'), 'The requested outcome must be present.\n'),
      writeFile(path.join(runDir, 'run.json'), `${JSON.stringify({ schemaVersion: 1, state: 'awaiting_execution', stages: {} }, null, 2)}\n`),
      writeFile(stateFile, JSON.stringify({ executorCalls: 0, verifierCalls: 0 })),
    ]);
    await writeFile(mockCodex, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('--version')) { console.log('mock-codex 1.0'); process.exit(0); }
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const prompt = args.at(-1);
const state = JSON.parse(await readFile(process.env.MOA_TEST_STATE, 'utf8'));
if (prompt.includes('independent Verify stage')) {
  state.verifierCalls += 1;
  await writeFile(process.env.MOA_TEST_STATE, JSON.stringify(state));
  await writeFile(output, 'VERIFICATION_PASSED\\nStructured iteration feedback: None.\\n');
  console.log('verification complete');
} else if (prompt.includes('You own only the Execute stage')) {
  state.executorCalls += 1;
  await writeFile(process.env.MOA_TEST_STATE, JSON.stringify(state));
  if (state.executorCalls === 1) {
    console.log('executor entered a silent operation');
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
  } else {
    if (!prompt.includes('Runtime recovery:')) throw new Error('Recovery intent was not supplied.');
    await writeFile(output, 'EXECUTION_COMPLETED\\nRecovered from current workspace evidence.\\n');
    console.log('execution recovery complete');
  }
} else {
  throw new Error('Unexpected prompt');
}
`);
    await chmod(mockCodex, 0o755);
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_CODEX_BIN: mockCodex, MOA_TEST_STATE: stateFile, MOA_EXECUTION_IDLE_TIMEOUT_MS: '300', MOA_EXECUTION_MAX_RUNTIME_MS: '5000', MOA_EXECUTION_RUNTIME_RECOVERY_LIMIT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const response = await fetch(`http://127.0.0.1:${port}/api/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runName }) });
    assert.equal(response.status, 202);
    const status = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runDir, 'execution.status.json'), 'utf8'));
      return value.state === 'completed' || value.state === 'failed' ? value : null;
    });
    assert.equal(status.state, 'completed');
    assert.equal(status.runtimeRecoveryAttempts, 1);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual(state, { executorCalls: 2, verifierCalls: 1 });
    assert.match(await readFile(path.join(runDir, 'execution.md'), 'utf8'), /^EXECUTION_COMPLETED/);
    assert.match(await readFile(path.join(runDir, 'verification.md'), 'utf8'), /^VERIFICATION_PASSED/);
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the portable stage runner terminates a silent process group', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-stage-runner-'));
  const log = path.join(temporary, 'stage.log');
  const report = path.join(temporary, 'stage.md');
  const sleeper = path.join(temporary, 'sleeper.mjs');
  try {
    await writeFile(sleeper, `process.stdout.write('report evidence\\n'); process.stderr.write('diagnostic activity\\n'); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, [path.join(projectRoot, 'stage-runner.mjs'), '250', '5000', log, report, 'truncate', process.execPath, sleeper], { env: { ...process.env, MOA_STAGE_STDOUT_PATH: report }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 124);
    assert.match(await readFile(report, 'utf8'), /report evidence/);
    assert.match(await readFile(log, 'utf8'), /diagnostic activity/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the conductor retries a silent Judge from persisted evidence and completes the plan', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-judge-retry-'));
  const home = path.join(temporary, 'home');
  const bin = path.join(home, '.local', 'bin');
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const stateFile = path.join(temporary, 'judge-state.json');
  const opencodeArgsFile = path.join(temporary, 'opencode-args.txt');
  const opencodePrimaryAttempt = path.join(temporary, 'opencode-primary-attempted');
  const codex = path.join(bin, 'codex');
  const agy = path.join(bin, 'agy');
  const opencode = path.join(bin, 'opencode');
  try {
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(runsDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
    await writeFile(stateFile, JSON.stringify({ judgeCalls: 0 }));
    await writeFile(codex, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
if (process.argv.includes('--version')) { console.log('mock-codex 1.0'); process.exit(0); }
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const prompt = args.at(-1);
if (prompt.includes('Judge stage')) {
  const state = JSON.parse(await readFile(process.env.MOA_TEST_STATE, 'utf8'));
  state.judgeCalls += 1;
  await writeFile(process.env.MOA_TEST_STATE, JSON.stringify(state));
  if (state.judgeCalls === 1) {
    console.log('judge entered silent operation');
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
  } else {
    await writeFile(output, 'Execution plan summary\\nConfidence level: 95%\\nExecute and verify the requested change.\\n');
    console.log('judge recovery complete');
  }
} else if (prompt.includes('Consolidate Evidence stage')) {
  await writeFile(output, 'Two independent reports agree on a safe approach.\\n');
} else if (prompt.includes('independent explorer')) {
  await writeFile(output, 'Independent evidence and a safe implementation sequence.\\n');
} else if (prompt.includes('Plan stage')) {
  await writeFile(output, 'Objective, constraints, investigation questions, and success criteria.\\n');
} else {
  throw new Error('Unexpected conductor prompt');
}
`);
    const reportCli = `#!/bin/bash
if [ "\${1:-}" = "--version" ]; then printf 'mock-cli 1.0\\n'; exit 0; fi
if [ "$(basename "$0")" = "opencode" ] && [ "\${1:-}" = "models" ]; then
  printf 'opencode/deepseek-v4-flash-free\\nopencode/mimo-v2.5-free\\n'
  exit 0
fi
if [ "$(basename "$0")" = "opencode" ]; then
  printf '%s\\n' "$@" >> "$MOA_TEST_OPENCODE_ARGS"
  if printf '%s\\n' "$@" | grep -Fq 'opencode/deepseek-v4-flash-free'; then
    : > "$MOA_TEST_OPENCODE_PRIMARY_ATTEMPT"
    printf 'primary model unavailable\\n' >&2
    exit 1
  fi
fi
printf 'Independent evidence and a safe implementation sequence.\\n'
`;
    await Promise.all([writeFile(agy, reportCli), writeFile(opencode, reportCli)]);
    await Promise.all([chmod(codex, 0o755), chmod(agy, 0o755), chmod(opencode, 0o755)]);
    const child = spawn('/bin/bash', [path.join(projectRoot, 'MoA.command'), '--moa-run', workspace, 'Produce a deployment-ready plan.'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, MOA_ROOT: projectRoot, MOA_RUNS_DIR: runsDir, MOA_TEST_STATE: stateFile, MOA_TEST_OPENCODE_ARGS: opencodeArgsFile, MOA_TEST_OPENCODE_PRIMARY_ATTEMPT: opencodePrimaryAttempt, MOA_STAGE_IDLE_TIMEOUT_MS: '300', MOA_STAGE_MAX_RUNTIME_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, output);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.judgeCalls, 2);
    const runDir = output.match(/^MOA_RUN_DIR=(.+)$/m)?.[1]?.trim();
    assert.ok(runDir);
    assert.match(await readFile(path.join(runDir, 'judge.md'), 'utf8'), /Confidence level: 95%/);
    assert.equal((await readFile(path.join(runDir, 'antigravity.status'), 'utf8')).trim(), '0');
    assert.equal((await readFile(path.join(runDir, 'opencode.status'), 'utf8')).trim(), '0');
    const opencodeArgs = await readFile(opencodeArgsFile, 'utf8');
    assert.match(opencodeArgs, /--model\nopencode\/deepseek-v4-flash-free/);
    assert.match(opencodeArgs, /--model\nopencode\/mimo-v2\.5-free/);
    assert.match(await readFile(path.join(runDir, 'opencode-primary.log'), 'utf8'), /primary model unavailable/);
    const manifest = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(manifest.state, 'awaiting_execution');
    assert.equal(manifest.stages.judge.status, 'complete');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI availability probes do not contend during service startup', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-cli-probes-'));
  const home = path.join(temporary, 'home');
  const bin = path.join(home, '.local', 'bin');
  const runsDir = path.join(temporary, 'runs');
  const lockFile = path.join(temporary, 'probe.lock');
  const port = await getAvailablePort();
  let server;

  try {
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(runsDir, { recursive: true })]);
    const probeCli = `#!/usr/bin/env node
import { open, rm } from 'node:fs/promises';
if (process.argv[2] === 'models') {
  console.log('opencode/deepseek-v4-flash-free');
  console.log('opencode/mimo-v2.5-free');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (!process.argv.includes('--version')) process.exit(2);
let lock;
try {
  lock = await open(process.env.MOA_TEST_CLI_LOCK, 'wx');
} catch {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await new Promise((resolve) => setTimeout(resolve, 100));
await lock.close();
await rm(process.env.MOA_TEST_CLI_LOCK, { force: true });
console.log('mock-cli 1.0');
if (process.argv[1].endsWith('opencode')) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;
    await Promise.all(['codex', 'agy', 'opencode', 'claude'].map(async (name) => {
      const executable = path.join(bin, name);
      await writeFile(executable, probeCli);
      await chmod(executable, 0o755);
    }));
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_TEST_CLI_LOCK: lockFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.deepEqual(status.cliIntegrations.map(({ available }) => available), [true, true, true, true]);
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('OpenCode is not admitted without a compatible headless model', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-opencode-provider-'));
  const home = path.join(temporary, 'home');
  const bin = path.join(home, '.local', 'bin');
  const runsDir = path.join(temporary, 'runs');
  const port = await getAvailablePort();
  let server;

  try {
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(runsDir, { recursive: true })]);
    const mockCli = `#!/bin/bash
if [ "\${1:-}" = "--version" ]; then printf 'mock-cli 1.0\\n'; exit 0; fi
if [ "\${1:-}" = "models" ]; then printf 'other/example-model\\n'; exit 0; fi
exit 0
`;
    await Promise.all(['codex', 'agy', 'opencode'].map(async (name) => {
      const executable = path.join(bin, name);
      await writeFile(executable, mockCli);
      await chmod(executable, 0o755);
    }));
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const opencode = status.cliIntegrations.find(({ id }) => id === 'opencode');
    assert.equal(opencode.available, false);
    assert.equal(opencode.gatewayAvailable, true);
    assert.equal(opencode.version, 'compatible model unavailable');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

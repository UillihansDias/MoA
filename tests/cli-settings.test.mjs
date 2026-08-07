import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const availablePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});
const waitFor = async (probe, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await wait(40);
  }
  throw new Error('Timed out waiting for CLI settings state.');
};
const stopServer = async (server) => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    wait(2_000).then(() => server.kill('SIGKILL')),
  ]);
};

test('Claude Code is built in and CLI enabled state persists and scopes new workflows', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-cli-settings-'));
  const home = path.join(temporary, 'home');
  const bin = path.join(home, '.local', 'bin');
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const observed = path.join(temporary, 'enabled-clis.txt');
  const workflow = path.join(temporary, 'workflow.command');
  const port = await availablePort();
  let server;

  const startServer = async () => {
    const processHandle = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_WORKFLOW_SCRIPT: workflow },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    return processHandle;
  };

  try {
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(runsDir), mkdir(workspace)]);
    const mockCli = `#!/bin/bash
if [ "\${1:-}" = "models" ]; then printf 'opencode/deepseek-v4-flash-free\\n'; else printf '%s 1.0\\n' "$(basename "$0")"; fi
`;
    await Promise.all(['codex', 'agy', 'opencode', 'claude'].map(async (name) => {
      const executable = path.join(bin, name);
      await writeFile(executable, mockCli);
      await chmod(executable, 0o700);
    }));
    await writeFile(workflow, `#!/bin/bash
printf '%s' "$MOA_ENABLED_CLIS" > "${observed}"
`);
    await chmod(workflow, 0o700);

    server = await startServer();
    const initial = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const claude = initial.cliIntegrations.find(({ id }) => id === 'claude');
    assert.deepEqual(
      { label: claude.label, command: claude.command, builtIn: claude.builtIn, enabled: claude.enabled, available: claude.available },
      { label: 'Claude Code', command: 'claude', builtIn: true, enabled: true, available: true },
    );
    const initialChat = await (await fetch(`http://127.0.0.1:${port}/api/chat`)).json();
    assert.equal(initialChat.agents.some(({ id }) => id === 'claude'), true);

    const disabled = await fetch(`http://127.0.0.1:${port}/api/cli-integrations/claude`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200, await disabled.text());
    const config = path.join(home, '.MoA', 'cli-enabled.json');
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { schemaVersion: 1, enabled: { claude: false } });
    assert.equal((await stat(config)).mode & 0o777, 0o600);

    await stopServer(server);
    server = await startServer();
    const restored = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(restored.cliIntegrations.find(({ id }) => id === 'claude').enabled, false);
    const restoredChat = await (await fetch(`http://127.0.0.1:${port}/api/chat`)).json();
    assert.equal(restoredChat.agents.some(({ id }) => id === 'claude'), false);

    const gateway = await fetch(`http://127.0.0.1:${port}/api/gateway/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    assert.notEqual(gateway.status, 201);

    const started = await fetch(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, task: 'Inspect the enabled roster.' }),
    });
    assert.equal(started.status, 202, await started.text());
    await waitFor(async () => (await readFile(observed, 'utf8')) === 'codex,antigravity,opencode');
  } finally {
    await stopServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

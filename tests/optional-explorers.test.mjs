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
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolve(port)); });
});
const waitFor = async (probe, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe().catch(() => null); if (value) return value; await wait(40); }
  throw new Error('Timed out waiting for optional explorer state.');
};

test('OpenClaw and Hermes are installed but opt-in, persisted privately, and passed only to new workflows', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-optional-explorers-'));
  const home = path.join(temporary, 'home');
  const bin = path.join(home, '.local', 'bin');
  const runsDir = path.join(temporary, 'runs');
  const workspace = path.join(temporary, 'workspace');
  const observed = path.join(temporary, 'optional.txt');
  const workflow = path.join(temporary, 'workflow.command');
  const port = await availablePort();
  let server;
  try {
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(runsDir), mkdir(workspace)]);
    for (const name of ['codex', 'agy', 'openclaw', 'hermes']) {
      const binary = path.join(bin, name);
      await writeFile(binary, `#!/bin/bash\nprintf '${name} 1.0\\n'\n`);
      await chmod(binary, 0o700);
    }
    const opencode = path.join(bin, 'opencode');
    await writeFile(opencode, `#!/bin/bash\nif [ "$1" = models ]; then printf 'opencode/deepseek-v4-flash-free\\n'; else printf 'opencode 1.0\\n'; fi\n`);
    await chmod(opencode, 0o700);
    await writeFile(workflow, `#!/bin/bash\nprintf '%s' "$MOA_OPTIONAL_EXPLORERS" > "${observed}"\n`);
    await chmod(workflow, 0o700);

    server = spawn(process.execPath, ['server.mjs'], { cwd: projectRoot, env: { ...process.env, HOME: home, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_WORKFLOW_SCRIPT: workflow }, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
    const initial = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.deepEqual(initial.optionalExplorers.map(({ id, available, enabled }) => ({ id, available, enabled })), [
      { id: 'openclaw', available: true, enabled: false },
      { id: 'hermes', available: true, enabled: false },
    ]);

    for (const id of ['openclaw', 'hermes']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/optional-explorers/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
      assert.equal(response.status, 200, await response.text());
    }
    const config = path.join(home, '.MoA', 'optional-explorers.json');
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { schemaVersion: 1, openclaw: true, hermes: true });
    assert.equal((await stat(config)).mode & 0o777, 0o600);

    const started = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, task: 'Inspect independently.' }) });
    assert.equal(started.status, 202, await started.text());
    await waitFor(async () => (await readFile(observed, 'utf8')) === 'openclaw,hermes');
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await rm(temporary, { recursive: true, force: true });
  }
});

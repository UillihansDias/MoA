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
  throw new Error('Timed out waiting for attachment persistence.');
};
const upload = async (port, name, body, type = 'application/octet-stream') => {
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, { method: 'POST', headers: { 'content-type': type, 'x-moa-file-name': encodeURIComponent(name) }, body });
  return { status: response.status, body: await response.json() };
};

test('documents and images are validated, privately staged, and imported into the new run', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-attachments-'));
  const runsDir = path.join(temporary, 'runs');
  const uploadsDir = path.join(temporary, 'uploads');
  const workspace = path.join(temporary, 'workspace');
  const mockWorkflow = path.join(temporary, 'mock-workflow.command');
  const port = await availablePort();
  let server;
  try {
    await Promise.all([mkdir(runsDir), mkdir(uploadsDir), mkdir(workspace)]);
    await writeFile(mockWorkflow, `#!/bin/bash
run_dir="$MOA_RUNS_DIR/attachment_test"
mkdir -p "$run_dir/attachments"
printf '%s\n' "$2" > "$run_dir/workspace.txt"
printf '%s\n' "$3" > "$run_dir/task.txt"
cp -R "$4/files/." "$run_dir/attachments/"
cp "$4/attachments.json" "$run_dir/attachments.json"
rm -rf "$4"
printf 'MOA_RUN_DIR=%s\n' "$run_dir"
`);
    await chmod(mockWorkflow, 0o700);
    server = spawn(process.execPath, ['server.mjs'], { cwd: projectRoot, env: { ...process.env, MOA_PORT: String(port), MOA_RUNS_DIR: runsDir, MOA_UPLOADS_DIR: uploadsDir, MOA_WORKFLOW_SCRIPT: mockWorkflow, MOA_MAX_ATTACHMENT_BYTES: '1024' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);

    assert.equal((await upload(port, 'unsafe.command', 'echo unsafe')).status, 415);
    assert.equal((await upload(port, 'too-large.pdf', Buffer.alloc(1025), 'application/pdf')).status, 413);

    const document = await upload(port, 'requirements.md', '# Requirements\nPreserve behavior.\n', 'text/markdown');
    const image = await upload(port, 'reference.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png');
    assert.equal(document.status, 201);
    assert.equal(image.status, 201);
    assert.match(document.body.attachment.sha256, /^[0-9a-f]{64}$/);

    const invalidRun = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, task: 'Use the attached context.', attachmentIds: ['not-an-id'] }) });
    assert.equal(invalidRun.status, 400);

    const start = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, task: 'Use the attached context.', attachmentIds: [document.body.attachment.id, image.body.attachment.id] }) });
    assert.equal(start.status, 202, await start.text());
    const runDir = path.join(runsDir, 'attachment_test');
    await waitFor(() => stat(path.join(runDir, 'attachments.json')));
    const manifest = JSON.parse(await readFile(path.join(runDir, 'attachments.json'), 'utf8'));
    assert.deepEqual(manifest.attachments.map(({ storedName }) => storedName), ['requirements.md', 'reference.png']);
    assert.equal(await readFile(path.join(runDir, 'attachments', 'requirements.md'), 'utf8'), '# Requirements\nPreserve behavior.\n');
    assert.deepEqual(await readFile(path.join(runDir, 'attachments', 'reference.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await assert.rejects(stat(path.join(uploadsDir, document.body.attachment.id)));
    await assert.rejects(stat(path.join(uploadsDir, image.body.attachment.id)));

    const removable = await upload(port, 'remove-me.txt', 'temporary', 'text/plain');
    const removed = await fetch(`http://127.0.0.1:${port}/api/attachments/${removable.body.attachment.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    await assert.rejects(stat(path.join(uploadsDir, removable.body.attachment.id)));
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await rm(temporary, { recursive: true, force: true });
  }
});

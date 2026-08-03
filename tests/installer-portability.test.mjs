import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

test('installer and native launcher resolve the current user home without a fixed username', async () => {
  const [installer, builder, service, swiftSource] = await Promise.all([
    readFile(path.join(root, 'install.sh'), 'utf8'),
    readFile(path.join(root, 'build-macos-app.sh'), 'utf8'),
    readFile(path.join(root, 'service-manager.sh'), 'utf8'),
    readFile(path.join(root, 'macos', 'MoAApp.swift'), 'utf8'),
  ]);

  for (const source of [installer, builder, service, swiftSource]) {
    assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+\//);
  }
  assert.match(installer, /INSTALL_DIR="\$HOME_DIR\/\.MoA"/);
  assert.match(installer, /add_to_dock/);
  assert.match(installer, /--delete[\s\S]*--checksum/);
  assert.match(installer, /--exclude 'chat-sessions\/'/);
  assert.match(installer, /--exclude 'tmp\/'/);
  assert.match(service, /install\) restart_service/);
  assert.match(builder, /ARCH="\$\(uname -m\)"/);
  assert.match(builder, /arm64\|x86_64/);
  assert.match(swiftSource, /homeDirectoryForCurrentUser/);
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const runServiceManager = (home, command, statusUrl, fakeBin, launchctlLog) => new Promise((resolve, reject) => {
  const child = spawn(path.join(root, 'service-manager.sh'), [command], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
      MOA_STATUS_URL: statusUrl,
      MOA_TEST_LAUNCHCTL_LOG: launchctlLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`service-manager.sh ${command} exited with ${code}: ${stderr}`));
  });
});

test('install restarts a healthy service while start leaves it running', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moa-service-manager-'));
  const home = path.join(temporary, 'home');
  const appDir = path.join(home, '.MoA');
  const fakeBin = path.join(temporary, 'bin');
  const launchctlLog = path.join(temporary, 'launchctl.log');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  try {
    const address = await listen(server);
    await Promise.all([
      mkdir(path.join(appDir, 'macos'), { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
    ]);
    await writeFile(path.join(appDir, 'macos', 'com.uillihansdias.moa-webui.plist'), '<plist/>');
    const fakeLaunchctl = path.join(fakeBin, 'launchctl');
    await writeFile(fakeLaunchctl, `#!/bin/bash
printf '%s\n' "$*" >> "$MOA_TEST_LAUNCHCTL_LOG"
if [ "\${1:-}" = "print" ]; then
  printf 'path = %s/Library/LaunchAgents/com.uillihansdias.moa-webui.plist\n' "$HOME"
fi
`);
    await chmod(fakeLaunchctl, 0o700);
    const statusUrl = `http://127.0.0.1:${address.port}`;

    await runServiceManager(home, 'install', statusUrl, fakeBin, launchctlLog);
    assert.match(await readFile(launchctlLog, 'utf8'), /kickstart -k gui\/\d+\/com\.uillihansdias\.moa-webui/);

    await writeFile(launchctlLog, '');
    await runServiceManager(home, 'start', statusUrl, fakeBin, launchctlLog);
    assert.doesNotMatch(await readFile(launchctlLog, 'utf8'), /kickstart/);
  } finally {
    await close(server).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

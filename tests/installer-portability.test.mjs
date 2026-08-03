import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

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
  assert.match(installer, /--exclude 'chat-sessions\/'/);
  assert.match(installer, /--exclude 'tmp\/'/);
  assert.match(builder, /ARCH="\$\(uname -m\)"/);
  assert.match(builder, /arm64\|x86_64/);
  assert.match(swiftSource, /homeDirectoryForCurrentUser/);
});

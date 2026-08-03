import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

if (process.platform === 'darwin') {
  const packageRoot = path.resolve(import.meta.dirname, '..', 'node_modules', 'node-pty');
  const helpers = [
    path.join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ];
  for (const helper of helpers) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';

process.umask(0o077);

const [, , idleValue, runtimeValue, logPath, watchPath, mode, ...command] = process.argv;
const idleMs = Number(idleValue);
const maxRuntimeMs = Number(runtimeValue);

if (!command.length || !Number.isFinite(idleMs) || idleMs <= 0 || !Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0 || !logPath) {
  console.error('Usage: stage-runner.mjs <idle-ms> <max-runtime-ms> <log-path> <watch-path|-> <truncate|append> <command> [arguments…]');
  process.exit(2);
}

const activitySignature = () => [logPath, watchPath === '-' ? null : watchPath]
  .filter(Boolean)
  .map((file) => {
    try {
      const stat = statSync(file);
      return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return 'missing';
    }
  })
  .join('|');

const logFd = openSync(logPath, mode === 'append' ? 'a' : 'w', 0o600);
const stdoutPath = process.env.MOA_STAGE_STDOUT_PATH || '';
const stdoutFd = stdoutPath ? openSync(stdoutPath, mode === 'append' ? 'a' : 'w', 0o600) : logFd;
const startedAt = Date.now();
let lastActivityAt = startedAt;
let signature = activitySignature();
let terminationReason = null;
let forceTimer = null;
let settled = false;

const child = spawn(command[0], command.slice(1), {
  detached: true,
  stdio: ['ignore', stdoutFd, logFd],
});

const killGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already stopped. */ } }
};

const terminate = (reason) => {
  if (terminationReason || settled) return;
  terminationReason = reason;
  console.error(`[MoA] ${reason === 'idle_timeout' ? 'Stage inactivity limit reached' : 'Stage maximum runtime reached'}; stopping process group ${child.pid}.`);
  killGroup('SIGTERM');
  forceTimer = setTimeout(() => killGroup('SIGKILL'), 5_000);
};

const pollInterval = Math.max(100, Math.min(1_000, Math.floor(idleMs / 4)));
const watchdog = setInterval(() => {
  const nextSignature = activitySignature();
  if (nextSignature !== signature) {
    signature = nextSignature;
    lastActivityAt = Date.now();
  }
  const now = Date.now();
  if (now - startedAt >= maxRuntimeMs) terminate('maximum_runtime');
  else if (now - lastActivityAt >= idleMs) terminate('idle_timeout');
}, pollInterval);

const forwardSignal = (signal) => {
  if (!terminationReason) terminationReason = signal === 'SIGTERM' ? 'terminated' : 'interrupted';
  killGroup(signal);
};
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
process.once('SIGINT', () => forwardSignal('SIGINT'));

child.once('error', (error) => {
  console.error(`[MoA] Unable to launch stage command: ${error.message}`);
});

child.once('close', (code, signal) => {
  settled = true;
  clearInterval(watchdog);
  clearTimeout(forceTimer);
  if (stdoutFd !== logFd) closeSync(stdoutFd);
  closeSync(logFd);
  if (terminationReason === 'idle_timeout') process.exit(124);
  if (terminationReason === 'maximum_runtime') process.exit(125);
  if (terminationReason) process.exit(128);
  if (signal) process.exit(128);
  process.exit(Number.isInteger(code) ? code : 1);
});

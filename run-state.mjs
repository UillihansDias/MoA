import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const RUN_SCHEMA_VERSION = 2;
export const SUPPORTED_RUN_SCHEMA_VERSIONS = Object.freeze([1, RUN_SCHEMA_VERSION]);
const MAX_HASH_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_PATHS = 200;
const HASH_CONCURRENCY = 4;
const STAGES = ['initialize', 'plan', 'explore', 'consolidate', 'judge', 'execute', 'verify'];
const TERMINAL_STAGE_STATUSES = new Set(['complete', 'failed', 'blocked', 'skipped']);
const PRE_EXECUTION_STAGES = ['initialize', 'plan', 'explore', 'consolidate', 'judge'];
const EXECUTION_FOOTPRINT_NAMES = new Set([
  'execution.status.json',
  'execution.md',
  'verification.md',
  'git-pre-execution.json',
  'git-after-execution.json',
  'workspace-change-ledger.json',
]);
const EXECUTION_FOOTPRINT_PATTERN = /^(?:execution|verification|correction|judge-(?:blocked|revision|correction))(?:[.-]|$)/;

export const STAGE_CAPABILITIES = Object.freeze({
  initialize: { workspace: 'read-only', purpose: 'Validate the workspace and establish the run contract.' },
  plan: { workspace: 'read-only', purpose: 'Produce the investigation brief and success criteria.' },
  explore: { workspace: 'read-only', isolation: 'independent', purpose: 'Collect independent evidence without cross-talk.' },
  consolidate: { workspace: 'read-only', evidence: 'read-only', purpose: 'Normalize evidence without deciding.' },
  judge: { workspace: 'read-only', evidence: 'read-only', purpose: 'Produce one execution plan.' },
  execute: { workspace: 'workspace-write', plan: 'read-only', purpose: 'Apply only the judge-produced plan.' },
  verify: { workspace: 'read-only', executionRecord: 'untrusted', purpose: 'Verify independently against the original criteria.' },
});

const nowIso = () => new Date().toISOString();

export const normalizeRunManifest = (manifest, runName) => {
  if (!manifest || typeof manifest !== 'object' || !SUPPORTED_RUN_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) return null;
  if (manifest.runName && manifest.runName !== runName) return null;
  const revision = Number.isInteger(manifest.revision) && manifest.revision > 0 ? manifest.revision : 1;
  const runId = typeof manifest.runId === 'string' && manifest.runId ? manifest.runId : runName;
  const rootRunId = typeof manifest.rootRunId === 'string' && manifest.rootRunId ? manifest.rootRunId : runId;
  if (manifest.schemaVersion === RUN_SCHEMA_VERSION && (!manifest.runId || !manifest.rootRunId || !Number.isInteger(manifest.revision) || manifest.revision < 1)) return null;
  return { ...manifest, runName, runId, rootRunId, revision, parentRunId: manifest.parentRunId || null };
};

export const evaluateExecutionEligibility = ({ manifest, runName, judge = '', artifactNames = [] }) => {
  const normalized = normalizeRunManifest(manifest, runName);
  if (!normalized) return { eligible: false, code: 'invalid_run_manifest', reason: 'The run manifest is missing, incompatible, or corrupted.' };
  if (normalized.state !== 'awaiting_execution') {
    return { eligible: false, code: 'run_not_awaiting_execution', reason: 'The run is not awaiting its first execution attempt.' };
  }

  const footprint = artifactNames.find((name) => EXECUTION_FOOTPRINT_NAMES.has(name) || EXECUTION_FOOTPRINT_PATTERN.test(name));
  if (footprint) {
    return { eligible: false, code: 'run_already_attempted', reason: `The run already contains execution evidence (${footprint}).` };
  }
  if (typeof judge !== 'string' || !judge.trim()) {
    return { eligible: false, code: 'judge_not_complete', reason: 'The run does not contain a non-empty judge-produced execution plan.' };
  }

  const executeStatus = normalized.stages?.execute?.status;
  const verifyStatus = normalized.stages?.verify?.status;
  if ((executeStatus && executeStatus !== 'pending') || (verifyStatus && verifyStatus !== 'pending')) {
    return { eligible: false, code: 'run_already_attempted', reason: 'Execute and Verify must not already be running or terminal.' };
  }

  if (normalized.schemaVersion === RUN_SCHEMA_VERSION) {
    if (normalized.stages?.judge?.status !== 'complete' || PRE_EXECUTION_STAGES.some((stage) => normalized.stages?.[stage]?.status !== 'complete')) {
      return { eligible: false, code: 'judge_not_complete', reason: 'All required stages through Judge must be complete.' };
    }
    if (executeStatus !== 'pending' || verifyStatus !== 'pending') {
      return { eligible: false, code: 'run_already_attempted', reason: 'Execute and Verify must both be pending.' };
    }
  } else {
    const contradictoryEarlierStage = PRE_EXECUTION_STAGES.some((stage) => {
      const status = normalized.stages?.[stage]?.status;
      return status && status !== 'complete';
    });
    if (contradictoryEarlierStage) {
      return { eligible: false, code: 'judge_not_complete', reason: 'Legacy stage metadata contradicts Judge completion.' };
    }
  }

  return { eligible: true, code: null, reason: null };
};

const atomicWriteJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
};

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const baseManifest = async (runDir) => ({
  schemaVersion: RUN_SCHEMA_VERSION,
  harness: 'MoA',
  runName: path.basename(runDir),
  runId: path.basename(runDir),
  parentRunId: null,
  rootRunId: path.basename(runDir),
  revision: 1,
  workspace: (await fs.readFile(path.join(runDir, 'workspace.txt'), 'utf8').catch(() => '')).trim(),
  taskFile: 'task.txt',
  state: 'running',
  currentStage: 'initialize',
  createdAt: nowIso(),
  updatedAt: nowIso(),
  capabilities: STAGE_CAPABILITIES,
  environment: { clis: [] },
  stages: Object.fromEntries(STAGES.map((stage) => [stage, { status: stage === 'initialize' ? 'running' : 'pending' }])),
  git: {},
  artifacts: {},
});

export const ensurePrivateRunStorage = async (runsDir) => {
  await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runsDir, 0o700);
};

export const readRunManifest = async (runDir) => readJson(path.join(runDir, 'run.json'));

export const updateRunManifest = async (runDir, update) => {
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const manifestPath = path.join(runDir, 'run.json');
  const [existing, manifestStat] = await Promise.all([
    readRunManifest(runDir),
    fs.stat(manifestPath).catch(() => null),
  ]);
  const normalized = existing ? normalizeRunManifest(existing, path.basename(runDir)) : null;
  if (manifestStat && !normalized) throw new Error('The run manifest is incompatible or corrupted.');
  const current = normalized ? { ...normalized, schemaVersion: RUN_SCHEMA_VERSION } : await baseManifest(runDir);
  const patch = typeof update === 'function' ? await update(current) : update;
  const next = { ...current, ...patch, schemaVersion: RUN_SCHEMA_VERSION, updatedAt: nowIso() };
  await atomicWriteJson(manifestPath, next);
  return next;
};

export const appendRunEvent = async (runDir, event) => {
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const entry = { timestamp: nowIso(), ...event };
  const file = path.join(runDir, 'events.jsonl');
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
  return entry;
};

const probeBinary = async (name) => {
  try {
    const { stdout } = await execFileAsync(name, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
    return { name, available: true, version: stdout.trim().split('\n')[0] || 'unknown' };
  } catch (error) {
    return { name, available: false, version: error?.killed ? 'version check timed out' : 'not found' };
  }
};

export const initializeRun = async (runDir, workspace) => {
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const optionalExplorers = String(process.env.MOA_OPTIONAL_EXPLORERS || '').split(',').filter((name) => ['openclaw', 'hermes'].includes(name));
  const clis = await Promise.all(['codex', 'agy', 'opencode', ...optionalExplorers].map(probeBinary));
  const createdAt = nowIso();
  const manifest = {
    ...(await baseManifest(runDir)),
    workspace,
    createdAt,
    updatedAt: createdAt,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      clis,
      enforcement: {
        codex: 'CLI read-only sandbox',
        antigravity: 'CLI sandbox',
        opencode: `Primary OpenCode explorer using ${process.env.MOA_OPENCODE_MODEL || 'opencode/deepseek-v4-flash-free'} with ${process.env.MOA_OPENCODE_FALLBACK_MODEL || 'opencode/mimo-v2.5-free'} as a bounded fallback; enforcement depends on the local OpenCode agent policy`,
        ...(optionalExplorers.includes('openclaw') ? { openclaw: 'Optional independent OpenClaw local agent; prompt-scoped read-only policy with no delivery or delegation' } : {}),
        ...(optionalExplorers.includes('hermes') ? { hermes: 'Optional independent Hermes one-shot agent; project rules and memory excluded, prompt-scoped read-only policy with no delegation' } : {}),
      },
      optionalExplorers,
    },
  };
  await atomicWriteJson(path.join(runDir, 'run.json'), manifest);
  await appendRunEvent(runDir, { type: 'run', stage: 'initialize', status: 'running', detail: 'Run contract created.' });
  await captureGitState(runDir, workspace, 'intake');
  return manifest;
};

export const updateRunStage = async (runDir, stage, status, detail = '') => {
  if (!STAGES.includes(stage)) throw new Error(`Unknown MoA stage: ${stage}`);
  const timestamp = nowIso();
  const manifest = await updateRunManifest(runDir, (current) => {
    const prior = current.stages?.[stage] || { status: 'pending' };
    const stageState = {
      ...prior,
      status,
      ...(detail ? { detail } : {}),
      ...(status === 'running' && !prior.startedAt ? { startedAt: timestamp } : {}),
      ...(TERMINAL_STAGE_STATUSES.has(status) ? { endedAt: timestamp } : {}),
    };
    return {
      currentStage: stage,
      stages: { ...current.stages, [stage]: stageState },
      state: status === 'failed' || status === 'blocked' ? 'failed' : status === 'running' ? 'running' : current.state,
    };
  });
  await appendRunEvent(runDir, { type: 'stage', stage, status, ...(detail ? { detail } : {}) });
  return manifest;
};

const git = async (workspace, args) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
    return stdout;
  } catch {
    return null;
  }
};

const sha256File = async (file, knownStat = null, hashAllowed = true) => {
  const stat = knownStat || await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const metadata = { size: stat.size, modifiedAtMs: Math.round(stat.mtimeMs) };
  if (!hashAllowed) return { ...metadata, sha256: null, hashReason: 'run hash budget exceeded' };
  if (stat.size > MAX_HASH_BYTES) return { ...metadata, sha256: null, hashReason: 'file exceeds 10 MiB hash limit' };
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return { ...metadata, sha256: hash.digest('hex') };
};

const parsePorcelain = (buffer) => {
  if (!buffer) return [];
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length && entries.length < MAX_TRACKED_PATHS; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const entry = { code, path: record.slice(3) };
    if (/[RC]/.test(code) && records[index + 1]) entry.originalPath = records[++index];
    entries.push(entry);
  }
  return entries;
};

const hydrateHashes = async (workspace, entries) => {
  let reservedBytes = 0;
  const pending = [];
  for (const entry of entries) {
    const absolute = path.resolve(workspace, entry.path);
    const withinWorkspace = absolute === workspace || absolute.startsWith(`${workspace}${path.sep}`);
    const stat = withinWorkspace ? await fs.stat(absolute).catch(() => null) : null;
    const hashAllowed = Boolean(stat?.isFile() && stat.size <= MAX_HASH_BYTES && reservedBytes + stat.size <= MAX_TOTAL_HASH_BYTES);
    if (hashAllowed) reservedBytes += stat.size;
    pending.push({ entry, absolute, stat, withinWorkspace, hashAllowed });
  }
  const results = new Array(pending.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = cursor++;
      const item = pending[index];
      results[index] = { ...item.entry, file: item.withinWorkspace ? await sha256File(item.absolute, item.stat, item.hashAllowed) : null };
    }
  }));
  return results;
};

const buildLedger = (before, after) => {
  if (!before?.repository || !after?.repository) return null;
  const beforeByPath = new Map(before.status.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.status.map((entry) => [entry.path, entry]));
  const added = after.status.filter((entry) => !beforeByPath.has(entry.path));
  const removed = before.status.filter((entry) => !afterByPath.has(entry.path));
  const changed = after.status.filter((entry) => {
    const prior = beforeByPath.get(entry.path);
    return prior && (prior.code !== entry.code || prior.file?.sha256 !== entry.file?.sha256 || prior.file?.size !== entry.file?.size || prior.file?.modifiedAtMs !== entry.file?.modifiedAtMs);
  });
  return {
    capturedAt: nowIso(),
    headChanged: before.head !== after.head,
    added,
    changed,
    removed,
    preExistingPaths: before.status.map((entry) => entry.path),
    finalPaths: after.status.map((entry) => entry.path),
  };
};

export const inspectGitState = async (workspace, label = 'inspection') => {
  const rootBuffer = await git(workspace, ['rev-parse', '--show-toplevel']);
  const repository = Boolean(rootBuffer);
  let state = { schemaVersion: 1, label, capturedAt: nowIso(), workspace, repository };
  if (repository) {
    const [head, branch, status] = await Promise.all([
      git(workspace, ['rev-parse', 'HEAD']),
      git(workspace, ['branch', '--show-current']),
      git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const rawStatusRecords = status ? status.toString('utf8').split('\0').filter(Boolean) : [];
    state = {
      ...state,
      root: rootBuffer.toString('utf8').trim(),
      head: head?.toString('utf8').trim() || null,
      branch: branch?.toString('utf8').trim() || null,
      status: await hydrateHashes(workspace, parsePorcelain(status)),
      statusTruncated: rawStatusRecords.length > MAX_TRACKED_PATHS,
    };
  }
  return state;
};

const gitEntryFingerprint = (entry) => JSON.stringify({ code: entry.code, path: entry.path, originalPath: entry.originalPath || null, sha256: entry.file?.sha256 || null, size: entry.file?.size ?? null });

export const compareGitStates = (parent, current) => {
  if (!parent || !current) return { detected: true, severity: 'substantial', reason: 'Git evidence is missing or unreadable.', headChanged: null, changedPaths: [] };
  if (Boolean(parent.repository) !== Boolean(current.repository)) return { detected: true, severity: 'substantial', reason: 'The workspace repository boundary changed.', headChanged: null, changedPaths: [] };
  if (!parent.repository && !current.repository) return { detected: false, severity: 'unavailable', reason: 'The workspace is not a Git repository; repository drift cannot be measured.', headChanged: null, changedPaths: [] };
  if (parent.root && current.root && path.resolve(parent.root) !== path.resolve(current.root)) return { detected: true, severity: 'substantial', reason: 'The Git repository root changed.', headChanged: true, changedPaths: [] };

  const parentEntries = new Map((parent.status || []).map((entry) => [entry.path, gitEntryFingerprint(entry)]));
  const currentEntries = new Map((current.status || []).map((entry) => [entry.path, gitEntryFingerprint(entry)]));
  const paths = new Set([...parentEntries.keys(), ...currentEntries.keys()]);
  const changedPaths = [...paths].filter((entryPath) => parentEntries.get(entryPath) !== currentEntries.get(entryPath)).sort().slice(0, MAX_TRACKED_PATHS);
  const headChanged = Boolean(parent.head && current.head && parent.head !== current.head);
  const branchChanged = Boolean(parent.branch && current.branch && parent.branch !== current.branch);
  const truncated = Boolean(parent.statusTruncated || current.statusTruncated);
  const detected = headChanged || branchChanged || truncated || changedPaths.length > 0;
  const substantial = headChanged || branchChanged || truncated || changedPaths.length > 5;
  return {
    detected,
    severity: detected ? substantial ? 'substantial' : 'warning' : 'none',
    reason: !detected ? 'The workspace matches the parent run’s final Git evidence.' : substantial ? 'The workspace changed materially after the parent run.' : 'The workspace has limited changes after the parent run.',
    headChanged,
    branchChanged,
    changedPathCount: changedPaths.length,
    changedPaths,
    parentHead: parent.head || null,
    currentHead: current.head || null,
  };
};

export const captureGitState = async (runDir, workspace, label) => {
  const state = await inspectGitState(workspace, label);
  const fileName = `git-${label}.json`;
  await atomicWriteJson(path.join(runDir, fileName), state);
  await updateRunManifest(runDir, (current) => ({ git: { ...current.git, [label]: fileName } }));
  if (label === 'after-execution') {
    const before = await readJson(path.join(runDir, 'git-pre-execution.json'));
    const ledger = buildLedger(before, state);
    if (ledger) {
      await atomicWriteJson(path.join(runDir, 'workspace-change-ledger.json'), ledger);
      await updateRunManifest(runDir, (current) => ({ git: { ...current.git, changeLedger: 'workspace-change-ledger.json' } }));
    }
  }
  return state;
};

export const recoverInterruptedContinuations = async (runsDir) => {
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const interrupted = entries.filter((entry) => entry.isDirectory() && /^\.continuation-[0-9A-Za-z_-]+\.tmp$/.test(entry.name));
  await Promise.all(interrupted.map((entry) => fs.rm(path.join(runsDir, entry.name), { recursive: true, force: true })));
  return interrupted.map((entry) => entry.name);
};

export const createContinuationRun = async ({ runsDir, runName, runId, parentRunId, rootRunId, revision, parentRunName, workspace, originalObjective, instruction, mode, inheritedFrom, inheritedContext, drift, latestParentStage }) => {
  const finalDir = path.join(runsDir, runName);
  const temporaryDir = path.join(runsDir, `.continuation-${runName}.tmp`);
  if (await fs.stat(finalDir).catch(() => null)) throw new Error('The continuation run already exists.');
  await fs.rm(temporaryDir, { recursive: true, force: true });
  await fs.mkdir(temporaryDir, { recursive: false, mode: 0o700 });
  try {
    const resumedAt = nowIso();
    const manifest = {
      ...(await baseManifest(temporaryDir)),
      schemaVersion: RUN_SCHEMA_VERSION,
      runName,
      runId,
      parentRunId,
      rootRunId,
      revision,
      workspace,
      state: 'continuation_created',
      currentStage: 'initialize',
      createdAt: resumedAt,
      updatedAt: resumedAt,
      resumedAt,
      resumeInstruction: instruction,
      inheritedFrom,
      continuation: { mode, startingStage: 'plan', parentRunName, latestParentStage, workspaceDrift: drift },
    };
    const events = [
      { timestamp: resumedAt, type: 'resume_requested', parentRunId, instruction, mode },
      { timestamp: resumedAt, type: 'parent_context_loaded', parentRunId, inheritedArtifacts: Object.keys(inheritedFrom) },
      { timestamp: resumedAt, type: 'workspace_drift_checked', ...drift },
      { timestamp: resumedAt, type: 'continuation_created', runId, parentRunId, rootRunId, revision },
    ];
    await Promise.all([
      atomicWriteJson(path.join(temporaryDir, 'run.json'), manifest),
      atomicWriteJson(path.join(temporaryDir, 'inherited-context.json'), { parentRunId, rootRunId, parentRunName, latestParentStage, inheritedFrom, drift }),
      fs.writeFile(path.join(temporaryDir, 'workspace.txt'), `${workspace}\n`, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(path.join(temporaryDir, 'task.txt'), `${instruction}\n`, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(path.join(temporaryDir, 'original-objective.txt'), `${originalObjective}\n`, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(path.join(temporaryDir, 'resume-instruction.txt'), `${instruction}\n`, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(path.join(temporaryDir, 'continuation-context.md'), inheritedContext, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(path.join(temporaryDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 }),
    ]);
    await fs.rename(temporaryDir, finalDir);
    await fs.chmod(finalDir, 0o700);
    const latestTemporary = path.join(runsDir, `.latest.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(latestTemporary, `${finalDir}\n`, { encoding: 'utf8', mode: 0o600 })
      .then(() => fs.rename(latestTemporary, path.join(runsDir, '.latest')))
      .catch(() => fs.rm(latestTemporary, { force: true }));
    return { runDir: finalDir, manifest };
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

const collectArtifacts = async (runDir) => {
  const names = await fs.readdir(runDir).catch(() => []);
  const candidates = names.filter((name) => /\.(md|log|json|jsonl|status|txt)$/.test(name) && name !== 'run.json').sort();
  let reservedBytes = 0;
  const entries = [];
  for (const name of candidates) {
    const file = path.join(runDir, name);
    const stat = await fs.stat(file).catch(() => null);
    const hashAllowed = Boolean(stat?.isFile() && stat.size <= MAX_HASH_BYTES && reservedBytes + stat.size <= MAX_TOTAL_HASH_BYTES);
    if (hashAllowed) reservedBytes += stat.size;
    entries.push([name, await sha256File(file, stat, hashAllowed)]);
  }
  return Object.fromEntries(entries.filter(([, value]) => value));
};

export const refreshRunArtifacts = async (runDir) => {
  const existing = await readRunManifest(runDir);
  const normalized = normalizeRunManifest(existing, path.basename(runDir));
  if (!normalized) throw new Error('The run manifest is incompatible or corrupted.');
  const artifacts = await collectArtifacts(runDir);
  const manifest = { ...normalized, artifacts, updatedAt: nowIso() };
  await atomicWriteJson(path.join(runDir, 'run.json'), manifest);
  return manifest;
};

export const finalizeRun = async (runDir, state, reason = null) => {
  const before = await readRunManifest(runDir);
  const normalizedBefore = normalizeRunManifest(before, path.basename(runDir));
  if (!normalizedBefore) throw new Error('The run manifest is incompatible or corrupted.');
  if (normalizedBefore.endedAt && ['completed', 'failed'].includes(normalizedBefore.state)) {
    if (normalizedBefore.state !== state || (normalizedBefore.reason || null) !== reason) {
      throw new Error('A terminal run cannot be finalized with a different outcome.');
    }
    return refreshRunArtifacts(runDir);
  }
  await appendRunEvent(runDir, { type: 'run', status: state, ...(reason ? { reason } : {}) });
  const artifacts = await collectArtifacts(runDir);
  const existing = await readRunManifest(runDir);
  const normalized = normalizeRunManifest(existing, path.basename(runDir));
  if (!normalized) throw new Error('The run manifest is incompatible or corrupted.');
  const manifest = {
    ...normalized,
    state,
    reason,
    endedAt: state === 'awaiting_execution' ? undefined : nowIso(),
    artifacts,
    updatedAt: nowIso(),
  };
  await atomicWriteJson(path.join(runDir, 'run.json'), manifest);
  return manifest;
};

const main = async () => {
  const [command, runDir, ...args] = process.argv.slice(2);
  if (!command || !runDir) throw new Error('Usage: run-state.mjs <command> <run-directory> [...arguments]');
  if (command === 'ensure-storage') return ensurePrivateRunStorage(runDir);
  if (command === 'init') return initializeRun(runDir, args[0] || '');
  if (command === 'stage') return updateRunStage(runDir, args[0], args[1], args[2] || '');
  if (command === 'capture-git') return captureGitState(runDir, args[0], args[1]);
  if (command === 'refresh-artifacts') return refreshRunArtifacts(runDir);
  if (command === 'finalize') return finalizeRun(runDir, args[0], args[1] || null);
  throw new Error(`Unknown run-state command: ${command}`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

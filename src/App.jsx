import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_RESUME_DRAFT, groupProjectRuns, readResumeDraft, writeResumeDraft } from './resume-state.js';

const EmbeddedTerminal = lazy(() => import('./EmbeddedTerminal.jsx'));
const ChatSession = lazy(() => import('./ChatSession.jsx'));

const Icon = ({ name, size = 18 }) => {
  const paths = {
    play: <><path d="M8 5v14l11-7z" /></>,
    runs: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="2.5" cy="6" r=".5" fill="currentColor" /><circle cx="2.5" cy="12" r=".5" fill="currentColor" /><circle cx="2.5" cy="18" r=".5" fill="currentColor" /></>,
    network: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="m10.5 7-4 8.7M13.5 7l4 8.7M7.5 18h9" /></>,
    mixture: <><path d="M12 4 4.5 18h15Z" strokeDasharray="1 2.6" /><circle cx="12" cy="4" r="1.8" fill="currentColor" /><circle cx="4.5" cy="18" r="1.8" fill="currentColor" /><circle cx="19.5" cy="18" r="1.8" fill="currentColor" /></>,
    terminal: <><path d="m4 6 5 5-5 5M11 18h9" /></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></>,
    moon: <><path d="M20 15.2A8.5 8.5 0 1 1 8.8 4 7 7 0 0 0 20 15.2z" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></>,
    system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    arrow: <><path d="m9 18 6-6-6-6" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    stop: <><rect x="6" y="6" width="12" height="12" rx="2" /></>,
    x: <><path d="M6 6l12 12M18 6 6 18" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></>,
    paperclip: <><path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    file: <><path d="M7 3h7l4 4v14H7zM14 3v5h5" /></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const Stage = ({ index, label, caption, state }) => (
  <div className={`stage ${state}`} aria-label={`${label}: ${state === 'done' ? 'complete' : state || 'pending'}`}>
    <span className="stage-number">{state === 'done' ? <Icon name="check" size={14} /> : state === 'failed' ? '!' : state === 'skipped' ? '–' : index}</span>
    <span><strong>{label}</strong><small>{caption}</small></span>
  </div>
);

const RunItem = memo(function RunItem({ run, selected, onSelect, onResume = null, deletionSelected = false, onToggleDelete = null }) {
  const state = run.judged ? 'done' : run.experts > 0 ? 'partial' : 'idle';
  return (
    <div className={`run-item ${selected ? 'selected' : ''} ${deletionSelected ? 'marked' : ''}`}>
      {onToggleDelete ? (
        <button className={`run-selector ${state}`} onClick={() => onToggleDelete(run)} aria-label={`${deletionSelected ? 'Unselect' : 'Select'} ${run.task || 'untitled run'} for deletion`} aria-pressed={deletionSelected}>
          {deletionSelected ? <Icon name="check" size={12} /> : state === 'done' ? <Icon name="check" size={11} /> : null}
        </button>
      ) : <span className={`run-state ${state}`}>{state === 'done' ? <Icon name="check" size={11} /> : ''}</span>}
      <button className="run-open" onClick={() => onSelect(run)}>
        <span className="run-copy"><strong>{run.task || 'Untitled run'}</strong><small>{run.workspace || 'Unknown workspace'}</small><em>Revision {run.revision || 1}{run.parentRunId ? ' · continuation' : ' · root'} · Verify: {run.verificationStatus || 'not-run'}</em></span>
        <time>{run.name.slice(11, 16).replace('-', ':')}</time>
      </button>
      {onResume ? <button className="resume-run-compact" onClick={() => onResume(run)} disabled={!run.resumeEligible} title={run.resumeIssue || 'Continue this project in a new linked run'}><Icon name="refresh" size={14} /><span>Resume</span></button> : null}
    </div>
  );
});

const ProgressBar = ({ status, value, label }) => {
  const determinate = Number.isFinite(value);
  return (
    <div className={`progress-track ${status === 'active' && !determinate ? 'indeterminate' : ''} ${status}`}>
      <progress aria-label={label} max={determinate ? 100 : undefined} value={determinate ? value : undefined} />
    </div>
  );
};

const ExpertRow = ({ expert, status, detail }) => {
  const displayStatus = status === 'ready' && expert.available === false ? 'unavailable' : status;
  const displayDetail = displayStatus === 'unavailable' ? 'CLI is not loaded or available.' : detail;
  const barStatus = displayStatus === 'failed' ? 'failed' : displayStatus === 'done' ? 'complete' : displayStatus === 'running' || displayStatus === 'responded' ? 'active' : 'pending';
  return (
  <div className={`expert-row ${expert.key}`}>
    <span className="expert-dot" />
    <span className="expert-mark">{expert.mark}</span>
    <span className="expert-copy"><strong>{expert.label}</strong><small>{displayDetail}</small><ProgressBar status={barStatus} value={displayStatus === 'done' ? 100 : undefined} label={`${expert.label} analysis`} /></span>
    <span className={`status-label ${displayStatus}`} role="status">{displayStatus === 'responded' ? 'evidence' : displayStatus}</span>
    <Icon name="arrow" size={16} />
  </div>
  );
};

const EXPLORERS = [
  { key: 'codex', systemName: 'codex', label: 'Codex', mark: 'C' },
  { key: 'antigravity', systemName: 'agy', label: 'Antigravity', mark: 'A' },
  { key: 'opencode', systemName: 'opencode', label: 'OpenCode', mark: 'OC' },
  { key: 'claude', systemName: 'claude', label: 'Claude Code', mark: 'CC' },
  { key: 'openclaw', systemName: 'openclaw', label: 'OpenClaw', mark: 'OC', optional: true },
  { key: 'hermes', systemName: 'hermes', label: 'Hermes Agent', mark: 'H', optional: true },
];
const READY_EXPERTS = Object.fromEntries(EXPLORERS.map(({ key }) => [key, { status: 'ready', detail: 'Ready for an independent pass.' }]));

const STAGE_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETE: 'complete',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  PAUSED: 'paused',
  SKIPPED: 'skipped',
};

const WORKFLOW_STAGES = [
  { id: 'initialize', label: 'Initialize', description: 'Validating the workspace and starting the conductor.' },
  { id: 'plan', label: 'Plan', description: 'Producing one investigation brief and explicit success criteria.' },
  { id: 'explore', label: 'Parallel Exploration', description: 'Running every agent independently against the same brief.' },
  { id: 'consolidate', label: 'Consolidate Evidence', description: 'Normalizing reports, deduplicating findings, and preserving disagreements without deciding.' },
  { id: 'judge', label: 'Judge', description: 'Resolving conflicts and producing one execution plan with rationale and confidence.' },
  { id: 'execute', label: 'Execute Plan', description: 'Applying only the judge-produced plan without unrelated changes.' },
  { id: 'verify', label: 'Verify', description: 'Independently checking the outcome against the original objective and constraints.' },
];

const INITIAL_STAGE_STATE = Object.fromEntries(WORKFLOW_STAGES.map(({ id }) => [id, STAGE_STATUS.PENDING]));

const cleanReportText = (value) => value.replace(/[*_`#]/g, '').replace(/^\s*[-•]\s*/, '').trim();

const parseJudgeDecision = (report = '') => {
  if (!report.trim()) return null;
  const sections = report.split(/\n(?=(?:#{1,4}\s*)?(?:\d+\.\s*)?[A-Z][^\n]{2,70}\n)/);
  const verdictSection = sections.find((section) => /(?:^|\n)(?:#{1,4}\s*)?(?:1\.\s*)?(?:Execution plan summary|Verdict)\b/i.test(section)) || report;
  const verdictLines = verdictSection.split('\n').map(cleanReportText).filter(Boolean).filter((line) => !/^(?:1\.\s*)?(?:Execution plan summary|Verdict):?$/i.test(line));
  const evidenceSection = report.match(/(?:^|\n)(?:#{1,4}\s*)?(?:2\.|3\.)?\s*(?:Rationale grounded in the consolidated evidence|Evidence and reasoning(?: behind the choice)?)\s*\n([\s\S]*?)(?=\n(?:#{1,4}\s*)?(?:3\.|4\.)?\s*(?:Confidence level|(?:Sequenced )?execution plan)\b|$)/i)?.[1] || '';
  const bulletReasons = evidenceSection.split('\n').filter((line) => /^\s*[-•]\s+/.test(line)).map(cleanReportText);
  const reasons = (bulletReasons.length ? bulletReasons : evidenceSection.split(/(?<=[.!?])\s+/).map(cleanReportText)).filter(Boolean).slice(0, 3);
  const concernsSection = report.match(/(?:^|\n)(?:#{1,4}\s*)?(?:5\.\s*)?(?:Risks|Risks, unresolved assumptions, and stop conditions)\b[^\n]*\n([\s\S]*?)(?=\n(?:#{1,4}\s*)?(?:6\.\s*)?|$)/i)?.[1] || '';
  const concerns = concernsSection.split('\n').filter((line) => /^\s*[-•]\s+/.test(line)).map(cleanReportText).filter(Boolean).slice(0, 2);
  const confidence = report.match(/confidence(?: score)?\s*[:\-]?\s*(\d{1,3})%/i)?.[1];
  return {
    verdict: verdictLines[0] || 'An execution plan has been produced.',
    reasons,
    concerns,
    confidence: confidence ? Math.min(100, Number(confidence)) : null,
  };
};

const LifecycleStage = ({ stage }) => (
  <div className={`lifecycle-stage ${stage.status}`} aria-label={`${stage.label}: ${stage.status}. ${stage.detail}`}>
    <span className="lifecycle-symbol">{stage.status === STAGE_STATUS.COMPLETE ? <Icon name="check" size={13} /> : stage.status === STAGE_STATUS.ACTIVE ? '●' : stage.status === STAGE_STATUS.PAUSED ? 'Ⅱ' : stage.status === STAGE_STATUS.FAILED ? '!' : stage.status === STAGE_STATUS.BLOCKED ? '×' : stage.status === STAGE_STATUS.SKIPPED ? '–' : '○'}</span>
    <div className="lifecycle-copy">
      <div><strong>{stage.label}</strong><span>{stage.status}</span></div>
      <ProgressBar status={stage.status} value={stage.value} label={`${stage.label} progress`} />
      <small>{stage.detail}</small>
      {stage.meta ? <em>{stage.meta}</em> : null}
    </div>
  </div>
);

const OrchestratorStatus = ({ phase }) => {
  const states = {
    intake: ['idle', 'Ready to coordinate a new workflow.'],
    initialize: ['initializing', 'Validating the workspace and starting the conductor.'],
    plan: ['planning', 'Producing the shared investigation brief and success criteria.'],
    explore: ['running', 'Agents are reasoning independently against the same brief.'],
    consolidate: ['judging', 'Normalizing evidence without selecting a solution.'],
    judge: ['judging', 'The judge is producing one execution plan.'],
    complete: ['ready', 'The execution plan is ready.'],
    execute: ['executing', 'Codex is executing only the judge-produced plan.'],
    verify: ['executing', 'A fresh verifier is independently checking the outcome.'],
    awaiting_correction_approval: ['paused', 'Verification found a bounded corrective fix and is waiting for your decision.'],
    verified: ['complete', 'Workflow execution completed successfully.'],
    failed: ['failed', 'The workflow stopped before successful completion.'],
  };
  const [status, description] = states[phase] || states.intake;
  return <section className={`orchestrator-status ${status}`}><div><span className="orchestrator-indicator" /><strong>Orchestrator</strong><b>{status}</b></div><p>{description}</p></section>;
};

const ActivityStream = ({ messages }) => {
  const visibleMessages = messages.slice(-6);
  return (
    <section className={`activity-stream ${messages.length ? 'active' : 'idle'}`} aria-label="Orchestration activity">
      <div className="monitor-section-heading"><strong>Live activity</strong><span className="activity-state"><i />{messages.length ? `${messages.length} events` : 'Standing by'}</span></div>
      <div className="activity-stream-lines" role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
        {visibleMessages.length ? visibleMessages.map((message, index) => (
          <div className={`activity-stream-line ${index === visibleMessages.length - 1 ? 'latest' : ''}`} key={`${messages.length - visibleMessages.length + index}-${message}`}>
            <span className="activity-node" aria-hidden="true" />
            <code>{message}</code>
          </div>
        )) : (
          <div className="activity-empty">
            <span className="activity-orbit" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>Ready for live events</strong><small>Workflow milestones will appear here as they happen.</small></span>
          </div>
        )}
      </div>
    </section>
  );
};

const WorkflowLifecycle = ({ stageState, expertProgress, phase, explorers, activityMessages }) => {
  const availableExplorers = explorers.filter(({ available }) => available !== false);
  const completedExplorers = availableExplorers.filter(({ key }) => expertProgress[key]?.status === 'done').length;
  const failedExplorers = availableExplorers.filter(({ key }) => expertProgress[key]?.status === 'failed').length;
  const completedStages = Object.values(stageState).filter((status) => status === STAGE_STATUS.COMPLETE).length;
  const overall = Math.round((completedStages / WORKFLOW_STAGES.length) * 100);
  const stages = WORKFLOW_STAGES.map((stage) => {
    const status = stageState[stage.id];
    const value = status === STAGE_STATUS.COMPLETE ? 100 : [STAGE_STATUS.PENDING, STAGE_STATUS.BLOCKED, STAGE_STATUS.PAUSED, STAGE_STATUS.SKIPPED].includes(status) ? 0 : stage.id === 'explore' && status === STAGE_STATUS.ACTIVE ? Math.round((completedExplorers / Math.max(availableExplorers.length, 1)) * 100) : undefined;
    const meta = stage.id === 'explore' && status !== STAGE_STATUS.PENDING ? `${completedExplorers} of ${availableExplorers.length} complete${failedExplorers ? ` · ${failedExplorers} failed` : ''}` : null;
    return { ...stage, status, value, detail: stage.description, meta };
  });
  const activeStage = stages.find(({ status }) => status === STAGE_STATUS.ACTIVE);

  return (
    <div className="workflow-lifecycle judge-evidence-monitor">
      <OrchestratorStatus phase={phase} />
      <div className="workflow-overview">
        <div><strong>Overall workflow</strong><span>{completedStages} of {WORKFLOW_STAGES.length} phases</span></div>
        <ProgressBar status={phase === 'verified' ? 'complete' : phase === 'failed' ? 'failed' : phase === 'intake' || phase === 'awaiting_correction_approval' ? 'pending' : 'active'} value={overall} label="Overall phase completion" />
        <p>{activeStage?.description || (phase === 'complete' ? 'Execution plan ready.' : phase === 'verified' ? 'Workflow independently verified.' : 'Waiting for a workflow.')}</p>
      </div>
      <div className="lifecycle-list">{stages.map((stage) => <LifecycleStage key={stage.label} stage={stage} />)}</div>
      <ActivityStream messages={activityMessages} />
    </div>
  );
};

const CorrectionApprovalCard = ({ approval, pending, onApprove, onStop }) => (
  <section className="correction-approval-card" role="region" aria-labelledby="correction-approval-title">
    <header>
      <span className="approval-status"><i />Workflow paused</span>
      <span>Corrective attempt {approval.attemptNumber}</span>
    </header>
    <h2 id="correction-approval-title">Approve the scoped verification fix?</h2>
    <div className="correction-approval-grid">
      <div><h3>What failed</h3><p>{approval.verifierSummary}</p>{approval.actionableFindings?.length ? <ul>{approval.actionableFindings.map((finding) => <li key={finding}>{finding}</li>)}</ul> : null}</div>
      <div><h3>Proposed fix and scope</h3><p>{approval.proposedCorrectionScope}</p></div>
      <div><h3>Likely affected areas</h3><p>{approval.affectedAreas?.length ? approval.affectedAreas.join(' · ') : 'The verifier could not identify exact files.'}</p></div>
      <div><h3>Recovery boundary</h3><p>{approval.judgeReevaluationMayBeRequired ? 'Judge re-evaluation may be needed only if the correction conflicts with the approved plan.' : 'The approved plan remains valid; only the corrective Executor and a fresh Verify will run.'}</p></div>
    </div>
    <div className="correction-approval-actions">
      <button onClick={onStop} disabled={pending}>Stop workflow</button>
      <button className="primary" onClick={onApprove} disabled={pending}><Icon name="check" size={16} />{pending ? 'Applying decision…' : 'Approve scoped fix'}</button>
    </div>
  </section>
);

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark', description: 'Use the dark MoA interface.', icon: 'moon' },
  { value: 'light', label: 'Light', description: 'Use the light MoA interface.', icon: 'sun' },
  { value: 'system', label: 'System', description: 'Match your macOS appearance.', icon: 'system' },
];

const COLOUR_SCHEMES = [
  { value: 'moa', label: 'MoA', colors: ['#0BC6F4', '#008EB6', '#3EE28F'], dark: '#0BC6F4', light: '#008EB6' },
  { value: 'hermes-gold', label: 'Hermes Gold', colors: ['#FFD700', '#FFBF00', '#CD7F32'], dark: '#FFD700', light: '#B8860B' },
  { value: 'ares', label: 'Ares', colors: ['#FF4444', '#CC3333', '#992222'], dark: '#FF4444', light: '#C0392B' },
  { value: 'mono', label: 'Mono', colors: ['#CCCCCC', '#999999', '#666666'], dark: '#CCCCCC', light: '#555555' },
  { value: 'slate', label: 'Slate', colors: ['#94A3B8', '#64748B', '#334155'], dark: '#94A3B8', light: '#475569' },
  { value: 'poseidon', label: 'Poseidon', colors: ['#0EA5E9', '#0284C7', '#0369A1'], dark: '#0EA5E9', light: '#0369A1' },
  { value: 'sisyphus', label: 'Sisyphus', colors: ['#A78BFA', '#8B5CF6', '#7C3AED'], dark: '#A78BFA', light: '#7C3AED' },
  { value: 'emerald', label: 'Emerald', colors: ['#6EE7B7', '#34D399', '#059669'], dark: '#34D399', light: '#059669' },
  { value: 'charizard', label: 'Charizard', colors: ['#FB923C', '#F97316', '#EA580C'], dark: '#FB923C', light: '#EA580C' },
  { value: 'sienna', label: 'Sienna', colors: ['#E0896D', '#D97757', '#9A523A'], dark: '#E0896D', light: '#D97757' },
  { value: 'catppuccin', label: 'Catppuccin', colors: ['#CBA6F7', '#B4BEFE', '#8839EF'], dark: '#CBA6F7', light: '#8839EF' },
  { value: 'nous', label: 'Nous', colors: ['#7EB6E0', '#4682B4', '#2C5F88'], dark: '#4682B4', light: '#4682B4' },
  { value: 'geist-contrast', label: 'Geist Contrast', colors: ['#000000', '#FFFFFF', '#FFF175'], dark: '#FFF175', light: '#0070F3' },
  { value: 'aurora-ink', label: 'Editorial Red', colors: ['#F2382C', '#FFF8E8', '#191816'], dark: '#FF493D', light: '#E62E25' },
];

const SCHEME_PALETTES = {
  'hermes-gold': {
    light: { bg: '#FEFCF7', title: '#FAF7F0', surface: '#F3EEE3', surface2: '#F5F0E5', line: '#E0D8C8', line2: '#C8BFAE', text: '#1A1610', muted: '#5C5344', output: '#F5F0E5' },
    dark: { bg: '#0D0D1A', title: '#141425', surface: '#1A1A2E', surface2: '#20203A', line: '#2A2A45', line2: '#484865', text: '#FFF8DC', muted: '#C0C0C0', output: '#101020' },
  },
  ares: {
    light: { bg: '#FBF8F7', title: '#F6ECEB', surface: '#FFFFFF', surface2: '#F6ECEB', line: '#E6D0CD', line2: '#D6B8B3', text: '#2B1917', muted: '#735350', output: '#F6ECEB' },
    dark: { bg: '#140C0B', title: '#1C1110', surface: '#241615', surface2: '#2F1B1A', line: '#36201E', line2: '#4A2C29', text: '#EAE2E1', muted: '#A69593', output: '#100807' },
  },
  mono: {
    light: { bg: '#F8F9FA', title: '#EDEFF1', surface: '#FFFFFF', surface2: '#EDEFF1', line: '#DCE1E5', line2: '#CCD2D8', text: '#212529', muted: '#6C757D', output: '#EDEFF1' },
    dark: { bg: '#121212', title: '#1A1A1A', surface: '#222222', surface2: '#292929', line: '#2D2D2D', line2: '#3D3D3D', text: '#E0E0E0', muted: '#A0A0A0', output: '#0D0D0D' },
  },
  slate: {
    light: { bg: '#F1F5F9', title: '#E2E8F0', surface: '#FFFFFF', surface2: '#E2E8F0', line: '#CBD5E1', line2: '#94A3B8', text: '#1E293B', muted: '#64748B', output: '#E8EEF5' },
    dark: { bg: '#0F172A', title: '#1E293B', surface: '#1E293B', surface2: '#26354A', line: '#334155', line2: '#475569', text: '#F1F5F9', muted: '#94A3B8', output: '#0B1120' },
  },
  poseidon: {
    light: { bg: '#F0F7FC', title: '#E0EFF8', surface: '#FFFFFF', surface2: '#E0EFF8', line: '#C5DFEE', line2: '#ABCEE3', text: '#0A2540', muted: '#4A6B82', output: '#E5F2FA' },
    dark: { bg: '#0B132B', title: '#111B38', surface: '#16224F', surface2: '#1C2E5D', line: '#22335C', line2: '#30487E', text: '#E2E8F0', muted: '#8F9CB3', output: '#071024' },
  },
  sisyphus: {
    light: { bg: '#F5F3FF', title: '#EDE9FE', surface: '#FFFFFF', surface2: '#EDE9FE', line: '#DDD6FE', line2: '#C4B5FD', text: '#2E1065', muted: '#6D28D9', output: '#EEEAFE' },
    dark: { bg: '#0F0B1E', title: '#17112B', surface: '#20183B', surface2: '#2A1E4E', line: '#2B214A', line2: '#3D2F69', text: '#E2E8F0', muted: '#A78BFA', output: '#0B0717' },
  },
  emerald: {
    light: { bg: '#F4FBF8', title: '#EAF7F1', surface: '#FFFFFF', surface2: '#E7F5EF', line: '#C8E6D8', line2: '#9ED2BB', text: '#123126', muted: '#537569', output: '#EAF7F1' },
    dark: { bg: '#071510', title: '#0C1D16', surface: '#11271E', surface2: '#153126', line: '#214535', line2: '#30634C', text: '#E4F7ED', muted: '#8FB7A5', output: '#05100C' },
  },
  charizard: {
    light: { bg: '#FFFBF7', title: '#FFF3E5', surface: '#FFFFFF', surface2: '#FFF3E5', line: '#FFE2CC', line2: '#FFD0B3', text: '#331400', muted: '#8A3D0C', output: '#FFF3E5' },
    dark: { bg: '#140A03', title: '#1F1005', surface: '#2B1607', surface2: '#3D1E0C', line: '#3D1E0C', line2: '#5C2F12', text: '#FFF3E5', muted: '#FB923C', output: '#100702' },
  },
  sienna: {
    light: { bg: '#FAF9F5', title: '#F0EEE6', surface: '#FFFFFF', surface2: '#F5F3EC', line: '#E7E4DB', line2: '#D7D3C7', text: '#1F1E1C', muted: '#6B6A63', output: '#F5F3EC' },
    dark: { bg: '#1F1E1C', title: '#262522', surface: '#2C2B28', surface2: '#34322E', line: '#3A3935', line2: '#4A4843', text: '#EDEBE3', muted: '#A3A197', output: '#191816' },
  },
  catppuccin: {
    light: { bg: '#EFF1F5', title: '#E6E9EF', surface: '#FFFFFF', surface2: '#E6E9EF', line: '#CCD0DA', line2: '#BCC0CC', text: '#4C4F69', muted: '#7C7F93', output: '#E6E9EF' },
    dark: { bg: '#1E1E2E', title: '#181825', surface: '#313244', surface2: '#36374A', line: '#45475A', line2: '#585B70', text: '#CDD6F4', muted: '#A6ADC8', output: '#11111B' },
  },
  nous: {
    light: { bg: '#FFFFFF', title: '#F5F5F5', surface: '#FFFFFF', surface2: '#F0F2F5', line: '#D0D8E0', line2: '#B3BEC9', text: '#1A2A3A', muted: '#6B7B8B', output: '#F0F2F5' },
    dark: { bg: '#0A0E14', title: '#0F1419', surface: '#111820', surface2: '#16202B', line: '#1E2A3A', line2: '#354356', text: '#C8D6E5', muted: '#5A6A7A', output: '#070B10' },
  },
  'geist-contrast': {
    light: { bg: '#FFFFFF', title: '#FAFAFA', surface: '#FFFFFF', surface2: '#F5F5F5', line: '#EAEAEA', line2: '#D4D4D4', text: '#111111', muted: '#666666', output: '#FAFAFA' },
    dark: { bg: '#000000', title: '#050505', surface: '#0A0A0A', surface2: '#111111', line: '#262626', line2: '#3F3F3F', text: '#EDEDED', muted: '#A1A1A1', output: '#000000' },
  },
  'aurora-ink': {
    light: { bg: '#FFFCEF', title: '#F8F2E8', surface: '#FFFBF1', surface2: '#F3ECE0', line: '#E7DDD0', line2: '#D3C4B2', text: '#191816', muted: '#6F685E', output: '#F2EBE0' },
    dark: { bg: '#141311', title: '#1A1917', surface: '#211F1C', surface2: '#292621', line: '#342F29', line2: '#4D453B', text: '#FFF8E8', muted: '#B9AD9A', output: '#0E0D0C' },
  },
};

const getInitialThemePreference = () => {
  try {
    const saved = window.localStorage.getItem('moa-theme');
    return THEME_OPTIONS.some(({ value }) => value === saved) ? saved : 'system';
  } catch {
    return 'system';
  }
};

const getInitialColourScheme = () => {
  try {
    const saved = window.localStorage.getItem('moa-colour-scheme');
    return COLOUR_SCHEMES.some(({ value }) => value === saved) ? saved : 'moa';
  } catch {
    return 'moa';
  }
};

const getInitialAutonomousAgent = () => {
  try { return window.localStorage.getItem('moa-autonomous-agent') === 'true'; } catch { return false; }
};

const getSystemTheme = () => window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

const getSessionValue = (key) => {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
};

const executionFailureMessage = (reason, correctionAttempts = 0) => reason === 'verification_failed' && correctionAttempts > 0
  ? `Independent verification still found unmet criteria after ${correctionAttempts} bounded corrective ${correctionAttempts === 1 ? 'pass' : 'passes'}. Review verification.md for the remaining evidence.`
  : ({
  idle_timeout: 'Execution stopped after reaching the inactivity limit. Review execution.log before trying again.',
  maximum_runtime: 'Execution stopped after reaching the maximum runtime. Review execution.log before trying again.',
  verification_failed: 'Independent verification did not confirm the outcome. Review verification.md and verification.log.',
  execution_blocked: 'The executor could not safely apply the plan as written. Review execution.md.',
  judge_blocked: 'The judge confirmed that execution requires a decision only you can provide. Review the message and update the task before starting a new workflow.',
  plan_revision_setup_failed: 'MoA could not preserve the blocked plan before revising it.',
  plan_revision_failed: 'The judge could not revise the blocked execution plan. Review judge-revision.log.',
  plan_revision_invalid: 'The revised plan did not satisfy MoA’s execution contract. Review judge-revision-attempt-1.md.',
  correction_blocked: 'The corrective pass could not safely satisfy the verification feedback within the judged plan.',
  correction_judge_blocked: 'The judge confirmed that completing the verified objective requires a decision or credential only you can provide.',
  correction_plan_revision_setup_failed: 'MoA could not preserve the corrective conflict before judge re-evaluation.',
  correction_plan_revision_failed: 'The judge could not reconcile verification feedback with the execution plan. Review judge-revision.log.',
  correction_plan_revision_invalid: 'The reconciled plan did not satisfy MoA’s execution contract. Review judge-correction-revision-attempt-1.md.',
  correction_failed: 'The corrective execution pass failed. Review execution.log.',
  correction_setup_failed: 'MoA could not preserve the prior attempt before correction.',
  launch_error: 'The plan executor could not be launched. Review execution.log for details.',
  terminated: 'The plan executor ended before verification completed.',
  failed: 'The plan executor failed before verification completed.',
  }[reason] || 'The plan executor ended before verification completed.');

const workflowFailureMessage = (reason, stage = 'workflow') => ({
  workflow_idle_timeout: `The ${stage} stage stopped after producing no observable activity. MoA ended it safely instead of remaining stuck; retry the workflow to continue from persisted project intent.`,
  workflow_maximum_runtime: `The ${stage} stage reached its maximum runtime and was stopped safely. Review the stage log before retrying.`,
  stopped_by_user: '',
}[reason] ?? `The workflow stopped during ${stage} before an execution plan was available. Review the saved stage log.`);

const SERVICE_UNAVAILABLE_MESSAGE = 'The local MoA service is unavailable.';
const OVERVIEW_RETRY_DELAYS_MS = [0, 250, 750, 1500];
const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.pdf,.txt,.md,.markdown,.rtf,.csv,.json,.doc,.docx,.ppt,.pptx,.xls,.xlsx';
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const formatBytes = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function App() {
  const [workspace, setWorkspace] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [task, setTask] = useState('');
  const [taskFocused, setTaskFocused] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [runsMarkedForDeletion, setRunsMarkedForDeletion] = useState(() => new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [runDetail, setRunDetail] = useState(null);
  const [resumeDraft, setResumeDraft] = useState(() => readResumeDraft(window.sessionStorage));
  const [resuming, setResuming] = useState(false);
  const [system, setSystem] = useState({ experts: [], optionalExplorers: [], commandAvailable: false });
  const [cliIntegrations, setCliIntegrations] = useState([]);
  const [terminalSession, setTerminalSession] = useState(null);
  const [gatewayOpening, setGatewayOpening] = useState('');
  const [activeId, setActiveId] = useState(() => getSessionValue('moa-active-run'));
  const [expertProgress, setExpertProgress] = useState(READY_EXPERTS);
  const [logs, setLogs] = useState([]);
  const [phase, setPhase] = useState('intake');
  const [stageState, setStageState] = useState(INITIAL_STAGE_STATE);
  const [activityMessages, setActivityMessages] = useState([]);
  const [completedRunName, setCompletedRunName] = useState(() => getSessionValue('moa-completed-run'));
  const [judgeDecision, setJudgeDecision] = useState(null);
  const [executionStarted, setExecutionStarted] = useState(false);
  const [executionFailureReason, setExecutionFailureReason] = useState('');
  const [correctionApproval, setCorrectionApproval] = useState(null);
  const [correctionDecisionPending, setCorrectionDecisionPending] = useState(false);
  const [error, setError] = useState('');
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [notice, setNotice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [themePreference, setThemePreference] = useState(getInitialThemePreference);
  const [colourScheme, setColourScheme] = useState(getInitialColourScheme);
  const [autonomousAgent, setAutonomousAgent] = useState(getInitialAutonomousAgent);
  const [systemTheme, setSystemTheme] = useState(getSystemTheme);
  const [view, setView] = useState('new');
  const outputRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const taskInputRef = useRef(null);
  const activeIdRef = useRef(activeId);
  const autoExecuteWorkflowRef = useRef(getSessionValue('moa-auto-execute-workflow'));
  const overviewRefreshRef = useRef(null);
  const resolvedTheme = themePreference === 'system' ? systemTheme : themePreference;
  const activeColourScheme = COLOUR_SCHEMES.find(({ value }) => value === colourScheme) || COLOUR_SCHEMES[0];
  const accentColour = activeColourScheme[resolvedTheme];
  const defaultColourScheme = colourScheme === 'moa';
  const schemePalette = SCHEME_PALETTES[colourScheme]?.[resolvedTheme];
  const accentSoft = defaultColourScheme ? resolvedTheme === 'light' ? 'rgba(0,142,182,.1)' : 'rgba(11,198,244,.12)' : `${accentColour}1f`;
  const paletteStyles = schemePalette ? { '--bg': schemePalette.bg, '--title': schemePalette.title, '--surface': schemePalette.surface, '--surface2': schemePalette.surface2, '--line': schemePalette.line, '--line2': schemePalette.line2, '--text': schemePalette.text, '--muted': schemePalette.muted, '--output-bg': schemePalette.output } : {};
  const windowBackgroundColour = schemePalette?.bg || (resolvedTheme === 'light' ? '#f5f8fa' : '#061018');
  const workflowLocked = Boolean(activeId);
  const running = workflowLocked && !correctionApproval;
  const activeExplorers = useMemo(() => EXPLORERS.filter((explorer) => {
    const status = system.experts.find(({ name }) => name === explorer.systemName);
    return explorer.optional ? status?.enabled === true : status?.enabled !== false;
  }).map((explorer) => ({ ...explorer, available: system.experts.find(({ name }) => name === explorer.systemName)?.available })), [system.experts]);

  const rememberAutoExecuteWorkflow = useCallback((id) => {
    autoExecuteWorkflowRef.current = id;
    try {
      if (id) window.sessionStorage.setItem('moa-auto-execute-workflow', id);
      else window.sessionStorage.removeItem('moa-auto-execute-workflow');
    } catch { /* Autonomous handoff recovery is best effort. */ }
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const updateSystemTheme = () => setSystemTheme(media.matches ? 'light' : 'dark');
    media.addEventListener('change', updateSystemTheme);
    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem('moa-theme', themePreference); } catch { /* Preference persistence is optional. */ }
  }, [themePreference]);

  useEffect(() => {
    try { window.localStorage.setItem('moa-colour-scheme', colourScheme); } catch { /* Preference persistence is optional. */ }
  }, [colourScheme]);

  useEffect(() => {
    try { window.localStorage.setItem('moa-autonomous-agent', String(autonomousAgent)); } catch { /* Preference persistence is optional. */ }
  }, [autonomousAgent]);

  useEffect(() => {
    activeIdRef.current = activeId;
    try {
      if (activeId) window.sessionStorage.setItem('moa-active-run', activeId);
      else window.sessionStorage.removeItem('moa-active-run');
    } catch { /* Live-run recovery is best effort. */ }
  }, [activeId]);

  useEffect(() => {
    try {
      if (completedRunName) window.sessionStorage.setItem('moa-completed-run', completedRunName);
      else window.sessionStorage.removeItem('moa-completed-run');
    } catch { /* Judged-run recovery is best effort. */ }
  }, [completedRunName]);

  useEffect(() => { writeResumeDraft(window.sessionStorage, resumeDraft); }, [resumeDraft]);

  const resizeTaskInput = useCallback(() => {
    const input = taskInputRef.current;
    if (!input) return;
    if (!taskFocused) {
      input.style.height = '44px';
      input.style.overflowY = 'hidden';
      return;
    }
    input.style.height = 'auto';
    const styles = window.getComputedStyle(input);
    const minimum = 92;
    const maximum = Number.parseFloat(styles.maxHeight) || 180;
    const nextHeight = Math.min(maximum, Math.max(minimum, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
  }, [taskFocused]);

  useEffect(() => { resizeTaskInput(); }, [resizeTaskInput, task]);

  useEffect(() => {
    window.addEventListener('resize', resizeTaskInput);
    return () => window.removeEventListener('resize', resizeTaskInput);
  }, [resizeTaskInput]);

  useEffect(() => {
    if (!resumeDraft.runName || selectedRun?.name === resumeDraft.runName || !runs.length) return;
    const run = runs.find(({ name }) => name === resumeDraft.runName);
    if (!run) return;
    setSelectedRun(run);
    setView('runs');
    fetch(`/api/runs/${encodeURIComponent(run.name)}`).then((response) => response.ok ? response.json() : null).then((detail) => { if (detail) setRunDetail(detail); }).catch(() => {});
  }, [resumeDraft.runName, runs, selectedRun?.name]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    window.webkit?.messageHandlers?.themeChanged?.postMessage({ theme: resolvedTheme, background: windowBackgroundColour });
  }, [resolvedTheme, windowBackgroundColour]);

  useEffect(() => {
    window.__moaWorkspaceSelected = (selectedPath) => {
      setChoosingWorkspace(false);
      if (typeof selectedPath !== 'string' || !selectedPath) return;
      setWorkspace(selectedPath);
      setWorkspaceError('');
    };
    return () => { delete window.__moaWorkspaceSelected; };
  }, []);

  const loadOverview = useCallback(async () => {
    const [statusResponse, runsResponse] = await Promise.all([fetch('/api/status'), fetch('/api/runs')]);
    if (!statusResponse.ok) throw new Error(`MoA status request failed with HTTP ${statusResponse.status}.`);
    const status = await statusResponse.json();
    setServiceUnavailable(false);
    setSystem(status);
    setCliIntegrations(status.cliIntegrations || []);
      const activeRuns = (status.active || []).map((run) => typeof run === 'string' ? { id: run } : run);
      const rememberedId = activeIdRef.current;
      const liveRun = activeRuns.find(({ id }) => id === rememberedId) || (!rememberedId ? activeRuns[0] : null);
      const pausedRun = (status.executions || []).find((run) => run.kind === 'execute'
        && run.state === 'awaiting_correction_approval'
        && (!rememberedId || run.id === rememberedId));
      if (pausedRun) {
        if (pausedRun.id !== rememberedId) setActiveId(pausedRun.id);
        if (pausedRun.runName) setCompletedRunName(pausedRun.runName);
        setExecutionStarted(true);
        setCorrectionApproval({ ...pausedRun.correctionApproval, runName: pausedRun.runName, executionId: pausedRun.id });
        setCorrectionDecisionPending(false);
        setExecutionFailureReason('');
        setPhase('awaiting_correction_approval');
        setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.COMPLETE, judge: STAGE_STATUS.COMPLETE, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.PAUSED }));
        const reconnectMessage = `Correction attempt ${pausedRun.correctionApproval?.attemptNumber || (pausedRun.correctionAttempts || 0) + 1} is awaiting approval`;
        setActivityMessages((current) => [...current.filter((message) => message !== reconnectMessage), reconnectMessage].slice(-12));
      } else if (liveRun) {
        setCorrectionApproval(null);
        if (liveRun.id !== rememberedId) setActiveId(liveRun.id);
        if (liveRun.runName) setCompletedRunName(liveRun.runName);
        if (liveRun.kind === 'execute') {
          setExecutionStarted(true);
          const verifying = liveRun.stage === 'verify';
          const revising = liveRun.stage === 'judge';
          setPhase(verifying ? 'verify' : revising ? 'judge' : 'execute');
          setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.COMPLETE, judge: revising ? STAGE_STATUS.ACTIVE : STAGE_STATUS.COMPLETE, execute: verifying ? STAGE_STATUS.COMPLETE : revising ? STAGE_STATUS.PENDING : STAGE_STATUS.ACTIVE, verify: verifying ? STAGE_STATUS.ACTIVE : STAGE_STATUS.PENDING }));
          const reconnectMessage = verifying ? 'Reconnected to independent verification' : liveRun.status === 'reconciling' ? 'Reconnected while the judge reconciles verification feedback' : revising ? 'Reconnected while the judge revises a blocked plan' : liveRun.status === 'correcting' ? `Reconnected to corrective pass ${liveRun.correctionAttempts}` : 'Reconnected to the active executor';
          setActivityMessages((current) => [...current.filter((message) => message !== reconnectMessage), reconnectMessage].slice(-12));
        } else if (liveRun.kind === 'workflow') {
          const stageIndex = WORKFLOW_STAGES.findIndex(({ id }) => id === liveRun.stage);
          const safeStageIndex = stageIndex >= 0 ? stageIndex : 0;
          setPhase(WORKFLOW_STAGES[safeStageIndex].id);
          setStageState(Object.fromEntries(WORKFLOW_STAGES.map(({ id }, index) => [id, index < safeStageIndex ? STAGE_STATUS.COMPLETE : index === safeStageIndex ? STAGE_STATUS.ACTIVE : STAGE_STATUS.PENDING])));
          const reconnectMessage = `Reconnected to ${WORKFLOW_STAGES[safeStageIndex].label.toLowerCase()}`;
          setActivityMessages((current) => [...current.filter((message) => message !== reconnectMessage), reconnectMessage].slice(-12));
        }
      } else if (rememberedId) {
        const outcome = (status.executions || []).find(({ id }) => id === rememberedId);
        setActiveId(null);
        setCorrectionApproval(null);
        if (outcome) {
          if (outcome.kind === 'workflow') {
            const stageIndex = Math.max(0, WORKFLOW_STAGES.findIndex(({ id }) => id === outcome.stage));
            setExecutionStarted(false);
            setPhase(outcome.state === 'completed' ? 'complete' : 'failed');
            setStageState(Object.fromEntries(WORKFLOW_STAGES.map(({ id }, index) => [id, outcome.state === 'completed' ? index <= stageIndex ? STAGE_STATUS.COMPLETE : STAGE_STATUS.PENDING : index < stageIndex ? STAGE_STATUS.COMPLETE : index === stageIndex ? STAGE_STATUS.FAILED : STAGE_STATUS.BLOCKED])));
            if (outcome.runName) setCompletedRunName(outcome.runName);
            if (outcome.state !== 'completed' && outcome.reason !== 'stopped_by_user') setError(workflowFailureMessage(outcome.reason, outcome.stage));
            setActivityMessages((current) => [...current, outcome.state === 'completed' ? 'Recovered the completed workflow result' : `Recovered workflow status: ${outcome.reason || 'failed'}`].slice(-12));
            if (runsResponse.ok) setRuns((await runsResponse.json()).runs || []);
            return;
          }
          setExecutionStarted(true);
          if (outcome.runName) setCompletedRunName(outcome.runName);
          if (outcome.state === 'completed') {
            setExecutionFailureReason('');
            setPhase('verified');
            setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.COMPLETE, judge: STAGE_STATUS.COMPLETE, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.COMPLETE }));
            setActivityMessages((current) => [...current, 'Recovered the completed executor result'].slice(-12));
          } else {
            const verificationFailed = outcome.reason === 'verification_failed';
            setExecutionFailureReason(outcome.reason || 'failed');
            setPhase('failed');
            setStageState((current) => ['judge_blocked', 'correction_judge_blocked'].includes(outcome.reason)
              ? { ...current, judge: STAGE_STATUS.FAILED, execute: STAGE_STATUS.BLOCKED, verify: STAGE_STATUS.SKIPPED }
              : { ...current, execute: verificationFailed ? STAGE_STATUS.COMPLETE : STAGE_STATUS.FAILED, verify: verificationFailed ? STAGE_STATUS.FAILED : STAGE_STATUS.SKIPPED });
            if (outcome.reason !== 'stopped_by_user') setError(['judge_blocked', 'correction_judge_blocked'].includes(outcome.reason) && outcome.detail ? outcome.detail.replace(/^JUDGE_BLOCKED:\s*/, '') : executionFailureMessage(outcome.reason, outcome.correctionAttempts));
            setActivityMessages((current) => [...current, `Recovered executor status: ${outcome.reason || 'failed'}`].slice(-12));
          }
        } else {
          setPhase('failed');
          setError('The previous process is no longer active and did not leave a recoverable completion record.');
        }
      }
    if (runsResponse.ok) setRuns((await runsResponse.json()).runs || []);
  }, []);

  const refreshOverview = useCallback((attempts = OVERVIEW_RETRY_DELAYS_MS.length) => {
    if (overviewRefreshRef.current) return overviewRefreshRef.current;

    const refresh = (async () => {
      const retryCount = Math.min(Math.max(attempts, 1), OVERVIEW_RETRY_DELAYS_MS.length);
      for (let attempt = 0; attempt < retryCount; attempt += 1) {
        if (OVERVIEW_RETRY_DELAYS_MS[attempt]) await wait(OVERVIEW_RETRY_DELAYS_MS[attempt]);
        try {
          await loadOverview();
          return true;
        } catch { /* Confirm actual service health before showing a connection warning. */ }
      }

      try {
        const healthResponse = await fetch('/api/health', { cache: 'no-store' });
        if (healthResponse.ok) {
          setServiceUnavailable(false);
          return false;
        }
      } catch { /* The service is genuinely unreachable. */ }

      setServiceUnavailable(true);
      return false;
    })().finally(() => {
      if (overviewRefreshRef.current === refresh) overviewRefreshRef.current = null;
    });

    overviewRefreshRef.current = refresh;
    return refresh;
  }, [loadOverview]);

  const loadJudgeDecision = useCallback(async (runName) => {
    if (!runName) return;
    const response = await fetch(`/api/runs/${encodeURIComponent(runName)}`);
    if (!response.ok) return;
    const run = await response.json();
    setJudgeDecision(parseJudgeDecision(run.files?.['judge.md'] || ''));
  }, []);

  const appendActivity = useCallback((message) => {
    setActivityMessages((current) => current[current.length - 1] === message ? current : [...current, message].slice(-12));
  }, []);

  const startJudgedPath = useCallback(async (runName) => {
    if (!runName) return false;
    setError('');
    setExecutionFailureReason('');
    setCorrectionApproval(null);
    setLogs((current) => [...current, 'Launching the plan executor…']);
    setExecutionStarted(true);
    const response = await fetch('/api/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runName }) });
    const payload = await response.json();
    if (!response.ok) {
      setExecutionStarted(false);
      setPhase('complete');
      setError(payload.error || 'Unable to execute the plan.');
      appendActivity('Executor request was rejected');
      return false;
    }
    setPhase('execute');
    setStageState((current) => ({ ...current, execute: STAGE_STATUS.ACTIVE, verify: STAGE_STATUS.PENDING }));
    appendActivity('Plan executor started');
    setActiveId(payload.id);
    return true;
  }, [appendActivity]);

  useEffect(() => { if (completedRunName) loadJudgeDecision(completedRunName); }, [completedRunName, loadJudgeDecision]);

  const activateExploration = useCallback(() => {
    setPhase((current) => ['initialize', 'plan'].includes(current) ? 'explore' : current);
    setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: current.explore === STAGE_STATUS.COMPLETE ? current.explore : STAGE_STATUS.ACTIVE }));
  }, []);

  const activateJudge = useCallback(() => {
    setPhase('judge');
    setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.COMPLETE, judge: STAGE_STATUS.ACTIVE }));
    appendActivity('Judge evaluation started');
  }, [appendActivity]);

  useEffect(() => { void refreshOverview(); }, [refreshOverview]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onopen = () => { void refreshOverview(2); };
    events.onmessage = async ({ data }) => {
      const event = JSON.parse(data);
      if (!activeId || event.id !== activeId) return;
      if (event.type === 'snapshot') {
        setLogs(event.text.split('\n').filter(Boolean).slice(-500));
        setExpertProgress((current) => ({ ...current, ...event.experts }));
        if (Object.values(event.experts || {}).some(({ status }) => ['running', 'responded', 'done', 'failed'].includes(status))) {
          activateExploration();
          appendActivity('Explorer activity detected');
        }
      }
      if (event.type === 'log') {
        setLogs((current) => [...current, ...event.text.split('\n').filter(Boolean)].slice(-500));
        const text = event.text.toLowerCase();
        if (text.includes('parallel exploration')) {
          activateExploration();
          appendActivity('Parallel exploration started');
        }
        if (text.includes('codex explorer started')) appendActivity('Codex started');
        if (text.includes('antigravity explorer started')) appendActivity('Antigravity started');
        if (text.includes('opencode explorer started')) appendActivity('OpenCode started');
        if (text.includes('claude code explorer started')) appendActivity('Claude Code started');
        if (text.includes('independent judge') || text.includes('judge comparing') || text.includes('judge report ready')) activateJudge();
      }
      if (event.type === 'expert') {
        if (['running', 'responded', 'done', 'failed'].includes(event.status)) activateExploration();
        setExpertProgress((current) => ({ ...current, [event.expert]: { status: event.status, detail: event.detail } }));
        const label = EXPLORERS.find(({ key }) => key === event.expert)?.label || event.expert;
        if (event.status === 'done') appendActivity(`${label} report completed`);
        else if (event.status === 'failed') appendActivity(`${label} failed; diagnostic log retained`);
        else if (event.status === 'responded') appendActivity(`${label} evidence received`);
      }
      if (event.type === 'correction_approval_required') {
        setCorrectionApproval({ ...event.correctionApproval, runName: event.runName, executionId: event.id });
        setCorrectionDecisionPending(false);
        setPhase('awaiting_correction_approval');
        setStageState((current) => ({ ...current, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.PAUSED }));
        appendActivity(`Correction attempt ${event.correctionApproval.attemptNumber} is awaiting approval`);
      }
      if (event.type === 'stage' && event.kind === 'workflow' && event.status === 'running') {
        const stageIndex = WORKFLOW_STAGES.findIndex(({ id }) => id === event.stage);
        if (stageIndex >= 0) {
          setPhase(event.stage);
          setStageState(Object.fromEntries(WORKFLOW_STAGES.map(({ id }, index) => [id, index < stageIndex ? STAGE_STATUS.COMPLETE : index === stageIndex ? STAGE_STATUS.ACTIVE : STAGE_STATUS.PENDING])));
          const stageLabel = WORKFLOW_STAGES[stageIndex].label;
          appendActivity(`${stageLabel} stage started`);
        }
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.stage === 'verify' && event.status === 'running') {
        setPhase('verify');
        setStageState((current) => ({ ...current, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.ACTIVE }));
        appendActivity(event.attempt > 1 ? `Independent verification restarted · attempt ${event.attempt}` : 'Independent verification started');
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.stage === 'execute' && event.status === 'correcting') {
        setCorrectionApproval(null);
        setCorrectionDecisionPending(false);
        setPhase('execute');
        setStageState((current) => ({ ...current, execute: STAGE_STATUS.ACTIVE, verify: STAGE_STATUS.PENDING }));
        appendActivity(`Verification feedback received · corrective pass ${event.attempt} of ${event.limit}`);
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.stage === 'judge' && event.status === 'revising') {
        setPhase('judge');
        setStageState((current) => ({ ...current, judge: STAGE_STATUS.ACTIVE, execute: STAGE_STATUS.PENDING, verify: STAGE_STATUS.PENDING }));
        appendActivity('Executor blocker detected · judge is revising the plan');
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.stage === 'judge' && event.status === 'reconciling') {
        setPhase('judge');
        setStageState((current) => ({ ...current, judge: STAGE_STATUS.ACTIVE, execute: STAGE_STATUS.BLOCKED, verify: STAGE_STATUS.FAILED }));
        appendActivity('Plan conflict detected · judge is reconciling verification feedback');
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.stage === 'execute' && event.status === 'retrying') {
        setPhase('execute');
        setStageState((current) => ({ ...current, judge: STAGE_STATUS.COMPLETE, execute: STAGE_STATUS.ACTIVE, verify: STAGE_STATUS.PENDING }));
        appendActivity('Revised execution plan ready · executor restarted');
        loadJudgeDecision(event.runName);
      }
      if (event.type === 'stage' && event.kind === 'execute' && event.status === 'runtime_recovery') {
        setPhase(event.stage);
        setStageState((current) => ({ ...current, [event.stage]: STAGE_STATUS.ACTIVE }));
        appendActivity(`${event.stage === 'judge' ? 'Judge' : event.stage === 'verify' ? 'Verifier' : 'Executor'} became unresponsive · recovery attempt ${event.attempt} of ${event.limit}`);
      }
      if (event.type === 'complete') {
        const shouldAutoExecute = event.code === 0 && event.kind === 'workflow' && Boolean(event.runName) && autoExecuteWorkflowRef.current === event.id;
        if (event.kind === 'workflow') rememberAutoExecuteWorkflow(null);
        setCorrectionApproval(null);
        setCorrectionDecisionPending(false);
        setPhase(event.code === 0 ? event.kind === 'execute' ? 'verified' : 'complete' : 'failed');
        if (event.code === 0 && event.kind === 'workflow') {
          setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.COMPLETE, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.COMPLETE, judge: STAGE_STATUS.COMPLETE }));
          appendActivity('Execution plan ready');
        } else if (event.code === 0 && event.kind === 'execute') {
          setStageState((current) => ({ ...current, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.COMPLETE }));
          appendActivity('Independent verification passed');
        } else if (event.kind === 'execute') {
          setExecutionFailureReason(event.reason || 'failed');
          setStageState((current) => ['judge_blocked', 'correction_judge_blocked'].includes(event.reason)
            ? { ...current, judge: STAGE_STATUS.FAILED, execute: STAGE_STATUS.BLOCKED, verify: STAGE_STATUS.SKIPPED }
            : { ...current, execute: event.reason === 'verification_failed' ? STAGE_STATUS.COMPLETE : STAGE_STATUS.FAILED, verify: event.reason === 'verification_failed' || current.verify === STAGE_STATUS.ACTIVE ? STAGE_STATUS.FAILED : STAGE_STATUS.SKIPPED });
          appendActivity(event.reason === 'verification_failed' ? 'Independent verification failed' : 'Executor failed; verification was not completed');
          if (event.reason !== 'stopped_by_user') setError(['judge_blocked', 'correction_judge_blocked'].includes(event.reason) && event.detail ? event.detail.replace(/^JUDGE_BLOCKED:\s*/, '') : executionFailureMessage(event.reason, event.correctionAttempts));
        } else {
          setStageState((current) => {
            const activeStage = WORKFLOW_STAGES.find(({ id }) => current[id] === STAGE_STATUS.ACTIVE)?.id;
            if (!activeStage) return current;
            const activeIndex = WORKFLOW_STAGES.findIndex(({ id }) => id === activeStage);
            return Object.fromEntries(WORKFLOW_STAGES.map(({ id }, index) => [id, index < activeIndex ? current[id] : index === activeIndex ? STAGE_STATUS.FAILED : STAGE_STATUS.BLOCKED]));
          });
          appendActivity('Workflow failed before an execution plan was available');
          if (event.reason !== 'stopped_by_user') setError(workflowFailureMessage(event.reason, event.stage));
        }
        if (event.runName && event.kind === 'workflow') {
          setCompletedRunName(event.runName);
          loadJudgeDecision(event.runName);
        }
        setActiveId(null);
        if (shouldAutoExecute) {
          appendActivity('Autonomous agent is continuing with the execution plan');
          await startJudgedPath(event.runName);
        }
        loadOverview();
      }
      if (event.type === 'error') {
        setError(event.message);
        appendActivity('Process error received');
      }
    };
    return () => events.close();
  }, [activeId, activateExploration, activateJudge, appendActivity, loadJudgeDecision, loadOverview, refreshOverview, rememberAutoExecuteWorkflow, startJudgedPath]);

  useEffect(() => {
    if (phase !== 'explore') return;
    const experts = activeExplorers.filter(({ available }) => available !== false).map(({ key }) => expertProgress[key]);
    if (experts.length && experts.every(({ status }) => status === 'done' || status === 'failed')) {
      setPhase('consolidate');
      setStageState((current) => ({ ...current, explore: STAGE_STATUS.COMPLETE, consolidate: STAGE_STATUS.ACTIVE }));
      appendActivity('Normalizing completed expert evidence');
    }
  }, [activeExplorers, appendActivity, expertProgress, phase]);

  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' }); }, [logs]);

  useEffect(() => {
    if (!deleteDialogOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setDeleteDialogOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [deleteDialogOpen]);

  const availableCount = useMemo(() => activeExplorers.filter(({ available }) => available).length, [activeExplorers]);

  const addAttachments = async (event) => {
    const selectedFiles = [...(event.target.files || [])];
    event.target.value = '';
    if (!selectedFiles.length) return;
    const remainingSlots = MAX_ATTACHMENT_COUNT - attachments.length;
    if (selectedFiles.length > remainingSlots) { setError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files per workflow.`); return; }
    const supported = /\.(png|jpe?g|gif|webp|heic|heif|pdf|txt|md|markdown|rtf|csv|json|docx?|pptx?|xlsx?)$/i;
    if (selectedFiles.some((file) => !supported.test(file.name))) { setError('Choose supported documents or images only.'); return; }
    if (selectedFiles.some((file) => file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES)) { setError('Each attachment must be between 1 byte and 20 MiB.'); return; }
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0) + selectedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) { setError('Attachments cannot exceed 50 MiB in total.'); return; }
    setUploadingAttachments(true);
    setError('');
    const uploaded = [];
    try {
      for (const file of selectedFiles) {
        const response = await fetch('/api/attachments', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-moa-file-name': encodeURIComponent(file.name) }, body: file });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Unable to attach ${file.name}.`);
        uploaded.push(payload.attachment);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload the selected attachment.');
    } finally {
      if (uploaded.length) setAttachments((current) => [...current, ...uploaded]);
      setUploadingAttachments(false);
    }
  };

  const removeAttachment = async (attachment) => {
    const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) { setError((await response.json()).error || 'Unable to remove the attachment.'); return; }
    setAttachments((current) => current.filter(({ id }) => id !== attachment.id));
  };

  const startWorkflow = async () => {
    rememberAutoExecuteWorkflow(null);
    setError('');
    setExecutionFailureReason('');
    setCorrectionApproval(null);
    setCorrectionDecisionPending(false);
    setWorkspaceError('');
    setLogs([]);
    setCompletedRunName(null);
    setJudgeDecision(null);
    setExecutionStarted(false);
    setPhase('initialize');
    setStageState({ ...INITIAL_STAGE_STATE, initialize: STAGE_STATUS.ACTIVE });
    setActivityMessages(['Workflow requested', 'Validating workspace and task']);
    setExpertProgress(Object.fromEntries(activeExplorers.map(({ key }) => [key, { status: 'ready', detail: 'Awaiting progress signal.' }])));
    const response = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: workspace.trim(), task, attachmentIds: attachments.map(({ id }) => id) }) });
    const payload = await response.json();
    if (!response.ok) {
      const message = payload.error || 'Unable to start the workflow.';
      setPhase('failed');
      setStageState(Object.fromEntries(WORKFLOW_STAGES.map(({ id }) => [id, id === 'initialize' ? STAGE_STATUS.FAILED : STAGE_STATUS.BLOCKED])));
      appendActivity('Workflow request was rejected');
      if (message === 'Choose an existing absolute workspace path.') setWorkspaceError(message);
      else setError(message);
      return;
    }
    setAttachments([]);
    setPhase('plan');
    setStageState((current) => ({ ...current, initialize: STAGE_STATUS.COMPLETE, plan: STAGE_STATUS.ACTIVE }));
    appendActivity('Workflow accepted');
    appendActivity('Planning explorer execution');
    if (autonomousAgent) rememberAutoExecuteWorkflow(payload.id);
    setActiveId(payload.id);
  };

  const stopWorkflow = async () => {
    if (!activeId) return;
    await fetch(`/api/run/${activeId}/stop`, { method: 'POST' });
  };

  const decideCorrection = async (action) => {
    if (!correctionApproval?.runName || !correctionApproval?.decisionId || correctionDecisionPending) return;
    setCorrectionDecisionPending(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(correctionApproval.runName)}/correction/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decisionId: correctionApproval.decisionId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.code === 'stale_correction_decision') await loadOverview();
        throw new Error(payload.error || 'Unable to apply the correction decision.');
      }
      setCorrectionApproval(null);
      if (action === 'approve') {
        setPhase('execute');
        setStageState((current) => ({ ...current, execute: STAGE_STATUS.ACTIVE, verify: STAGE_STATUS.PENDING }));
        appendActivity(`Scoped corrective pass ${correctionApproval.attemptNumber} approved`);
      } else {
        setActiveId(null);
        setPhase('failed');
        setExecutionFailureReason('stopped_by_user');
        setStageState((current) => ({ ...current, execute: STAGE_STATUS.COMPLETE, verify: STAGE_STATUS.FAILED }));
        appendActivity('Workflow stopped without applying the proposed correction');
      }
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Unable to apply the correction decision.');
    } finally {
      setCorrectionDecisionPending(false);
    }
  };

  const executeJudgedPath = () => startJudgedPath(completedRunName);

  const toggleOptionalExplorer = async (id, enabled) => {
    const response = await fetch(`/api/optional-explorers/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const payload = await response.json();
    if (!response.ok) return payload.error || 'Unable to update the optional explorer.';
    setSystem((current) => ({
      ...current,
      optionalExplorers: payload.optionalExplorers,
      experts: current.experts.map((expert) => {
        const updated = payload.optionalExplorers.find((item) => item.id === expert.name);
        return updated ? { ...expert, enabled: updated.enabled, available: updated.available, version: updated.version } : expert;
      }),
    }));
    return '';
  };

  const selectRun = useCallback(async (run) => {
    setSelectedRun(run);
    setView('runs');
    if (window.innerWidth < 760) setSidebarOpen(false);
    const response = await fetch(`/api/runs/${encodeURIComponent(run.name)}`);
    if (response.ok) setRunDetail(await response.json());
  }, []);

  const openResume = useCallback((run) => {
    void selectRun(run);
    setResumeDraft({ ...EMPTY_RESUME_DRAFT, runName: run.name });
    setError('');
  }, [selectRun]);

  const completedRun = runs.find(({ name }) => name === completedRunName) || null;
  const executeCompletedRun = Boolean(completedRun?.executionEligible);
  const continueCompletedRun = () => {
    if (completedRun) openResume(completedRun);
  };

  const cancelResume = useCallback(() => setResumeDraft({ ...EMPTY_RESUME_DRAFT }), []);

  const submitResume = useCallback(async (confirmDrift = false) => {
    if (!resumeDraft.runName || !resumeDraft.instruction.trim()) return;
    setResuming(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(resumeDraft.runName)}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: resumeDraft.instruction.trim(), mode: 'continue', confirmDrift }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.code === 'workspace_drift' && payload.requiresConfirmation) {
          setResumeDraft((current) => ({ ...current, drift: payload.drift, inheritedFrom: payload.inheritedFrom }));
          return;
        }
        setError(payload.error || 'Unable to resume this run.');
        return;
      }
      const instruction = resumeDraft.instruction.trim();
      setResumeDraft({ ...EMPTY_RESUME_DRAFT });
      setSelectedRun(null);
      setRunDetail(null);
      setView('new');
      setWorkspace(payload.workspace);
      setTask(instruction);
      setCompletedRunName(payload.runName);
      setExecutionFailureReason('');
      setJudgeDecision(null);
      setLogs([]);
      setPhase('initialize');
      setStageState({ ...INITIAL_STAGE_STATE, initialize: STAGE_STATUS.ACTIVE });
      setExpertProgress(Object.fromEntries(activeExplorers.map(({ key }) => [key, { status: 'ready', detail: 'Awaiting continuation progress.' }])));
      setActivityMessages([`Revision ${payload.revision} created`, 'Immutable parent context loaded', 'Fresh workspace baseline requested']);
      if (autonomousAgent) rememberAutoExecuteWorkflow(payload.id);
      setActiveId(payload.id);
      setNotice(`Continuing project as revision ${payload.revision}.`);
      window.setTimeout(() => setNotice(''), 2800);
    } finally {
      setResuming(false);
    }
  }, [autonomousAgent, rememberAutoExecuteWorkflow, resumeDraft]);

  const toggleRunForDeletion = useCallback((run) => {
    setRunsMarkedForDeletion((current) => {
      const next = new Set(current);
      if (next.has(run.name)) next.delete(run.name);
      else next.add(run.name);
      return next;
    });
    selectRun(run);
  }, [selectRun]);

  const deleteSelectedRuns = async () => {
    const names = [...runsMarkedForDeletion];
    if (!names.length) return;
    setError('');
    const response = await fetch('/api/runs', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }) });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'Unable to delete the selected runs.'); return; }
    setDeleteDialogOpen(false);
    if (selectedRun && names.includes(selectedRun.name)) { setSelectedRun(null); setRunDetail(null); }
    setRunsMarkedForDeletion(new Set());
    setNotice(`${payload.deleted} saved ${payload.deleted === 1 ? 'run' : 'runs'} deleted.`);
    window.setTimeout(() => setNotice(''), 2800);
    await loadOverview();
  };

  const closeGateway = useCallback(async () => {
    const id = terminalSession?.id;
    setTerminalSession(null);
    if (!id) return;
    await fetch(`/api/terminal-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }, [terminalSession]);

  const openGateway = async (id) => {
    setError('');
    setGatewayOpening(id);
    try {
      if (terminalSession) await closeGateway();
      const response = await fetch(`/api/gateway/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 36 }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'Unable to open the CLI gateway.');
        return;
      }
      setTerminalSession(payload);
    } catch (gatewayError) {
      setError(gatewayError instanceof Error ? gatewayError.message : 'Unable to open the CLI gateway.');
    } finally {
      setGatewayOpening('');
    }
  };

  useEffect(() => {
    if (view === 'gateways' || !terminalSession) return;
    const id = terminalSession.id;
    setTerminalSession(null);
    void fetch(`/api/terminal-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }, [terminalSession, view]);

  const addCliIntegration = async (integration) => {
    const response = await fetch('/api/cli-integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(integration) });
    const payload = await response.json();
    if (!response.ok) return payload.error || 'Unable to add the CLI integration.';
    setCliIntegrations(payload.integrations || []);
    setNotice(`${integration.label.trim()} added to CLI integrations.`);
    window.setTimeout(() => setNotice(''), 2800);
    return '';
  };

  const removeCliIntegration = async (id) => {
    const response = await fetch(`/api/cli-integrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'Unable to remove the CLI integration.'); return; }
    setCliIntegrations(payload.integrations || []);
    setNotice('CLI integration removed.');
    window.setTimeout(() => setNotice(''), 2800);
  };

  const toggleCliIntegration = async (id, enabled) => {
    const response = await fetch(`/api/cli-integrations/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const payload = await response.json();
    if (!response.ok) return payload.error || 'Unable to update the CLI integration.';
    const integrations = payload.integrations || [];
    setCliIntegrations(integrations);
    setSystem((current) => ({
      ...current,
      cliIntegrations: integrations,
      experts: current.experts.map((expert) => {
        const integration = integrations.find(({ command }) => command === expert.name);
        return integration ? { ...expert, enabled: integration.enabled, available: integration.available, version: integration.version } : expert;
      }),
    }));
    setNotice(`${integrations.find((integration) => integration.id === id)?.label || 'CLI'} ${enabled ? 'enabled' : 'disabled'}.`);
    window.setTimeout(() => setNotice(''), 2800);
    return '';
  };

  const openMoaTerminal = async () => {
    setError('');
    setNotice('');
    const response = await fetch('/api/moa-terminal', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'Unable to open the MoA terminal.'); return; }
    setNotice('MoA terminal launched.');
    window.setTimeout(() => setNotice(''), 2800);
  };

  const browseForWorkspace = async () => {
    setWorkspaceError('');
    setChoosingWorkspace(true);
    try {
      if (window.webkit?.messageHandlers?.chooseWorkspace) {
        window.webkit.messageHandlers.chooseWorkspace.postMessage(null);
        return;
      }
      const response = await fetch('/api/select-workspace', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to open the folder browser.');
      if (payload.workspace) setWorkspace(payload.workspace);
    } catch (selectionError) {
      setWorkspaceError(selectionError instanceof Error ? selectionError.message : 'Unable to open the folder browser.');
    } finally {
      if (!window.webkit?.messageHandlers?.chooseWorkspace) setChoosingWorkspace(false);
    }
  };

  const newRun = () => { setView('new'); setSelectedRun(null); setRunDetail(null); if (window.innerWidth < 760) setSidebarOpen(false); };
  const openChat = () => { setView('chat'); setSidebarOpen(false); };
  const openRailView = (nextView) => {
    if (view === nextView) {
      setSidebarOpen((open) => !open);
      return;
    }
    if (nextView === 'new') {
      setSelectedRun(null);
      setRunDetail(null);
    }
    setView(nextView);
    setSidebarOpen(false);
  };
  const compactStageState = (id) => {
    const status = stageState[id];
    if (status === STAGE_STATUS.COMPLETE) return 'done';
    if (status === STAGE_STATUS.ACTIVE) return 'active';
    if ([STAGE_STATUS.FAILED, STAGE_STATUS.BLOCKED, STAGE_STATUS.SKIPPED].includes(status)) return status;
    return '';
  };

  return (
    <div className={resolvedTheme === 'light' ? 'app light' : 'app'} style={{ ...paletteStyles, '--accent': accentColour, '--accent-soft': accentSoft, '--accent-contrast': defaultColourScheme ? '#00141c' : resolvedTheme === 'light' ? '#ffffff' : '#061018', '--focus-colour': defaultColourScheme ? '#13c5f5' : accentColour, '--primary-shadow': defaultColourScheme ? 'rgba(0,182,233,.14)' : `${accentColour}33` }}>
      <header className="titlebar">
        <button className="brand-mark" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle sidebar"><Icon name="panel" /></button>
        <div className="brand-name">MoA</div>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="Primary navigation">
          <button className={view === 'new' ? 'active' : ''} onClick={() => openRailView('new')} aria-label="New run" aria-expanded={view === 'new' && sidebarOpen} aria-controls="app-sidebar"><Icon name="play" /></button>
          <button className={view === 'chat' ? 'active' : ''} onClick={() => openRailView('chat')} aria-label="Chat" aria-expanded={view === 'chat' && sidebarOpen} aria-controls="app-sidebar"><Icon name="chat" /></button>
          <button className={view === 'runs' ? 'active' : ''} onClick={() => openRailView('runs')} aria-label="Runs" aria-expanded={view === 'runs' && sidebarOpen} aria-controls="app-sidebar"><Icon name="runs" /></button>
          <button className={view === 'gateways' ? 'active' : ''} onClick={() => openRailView('gateways')} aria-label="Gateways" aria-expanded={view === 'gateways' && sidebarOpen} aria-controls="app-sidebar"><Icon name="network" /></button>
          <button aria-label="Open MoA terminal" onClick={openMoaTerminal}><Icon name="terminal" /></button>
          <span />
          <button className={view === 'settings' ? 'active' : ''} onClick={() => openRailView('settings')} aria-label="Settings" aria-expanded={view === 'settings' && sidebarOpen} aria-controls="app-sidebar"><Icon name="settings" /></button>
          <div className="avatar">UD</div>
          <div className="rail-ready" role="status" aria-label="Ready" title="Ready"><b /></div>
        </nav>

        <aside id="app-sidebar" className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="side-heading"><span>Runs</span><button onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><Icon name="x" size={15} /></button></div>
          <div className="side-nav">
            <button className={view === 'new' ? 'active' : ''} onClick={newRun}><Icon name="play" />New run</button>
            <button className={view === 'chat' ? 'active' : ''} onClick={openChat}><Icon name="chat" />Chat</button>
            <button className={view === 'runs' ? 'active' : ''} onClick={() => setView('runs')}><Icon name="runs" />Runs</button>
            <button className={view === 'gateways' ? 'active' : ''} onClick={() => setView('gateways')}><Icon name="network" />Gateways</button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => { setView('settings'); setSidebarOpen(false); }}><Icon name="settings" />Settings</button>
          </div>
          <div className="section-label">Recent runs</div>
          <div className="run-list">
            {runs.length ? runs.map((run) => <RunItem key={run.name} run={run} selected={selectedRun?.name === run.name} deletionSelected={runsMarkedForDeletion.has(run.name)} onToggleDelete={toggleRunForDeletion} onSelect={selectRun} onResume={openResume} />) : <p className="empty-side">No saved runs yet.</p>}
          </div>
          {runsMarkedForDeletion.size ? <div className="run-selection-actions"><button onClick={() => setRunsMarkedForDeletion(new Set())}>Clear</button><button className="delete-runs" onClick={() => setDeleteDialogOpen(true)}>Delete selected ({runsMarkedForDeletion.size})</button></div> : null}
          <button className="view-all" onClick={() => setView('runs')}>View all runs</button>
        </aside>

        <main className="main">
          {serviceUnavailable || error ? <div className="error-banner"><span>{serviceUnavailable ? SERVICE_UNAVAILABLE_MESSAGE : error}</span><button onClick={() => serviceUnavailable ? setServiceUnavailable(false) : setError('')}><Icon name="x" size={15} /></button></div> : null}
          {notice ? <div className="notice-banner" role="status"><Icon name="check" size={15} /><span>{notice}</span></div> : null}
          {correctionApproval ? <CorrectionApprovalCard approval={correctionApproval} pending={correctionDecisionPending} onApprove={() => decideCorrection('approve')} onStop={() => decideCorrection('stop')} /> : null}
          {view === 'new' ? (
            <>
              <section className="intake">
                <div className="page-heading"><h1><Icon name="mixture" size={31} />Mixture of Agents</h1><p>Explore independently. Consolidate evidence. Execute the plan.</p></div>
                <div className="workspace-field">
                  <label htmlFor="workspace-input">Workspace</label>
                  <div className="workspace-control">
                    <input id="workspace-input" value={workspace} onChange={(event) => { setWorkspace(event.target.value); setWorkspaceError(''); }} placeholder="Choose a project folder or enter its path" spellCheck="false" aria-invalid={Boolean(workspaceError)} aria-describedby={workspaceError ? 'workspace-error' : undefined} />
                    <button type="button" onClick={browseForWorkspace} disabled={choosingWorkspace || workflowLocked} aria-label="Browse for workspace folder" title="Browse for workspace folder"><Icon name="paperclip" size={17} /></button>
                  </div>
                  {workspaceError ? <small id="workspace-error" className="field-error">{workspaceError}</small> : null}
                </div>
                <div className="task-field">
                  <label htmlFor="task-input">Task</label>
                  <div className="task-control">
                    <textarea ref={taskInputRef} id="task-input" value={task} onChange={(event) => setTask(event.target.value)} onFocus={() => setTaskFocused(true)} onBlur={() => setTaskFocused(false)} maxLength={12000} placeholder="Describe the project, task, context, and constraints…" disabled={workflowLocked} />
                    <button className="add-attachment" type="button" onClick={() => attachmentInputRef.current?.click()} disabled={workflowLocked || uploadingAttachments || attachments.length >= MAX_ATTACHMENT_COUNT} aria-label="Add documents and images" title="Add documents and images"><Icon name="plus" size={18} /></button>
                    <input ref={attachmentInputRef} className="attachment-input" type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={addAttachments} tabIndex={-1} aria-hidden="true" />
                    <small className="counter">{task.length} / 12000</small>
                  </div>
                  {attachments.length || uploadingAttachments ? <div className="attachment-list" aria-live="polite">{attachments.map((attachment) => <span className="attachment-chip" key={attachment.id}><Icon name="file" size={13} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span><button type="button" onClick={() => removeAttachment(attachment)} disabled={workflowLocked} aria-label={`Remove ${attachment.name}`}><Icon name="x" size={12} /></button></span>)}{uploadingAttachments ? <span className="attachment-chip uploading"><span className="attachment-spinner" /><span><strong>Uploading…</strong><small>Securing attachment</small></span></span> : null}</div> : null}
                </div>
                <div className="intake-actions">
                  {correctionApproval ? null : running ? (
                    <button className="stop-button" onClick={stopWorkflow}><Icon name="stop" />Stop</button>
                  ) : ['complete', 'failed'].includes(phase) && completedRunName ? (
                    <button className="primary" onClick={executeCompletedRun ? executeJudgedPath : continueCompletedRun} disabled={!completedRun}><Icon name={executeCompletedRun ? 'play' : 'refresh'} />{executeCompletedRun ? 'Execute plan' : 'Continue in new revision'}</button>
                  ) : (
                    <button className="primary" onClick={startWorkflow} disabled={!task.trim() || availableCount < 2}><Icon name="play" />Start workflow</button>
                  )}
                </div>
              </section>

              <section className="pipeline" aria-label="Workflow progress">
                <Stage index="1" label="Initialize" caption="Start the conductor" state={compactStageState('initialize')} />
                <Stage index="2" label="Plan" caption="Produce investigation brief" state={compactStageState('plan')} />
                <Stage index="3" label="Explore" caption="Run experts in parallel" state={compactStageState('explore')} />
                <Stage index="4" label="Judge" caption="Produce execution plan" state={compactStageState('judge')} />
                <Stage index="5" label="Execute" caption="Execute plan" state={compactStageState('execute')} />
                <Stage index="6" label="Verify" caption="Verify independently" state={compactStageState('verify')} />
              </section>

              <section className="run-workspace">
                <div className="experts-panel">
                  <div className="panel-heading"><span>Experts <small>(read-only)</small></span><span className="availability"><b />{availableCount} CLIs available</span></div>
                  <div className="expert-list">
                    {activeExplorers.map((expert) => <ExpertRow key={expert.key} expert={expert} status={expertProgress[expert.key]?.status || 'ready'} detail={expertProgress[expert.key]?.detail || 'Ready for an independent pass.'} />)}
                  </div>
                </div>
                <div className="evidence-panel">
                  <div className="panel-heading"><span>Judge &amp; evidence</span><span className={`judge-state ${running ? 'running' : ''} ${phase}`}><b />{phase === 'verified' ? 'Verified' : phase === 'awaiting_correction_approval' ? 'Paused for approval' : phase === 'complete' ? 'Plan ready' : phase === 'verify' ? 'Verifying' : phase === 'execute' ? 'Executing' : phase === 'judge' ? 'Producing plan' : phase === 'consolidate' ? 'Consolidating' : phase === 'explore' ? 'Exploring' : phase === 'plan' ? 'Planning' : phase === 'initialize' ? 'Initializing' : phase === 'failed' ? 'Failed' : 'Waiting'}</span></div>
                  <div className="evidence-scroll">
                    <WorkflowLifecycle stageState={stageState} expertProgress={expertProgress} phase={phase} explorers={activeExplorers} activityMessages={activityMessages} />
                    {judgeDecision ? (
                      <section className="judge-decision" aria-labelledby="judge-decision-title">
                        <div className="judge-decision-heading"><span>Execution plan</span><b>Ready to execute</b></div>
                        <h2 id="judge-decision-title">{judgeDecision.verdict}</h2>
                        <div className="decision-confidence">{judgeDecision.confidence !== null ? <><strong>{judgeDecision.confidence}%</strong><span>reported confidence</span></> : <><strong>Evidence-backed</strong><span>the judge did not report a numeric confidence score</span></>}</div>
                        {judgeDecision.reasons.length ? <><h3>Available evidence</h3><ul>{judgeDecision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></> : <p>The detailed comparison and evidence are available in the saved judge report.</p>}
                        {judgeDecision.concerns.length ? <><h3>Material concerns</h3><ul>{judgeDecision.concerns.map((concern) => <li key={concern}>{concern}</li>)}</ul></> : null}
                        <small>{executionStarted ? phase === 'verified' ? 'Execution and verification complete.' : 'Proceeding through execution…' : 'Ready for your execution command.'}</small>
                      </section>
                    ) : null}
                    <details className="activity-log">
                      <summary><span>Raw output</span><small>{logs.length ? `${logs.length} lines` : 'No output yet'}</small></summary>
                      <div className="output" ref={outputRef}>
                        {logs.length ? logs.map((line, index) => <div key={`${index}-${line.slice(0, 16)}`}><time>{new Date().toLocaleTimeString([], { hour12: false })}</time><code>{line}</code></div>) : <div className="output-empty"><Icon name="terminal" size={28} /><strong>No raw process output yet</strong><span>Diagnostic output is retained here when the conductor starts.</span></div>}
                      </div>
                    </details>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {view === 'chat' ? <Suspense fallback={<div className="view-loading">Loading chat…</div>}><ChatSession /></Suspense> : null}
          {view === 'runs' ? <RunDetail run={selectedRun} detail={runDetail} runs={runs} onSelect={selectRun} onResume={openResume} resumeDraft={resumeDraft} onResumeInstruction={(instruction) => setResumeDraft((current) => ({ ...current, instruction, drift: null }))} onSubmitResume={submitResume} onCancelResume={cancelResume} resuming={resuming} onBack={() => { setSelectedRun(null); setRunDetail(null); }} /> : null}
          {view === 'gateways' ? <Gateways integrations={cliIntegrations} session={terminalSession} openingId={gatewayOpening} onOpen={openGateway} onClose={closeGateway} onTerminalError={setError} /> : null}
          {view === 'settings' ? <Settings themePreference={themePreference} onThemeChange={setThemePreference} colourScheme={colourScheme} onColourSchemeChange={setColourScheme} autonomousAgent={autonomousAgent} onAutonomousAgentChange={setAutonomousAgent} optionalExplorers={system.optionalExplorers || []} onOptionalExplorerChange={toggleOptionalExplorer} workflowActive={workflowLocked} integrations={cliIntegrations} onAddCli={addCliIntegration} onRemoveCli={removeCliIntegration} onCliEnabledChange={toggleCliIntegration} /> : null}
        </main>
      </div>

      {deleteDialogOpen ? <div className="modal-backdrop"><section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description"><div className="delete-dialog-icon"><Icon name="stop" size={20} /></div><div className="delete-dialog-copy"><h2 id="delete-dialog-title">Delete {runsMarkedForDeletion.size} saved {runsMarkedForDeletion.size === 1 ? 'run' : 'runs'}?</h2><p id="delete-dialog-description">This permanently removes the selected reports and logs from MoA Runs. This action cannot be undone.</p></div><div className="delete-dialog-actions"><button onClick={() => setDeleteDialogOpen(false)}>Cancel</button><button className="confirm-delete" onClick={deleteSelectedRuns}>Delete permanently</button></div></section></div> : null}
    </div>
  );
}

function ResumePanel({ run, detail, draft, onInstruction, onSubmit, onCancel, resuming }) {
  if (draft.runName !== run.name) return null;
  const inherited = (() => { try { return JSON.parse(detail?.files?.['inherited-context.json'] || '{}').inheritedFrom || {}; } catch { return {}; } })();
  const inheritedNames = Object.values(inherited).map(({ artifact }) => artifact);
  const drift = draft.drift;
  return <section className="resume-panel" aria-labelledby="resume-title">
    <div className="resume-panel-heading"><span><Icon name="refresh" size={17} /><strong id="resume-title">Resume Run</strong></span><button onClick={onCancel} aria-label="Cancel resume"><Icon name="x" size={15} /></button></div>
    <dl><div><dt>Run</dt><dd>Revision {run.revision || 1} · {run.name}</dd></div><div><dt>Workspace</dt><dd>{run.workspace}</dd></div><div><dt>Latest completed stage</dt><dd>{run.latestCompletedStage || 'None recorded'}</dd></div><div><dt>Inherited context</dt><dd>{inheritedNames.length ? inheritedNames.join(', ') : 'Plan, execution record, verification, and available run artifacts will be referenced by hash.'}</dd></div></dl>
    <label>Next requested change<textarea value={draft.instruction} onChange={(event) => onInstruction(event.target.value)} maxLength={12000} placeholder="Describe what should change in the next revision…" autoFocus /></label>
    {drift ? <div className={`drift-warning ${drift.severity}`} role="alert"><strong>Workspace drift detected</strong><p>{drift.reason}</p>{drift.changedPaths?.length ? <small>{drift.changedPaths.slice(0, 8).join(' · ')}</small> : null}<p>MoA will create a new linked run and revalidate the current workspace. The parent remains unchanged.</p></div> : null}
    <div className="resume-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onSubmit(Boolean(drift))} disabled={resuming || !draft.instruction.trim()}><Icon name="refresh" size={15} />{resuming ? 'Creating revision…' : drift ? 'Confirm drift & resume' : 'Resume Run'}</button></div>
  </section>;
}

function RunDetail({ run, detail, runs, onSelect, onResume, resumeDraft, onResumeInstruction, onSubmitResume, onCancelResume, resuming, onBack }) {
  if (!run) {
    const groups = groupProjectRuns(runs);
    return <section className="library"><div className="page-heading"><h1>Project history</h1><p>Related runs are grouped into immutable revision chains.</p></div><div className="project-history">{groups.map((group) => <section className="project-group" key={group.rootRunId}><header><strong>{group.runs[0]?.task || 'Untitled project'}</strong><small>{group.workspace}</small><span>{group.runs.length} {group.runs.length === 1 ? 'revision' : 'revisions'}</span></header><div className="library-list">{group.runs.map((item) => <RunItem key={item.name} run={item} onSelect={onSelect} onResume={onResume} />)}</div></section>)}</div></section>;
  }
  const files = detail?.files || {};
  const parent = run.parentRunId ? runs.find((item) => item.runId === run.parentRunId) : null;
  const children = runs.filter((item) => item.parentRunId === run.runId);
  const reportFiles = ['continuation-context.md', 'investigation-brief.md', 'codex.md', 'antigravity.md', 'opencode.md', 'claude.md', 'openclaw.md', 'hermes.md', 'evidence.md', ...Object.keys(files).filter((file) => /^(?:execution|verification)-attempt-\d+\.md$|^correction-approval-attempt-\d+\.json$/.test(file)).sort(), 'execution.md', 'verification.md'];
  return <section className="run-detail"><div className="page-heading run-detail-heading"><button className="back" onClick={onBack}>Project history /</button><h1>{run.task}</h1><p>{run.workspace}</p><div className="run-lineage"><span>Revision {run.revision || 1}</span><span>Verify: {run.verificationStatus || 'not-run'}</span>{parent ? <button onClick={() => onSelect(parent)}>Parent · revision {parent.revision}</button> : <span>Root run</span>}{children.map((child) => <button key={child.name} onClick={() => onSelect(child)}>Child · revision {child.revision}</button>)}</div><button className="resume-run" onClick={() => onResume(run)} disabled={!run.resumeEligible}><Icon name="refresh" size={16} />Resume Run</button>{run.resumeIssue ? <small className="resume-issue">{run.resumeIssue}</small> : null}</div><ResumePanel run={run} detail={detail} draft={resumeDraft} onInstruction={onResumeInstruction} onSubmit={onSubmitResume} onCancel={onCancelResume} resuming={resuming} /><div className="report-grid"><article><h2>Execution plan</h2><pre>{files['judge.md'] || 'No execution plan was produced for this run.'}</pre></article><aside>{reportFiles.map((file) => <details key={file}><summary>{file.replace(/\.(?:md|json)$/, '').replaceAll('-', ' ')}</summary><pre>{files[file] || 'No report.'}</pre></details>)}</aside></div></section>;
}

function Gateways({ integrations, session, openingId, onOpen, onClose, onTerminalError }) {
  return (
    <section className="gateways">
      <div className="page-heading"><h1>CLI gateways</h1><p>Open any available CLI in an interactive TUI within MoA.</p></div>
      <div className="gateway-list">
        {integrations.map((integration) => {
          const active = session?.cliId === integration.id;
          const opening = openingId === integration.id;
          const installed = integration.gatewayAvailable ?? integration.available;
          const available = installed && integration.enabled;
          return (
            <div className={`gateway ${integration.id} ${active ? 'active' : ''}`} key={integration.id}>
              <span className="expert-mark">{integration.mark}</span>
              <span><strong>{integration.label}</strong><small>{integration.gatewayVersion || integration.version || 'Checking installation…'}</small></span>
              <span className={available ? 'online' : 'offline'}>{available ? 'Available' : integration.enabled ? 'Unavailable' : 'Disabled'}</span>
              <button onClick={() => onOpen(integration.id)} disabled={!available || Boolean(openingId) || active} title={!integration.enabled ? `${integration.label} is disabled in Settings` : !installed ? `${integration.label} is not installed` : undefined}><Icon name="terminal" />{opening ? 'Opening…' : active ? 'Running' : 'Open gateway'}</button>
            </div>
          );
        })}
      </div>
      {session ? (
        <Suspense fallback={<div className="embedded-terminal terminal-loading" role="status">Starting {session.label}…</div>}>
          <EmbeddedTerminal session={session} onClose={onClose} onError={onTerminalError} />
        </Suspense>
      ) : null}
    </section>
  );
}

function Settings({ themePreference, onThemeChange, colourScheme, onColourSchemeChange, autonomousAgent, onAutonomousAgentChange, optionalExplorers, onOptionalExplorerChange, workflowActive, integrations, onAddCli, onRemoveCli, onCliEnabledChange }) {
  const [cliForm, setCliForm] = useState({ label: '', command: '', launcher: '' });
  const [cliError, setCliError] = useState('');
  const [savingCli, setSavingCli] = useState(false);
  const [savingCliToggle, setSavingCliToggle] = useState('');
  const [explorerError, setExplorerError] = useState('');
  const [savingExplorer, setSavingExplorer] = useState('');
  const displayedOptionalExplorers = optionalExplorers.length ? optionalExplorers : [
    { id: 'openclaw', label: 'OpenClaw', available: false, enabled: false, loading: true },
    { id: 'hermes', label: 'Hermes Agent', available: false, enabled: false, loading: true },
  ];

  const updateCliField = (field, value) => {
    setCliForm((current) => ({ ...current, [field]: value }));
    setCliError('');
  };

  const submitCli = async (event) => {
    event.preventDefault();
    setSavingCli(true);
    const message = await onAddCli(cliForm);
    setSavingCli(false);
    if (message) { setCliError(message); return; }
    setCliForm({ label: '', command: '', launcher: '' });
  };

  const toggleExplorer = async (id, enabled) => {
    setSavingExplorer(id);
    setExplorerError('');
    const message = await onOptionalExplorerChange(id, enabled);
    setSavingExplorer('');
    if (message) setExplorerError(message);
  };

  const toggleCli = async (id, enabled) => {
    setSavingCliToggle(id);
    setCliError('');
    const message = await onCliEnabledChange(id, enabled);
    setSavingCliToggle('');
    if (message) setCliError(message);
  };

  return (
    <section className="settings">
      <div className="page-heading"><h1>Settings</h1><p>Configure how MoA looks and behaves.</p></div>
      <section className="settings-card" aria-labelledby="automation-heading">
        <div className="settings-card-heading"><h2 id="automation-heading">Automation</h2><p>Choose how MoA proceeds after the judge produces an execution plan.</p></div>
        <label className="automation-setting">
          <span><strong>Autonomous agent</strong><small>Automatically execute the plan after judging completes successfully.</small></span>
          <input type="checkbox" role="switch" checked={autonomousAgent} onChange={(event) => onAutonomousAgentChange(event.target.checked)} />
          <span className="toggle-track" aria-hidden="true"><i /></span>
        </label>
      </section>
      <section className="settings-card" aria-labelledby="optional-explorers-heading">
        <div className="settings-card-heading"><h2 id="optional-explorers-heading">Optional explorers</h2><p>Add installed agent harnesses as independent read-only evidence passes. They never judge, execute, verify, communicate with other explorers, or replace the default agents.</p></div>
        <div className="optional-explorer-list">
          {displayedOptionalExplorers.map((explorer) => <label className={`automation-setting optional-explorer ${!explorer.available ? 'unavailable' : ''}`} key={explorer.id}>
            <span><strong>{explorer.label}</strong><small>{explorer.loading ? 'Checking installation…' : explorer.available ? `${explorer.version} · ${explorer.enabled ? 'Enabled for new workflows.' : 'Off by default; enable for new workflows.'}` : 'Not installed or unavailable.'}</small></span>
            <input type="checkbox" role="switch" checked={explorer.enabled} disabled={!explorer.available || workflowActive || savingExplorer === explorer.id} onChange={(event) => toggleExplorer(explorer.id, event.target.checked)} />
            <span className="toggle-track" aria-hidden="true"><i /></span>
          </label>)}
        </div>
        {explorerError ? <p className="optional-explorer-error" role="alert">{explorerError}</p> : null}
      </section>
      <section className="settings-card" aria-labelledby="appearance-heading">
        <div className="settings-card-heading"><h2 id="appearance-heading">Appearance</h2><p>Choose a theme or follow your system setting.</p></div>
        <div className="theme-options">{THEME_OPTIONS.map((option) => <button key={option.value} className={themePreference === option.value ? 'selected' : ''} onClick={() => onThemeChange(option.value)} aria-pressed={themePreference === option.value}><span className="theme-option-icon"><Icon name={option.icon} size={20} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span>{themePreference === option.value ? <Icon name="check" size={17} /> : null}</button>)}</div>
        <div className="settings-card-heading colour-heading"><h2>Colour scheme</h2><p>Change the full interface palette without altering the MoA layout.</p></div>
        <div className="colour-options">{COLOUR_SCHEMES.map((scheme) => <button key={scheme.value} className={colourScheme === scheme.value ? 'selected' : ''} onClick={() => onColourSchemeChange(scheme.value)} aria-pressed={colourScheme === scheme.value}><span className="scheme-swatches" aria-hidden="true">{scheme.colors.map((color) => <i key={color} style={{ background: color }} />)}</span><strong>{scheme.label}</strong>{colourScheme === scheme.value ? <Icon name="check" size={15} /> : null}</button>)}</div>
      </section>

      <section className="settings-card cli-settings" aria-labelledby="cli-integrations-heading">
        <div className="settings-card-heading"><h2 id="cli-integrations-heading">CLI integrations</h2><p>Enable supported agents for new workflows and chat, and control every integration&apos;s gateway access. MoA checks each binary with <code>--version</code>; an optional launcher enables custom tools on the Gateways screen.</p></div>
        <div className="cli-integration-list">
          {integrations.map((integration) => <div className={`cli-integration ${integration.id} ${integration.enabled ? '' : 'disabled'}`} key={integration.id}><span className="cli-mark">{integration.mark}</span><span className="cli-integration-copy"><strong>{integration.label}</strong><small><code>{integration.command}</code> · {integration.available ? integration.version : 'Unavailable'}</small></span><span className={integration.enabled && integration.available ? 'online' : 'offline'}>{integration.enabled ? integration.available ? 'Available' : 'Unavailable' : 'Disabled'}</span><span className="cli-integration-actions">{integration.builtIn ? <span className="built-in-label">Built in</span> : <button className="remove-cli" onClick={() => onRemoveCli(integration.id)} aria-label={`Remove ${integration.label}`}><Icon name="x" size={15} />Remove</button>}<label className="cli-enabled-toggle" title={`${integration.enabled ? 'Disable' : 'Enable'} ${integration.label}`}><input type="checkbox" role="switch" checked={integration.enabled} disabled={workflowActive || savingCliToggle === integration.id || (!integration.gatewayAvailable && !integration.enabled)} onChange={(event) => toggleCli(integration.id, event.target.checked)} aria-label={`${integration.enabled ? 'Disable' : 'Enable'} ${integration.label}`} /><span className="toggle-track" aria-hidden="true"><i /></span></label></span></div>)}
        </div>
        <form className="cli-form" onSubmit={submitCli}>
          <div className="cli-form-heading"><strong>Add a CLI</strong><small>Command arguments are intentionally not accepted.</small></div>
          <div className="cli-form-grid">
            <label>Name<input value={cliForm.label} onChange={(event) => updateCliField('label', event.target.value)} maxLength={40} placeholder="Claude" required /></label>
            <label>Binary or executable path<input value={cliForm.command} onChange={(event) => updateCliField('command', event.target.value)} maxLength={300} placeholder="claude or /opt/homebrew/bin/claude" spellCheck="false" required /></label>
            <label className="launcher-field">Terminal launcher <small>(optional absolute path)</small><input value={cliForm.launcher} onChange={(event) => updateCliField('launcher', event.target.value)} maxLength={500} placeholder="/absolute/path/Claude.command" spellCheck="false" /></label>
          </div>
          {cliError ? <p className="cli-form-error" role="alert">{cliError}</p> : null}
          <div className="cli-form-actions"><button className="primary" type="submit" disabled={savingCli || !cliForm.label.trim() || !cliForm.command.trim()}><Icon name="network" />{savingCli ? 'Checking CLI…' : 'Add CLI'}</button></div>
        </form>
      </section>
    </section>
  );
}

export default App;

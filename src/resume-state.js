export const EMPTY_RESUME_DRAFT = Object.freeze({ runName: '', instruction: '', drift: null, inheritedFrom: null });

export const readResumeDraft = (storage) => {
  try {
    const value = JSON.parse(storage?.getItem('moa-resume-draft') || 'null');
    return value && typeof value.runName === 'string' && typeof value.instruction === 'string'
      ? { ...EMPTY_RESUME_DRAFT, ...value }
      : { ...EMPTY_RESUME_DRAFT };
  } catch {
    return { ...EMPTY_RESUME_DRAFT };
  }
};

export const writeResumeDraft = (storage, draft) => {
  try {
    if (draft?.runName) storage?.setItem('moa-resume-draft', JSON.stringify(draft));
    else storage?.removeItem('moa-resume-draft');
  } catch { /* Resume draft persistence is best effort. */ }
};

export const groupProjectRuns = (runs) => {
  const groups = new Map();
  for (const run of runs) {
    const root = run.rootRunId || run.runId || run.name;
    const group = groups.get(root) || { rootRunId: root, workspace: run.workspace, runs: [] };
    group.runs.push(run);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, runs: group.runs.sort((left, right) => (left.revision || 1) - (right.revision || 1) || left.name.localeCompare(right.name)) }))
    .sort((left, right) => (right.runs.at(-1)?.name || '').localeCompare(left.runs.at(-1)?.name || ''));
};

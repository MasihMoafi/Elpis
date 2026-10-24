import { BridgeError, text } from './validate.mjs';

export const MOTHER_MODEL = 'claude/opus';
const SOL = 'gpt-6.1-sol', GEMINI = 'agy/gemini-4-argon-high';
export const WORKFLOW_PRESETS = [
  { id: 'bug', name: 'Fix a bug', steps: ['Reproduce · GPT-6.1 Sol · low', 'Fix · GPT-6.1 Sol · high', 'Review · Gemini 4 Argon', 'Mother · Claude Opus 5.5 · review and merge'] },
  { id: 'ui', name: 'UI change', steps: ['Build · GPT-6.1 Sol · high', 'Screenshots · GPT-6.1 Sol · low', 'Review · Gemini 4 Argon', 'Mother · Claude Opus 5.5 · review and merge'] },
];

/** Three bounded children, followed by Mother's guarded review/merge. No recursive planning or hidden checks. */
export function workflowPreset(id, goal) {
  const preset = WORKFLOW_PRESETS.find(preset => preset.id === id);
  if (!preset) throw new BridgeError('Choose an existing workflow');
  text(goal, 'task', 8000);
  const node = (id, title, instruction, dependsOn, extra = {}) => ({ id, title, instruction: `Task: ${goal}\n\n${instruction}\nKeep the change small. Use existing project tools. Do not delegate, install, push or merge. ${extra.kind === 'verify' ? 'Read and run checks only. Do not commit.' : 'Stage files by name and commit only your changes.'} Report commands and observed results; say when a check could not run.`, kind: 'explore', dependsOn, writeScopes: ['.'], acceptanceCriteria: ['The task has observed evidence'], model: SOL, provider: 'openai', reasoningEffort: 'low', ...extra });
  const review = dependsOn => node('review', 'Review', 'Independently inspect the candidate diff, rerun the focused checks and check the negative case. Do not change files. For UI work inspect both screenshots; if images or a browser check are missing, fail. Return only JSON {"passed":true or false,"summary":"observed evidence"}.', dependsOn, { kind: 'verify', model: GEMINI, provider: 'agy', reasoningEffort: undefined, writeScopes: [] });
  const tasks = id === 'bug' ? [
    node('reproduce', 'Reproduce', 'Write the smallest regression test under tests/ that reproduces the reported bug. Run it and observe the expected failure. Do not change production code or apply any fix, including uncommitted edits. This step ends immediately after committing the regression test. If the failure cannot be reproduced, stop and report that clearly. Include the command and failing output in your answer.', [], { writeScopes: ['tests'] }),
    node('fix', 'Fix', 'Use the committed reproduction from the connected agent. Make the smallest fix; run the reproduction and the nearest relevant regression checks, including the negative case. Commit only the fix. Do not weaken or delete the reproduction.', ['reproduce'], { kind: 'implement', reasoningEffort: 'high' }),
    review(['fix']),
  ] : [
    node('build', 'Build', 'Implement the requested UI change using the project design system. Run the focused checks and build. Commit the change.', [], { kind: 'implement', reasoningEffort: 'high' }),
    node('screenshots', 'Screenshots', 'Start the project using its documented local preview, use its existing Playwright/browser tooling to capture the changed screen in light and dark at 1440x900, inspect both for alignment, legibility and overflow, then stop your preview. Save screenshots and a short evidence report under artifacts/workflow and commit them. If a real browser capture cannot run, report failure; do not invent evidence.', ['build'], { writeScopes: ['artifacts/workflow'] }),
    review(['build', 'screenshots']),
  ];
  return { name: preset.name, goal, tasks, isolation: 'worktree', autoMerge: true, maxConcurrency: 1, maxRuntimeSeconds: 600 };
}

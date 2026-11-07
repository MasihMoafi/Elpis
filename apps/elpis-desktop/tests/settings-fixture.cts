// The /api/settings body the Settings pages need, for tests that serve their own routes through parity-fixture.cts.
const settingsBody = (extra: Record<string, unknown>) => ({ version: 'v1', main: { model: 'main-model', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
  smartPrune: { enabled: true, explicitOverride: { available: true, model: null, provider: null, version: 'p1' } }, memory: { enabled: false, generate: null, use: null, skipExternalContext: null, extractionModel: null, consolidationModel: null },
  options: { defaultPermissions: 'full', webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: null, developerInstructions: null, projectRootMarkers: null, worktreeRoot: null },
  managed: { allowedApprovalPolicies: null, allowedSandboxModes: ['read-only', 'workspace-write'] }, write: { available: true, reason: 'Applies to new conversations.' }, ...extra });
module.exports = { settingsBody };

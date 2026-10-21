// The transport and packager use the TUI's exact runtime asset set.
export const DASHBOARD_ASSETS = ['index.html', 'dashboard.css', 'dashboard.js', 'dashboard_workflows.js'];
// TUI picker identities differ from the native models' routing prefixes.
export const DASHBOARD_SUBSCRIPTIONS = [
  { id: 'claude-subscription', prefix: 'claude/', name: 'Claude subscription' },
  { id: 'antigravity', prefix: 'agy/', name: 'Antigravity' },
];

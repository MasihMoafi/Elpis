const files = () => [
  { name: 'ES.md', path: '/tmp/parity-fixture/ES.md', group: 'sessionContinuity', estimatedTokens: 1250, included: true, reason: 'Latest checkpoint', selectable: true },
  { name: 'MEMORY.md', path: '/tmp/memory/MEMORY.md', group: 'durableMemory', estimatedTokens: 230, included: false, reason: 'Excluded by Ledger', selectable: true },
  { name: 'AGENTS.md', path: '/tmp/parity-fixture/AGENTS.md', group: 'instructions', estimatedTokens: 500, included: true, reason: 'Project instructions', selectable: true },
  { name: 'A very long configured instruction file with Persian متن and spaces.md', path: '/tmp/instructions/A very long configured instruction file with Persian متن and spaces.md', group: 'instructions', estimatedTokens: 70, included: true, reason: 'Required instructions', selectable: false },
];
function contextRoutes() {
  const rows = files();
  return {
    '/api/threads/chat-a/context': () => ({ threadId: 'chat-a', ledger: { used: 50000, window: 200000, categories: [{ id: 'toolResults', label: 'Tool results', tokens: 50000 }] } }),
    '/api/threads/chat-a/context-files': body => { if (body) rows.find(row => row.path === body.path).included = body.included; return { files: rows }; },
  };
}
module.exports = { files, contextRoutes };

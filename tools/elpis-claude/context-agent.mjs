// Keep the upstream ACP adapter and add a read-only view of Claude's own admitted memory files.
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { v1AgentApp } from './node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js';
import { applyManagedPolicyEnv } from './node_modules/@agentclientprotocol/claude-agent-acp/dist/managed-policy.js';
import { nodeToWebReadable, nodeToWebWritable } from './node_modules/@agentclientprotocol/claude-agent-acp/dist/utils.js';

await applyManagedPolicyEnv();
console.log = console.error;
console.info = console.error; console.debug = console.error;
let agent;
const app = v1AgentApp(console, value => { agent = value; }).onRequest('_elpis/contextFiles', { parse: params => {
  if (typeof params?.sessionId !== 'string') throw new Error('Choose a Claude session.');
  return params;
} }, async ({ params }) => {
  const session = agent?.sessions[params.sessionId];
  if (!session) throw new Error('Claude session is not loaded.');
  // Summary is local: full detail would make token-count API calls for each category.
  const usage = await session.query.getContextUsage({ detail: 'summary' });
  return { files: usage.memoryFiles.map(file => ({ path: file.path, estimatedTokens: file.tokens })) };
});
const connection = app.connect(ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin)));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await agent?.dispose().catch(error => console.error(error));
  process.exit(0);
}
connection.closed.then(shutdown);
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.stdin.resume();

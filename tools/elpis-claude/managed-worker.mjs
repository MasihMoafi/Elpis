#!/usr/bin/env node
// The self-hosted worker for an Anthropic Managed Agents environment: it claims that environment's work and runs the
// agent's tools (bash, read, write, edit, glob, grep) in one folder on this machine. Start it through
// managed-worker.sh, which confines it with bubblewrap; never with an API key in its environment (Anthropic's docs:
// an organisation key there is visible to the agent's tool calls).
import Anthropic from '@anthropic-ai/sdk';
import { EnvironmentWorker } from '@anthropic-ai/sdk/helpers/beta/environments';

const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY;
const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID;
const workdir = process.argv[2] || process.env.ELPIS_MANAGED_WORKDIR;
for (const [name, value] of [['ANTHROPIC_ENVIRONMENT_KEY', environmentKey], ['ANTHROPIC_ENVIRONMENT_ID', environmentId], ['workdir', workdir]])
  if (!value) { console.error(`managed-worker: missing ${name}`); process.exit(2); }
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  if (process.env[name]) { console.error(`managed-worker: refusing to run with ${name} set`); process.exit(2); }

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());

const client = new Anthropic({ authToken: environmentKey });
console.error(`managed-worker: polling ${environmentId}; tools run in ${workdir}`);
try {
  await new EnvironmentWorker({ client, environmentId, environmentKey, workdir, signal: stop.signal }).run();
} catch (error) {
  if (!stop.signal.aborted) { console.error(`managed-worker: ${error?.message ?? error}`); process.exit(1); }
}
console.error('managed-worker: stopped');

#!/usr/bin/env bash
set -euo pipefail

mkdir -p apps/elpis-desktop/bridge/resources
for resource in permission-policy.mjs workflow-concurrency.mjs mcp-session-selections.mjs; do
  cp "tools/elpis-claude/$resource" "apps/elpis-desktop/bridge/resources/$resource"
done

node scripts/store-guard.test.cjs
node scripts/history-list.test.cjs
node --test tools/elpis-claude/test/acp-mcp-servers.test.mjs apps/elpis-desktop/bridge/mcp-session-selections.test.mjs
node --test tools/elpis-claude/test/bridge-log-errors.test.mjs
node --test --test-name-pattern='the saved concurrency controls the next work across workflow runs' tools/elpis-claude/test/workflow-runner.test.mjs
node --test tools/elpis-claude/test/resume-list.test.mjs
node --test tools/elpis-claude/test/bridge-idle.test.mjs
node --test --test-concurrency=1 tools/elpis-claude/test/approval-review.test.mjs tools/elpis-claude/test/delegate-start.test.mjs
node --test --test-concurrency=1 tools/elpis-claude/test/context-agent-worker.test.mjs
node --test --test-name-pattern="a Workflows node's chat starts" tools/elpis-claude/test/elpis-acp-agent.test.mjs
node scripts/bridge-launcher.test.cjs
node scripts/agy-steering.test.cjs
node scripts/build-elpis-local.test.cjs

// CI gate for workflows that run until they finish (SPEC WR1–WR8): the runner's rules with a scripted executor (and as
// properties over random scripts), and
// the chat tool through the real shared bridge with a scripted engine and Claude. The real-engine journey is
// tests/workflow-run.runtime.mjs.
await import('../../../tools/elpis-claude/test/workflow-runner.test.mjs');
await import('../../../tools/elpis-claude/test/workflow-properties.test.mjs');
await import('../../../tools/elpis-claude/test/workflow-bridge.test.mjs');

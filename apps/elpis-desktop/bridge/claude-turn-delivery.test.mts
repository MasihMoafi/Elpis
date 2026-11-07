// CI regression gate. The host acceptance script uses the packaged app and real engine.
import { fileURLToPath } from 'node:url';
process.env.A124_ENGINE ??= fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-app-server.mjs', import.meta.url));
await import('../../../tools/elpis-claude/test/claude-turn-record.test.mjs');
await import('../../../tools/elpis-claude/test/turn-delivery.test.mjs');

# Adding a Source

Adapted from dsh-superagent `docs/008-cookbook.md`. The contract is [sources/kind.mts](../../../apps/elpis-desktop/bridge/router/sources/kind.mts); follow the GitHub and Elpis chat implementations.

1. Choose stable Trigger ids, Thread keys, native actor ids, receiving scopes and Channel addresses. Replays must be idempotent.
2. Define the kind's configuration schema, form fields, setup facts and owned health entries. Defaults should receive nothing.
3. Translate validated external records into Triggers, excluding the Source's own outgoing messages. Preserve untrusted text as data.
4. Implement scope from stored metadata and configuration. Declare which rows receive unaddressed messages.
5. Add a Source-native allowed list, bot policy and admission rows. Cross-Source identity equivalence belongs in team knowledge.
6. Implement idempotent Channel delivery. Return gone only for permanent loss; throw on retryable errors. The Outbox owns receipts and ordering.
7. Supply bounded context pages, root/parent reads and optional images. Return stable cursors and normalized messages.
8. Register execution variables without credentials. Put durable cursors in the typed KV registry, with one writer per key.
9. Register the kind in MotherApp, start its abortable loop after setup, and await it during shutdown. Advance cursors only after intake commits. Keep per-item failures and require consecutive poll failures before attention.
10. Add focused node:test cases at the external process boundary: successful intake, out-of-scope filtering, replay, interruption, send failure, pagination and shutdown. Add the module/assets to desktop/package.mts and the tests to test-inventory.json.

The panel builds Source settings and admission forms from the kind's fields; a new kind needs custom UI only when those fields cannot express its behavior.

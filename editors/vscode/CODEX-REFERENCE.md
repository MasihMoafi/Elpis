# User-provided Codex extension reference

Masih supplied ten screenshots dated 2026-09-08, 22:48:29 through 22:49:26. They define the requested interaction and appearance; the current editor-tab prototype is not accepted parity.

Required outcomes, in implementation order:

1. Models come from Elpis's runtime catalog, including the user's current models. Preserve custom IDs; never substitute a short static list for the native catalog. Verify a model known only to the runtime appears and can be selected.
2. A sidebar chat with a bottom-anchored rounded composer. Put a checked model menu beside the composer, with supported reasoning efforts from the runtime. Compare screenshots at the user's sidebar width in light and dark themes.
3. Compact IDE-context and approval controls beside the model. Display only policies the runtime/bridge actually enforces; demonstrate enabled/disabled context and approval behavior. A reference screenshot showing full access does not prove our bridge supports it.
4. Recent chats and searchable history that genuinely resume Elpis threads. Demonstrate persisted history and recovery after reopening VS Code; no decorative rows.
5. Settings that operate on Elpis configuration, including supported model effort and composer behavior. Account/billing, hooks, plugins and MCP controls require real backing functionality before being displayed.

Current state (extension 0.1.3 candidate): secondary-sidebar hosting, an in-composer model menu with runtime-advertised efforts, searchable workspace editor history with exact resume, native extension settings/config access, and configurable send shortcuts are implemented. Tests exercise a runtime-only model and resumed live editor tools. The model menu clipping at narrow widths was reproduced and fixed. The full custom settings layout, account/billing integration, archive controls, and composer-level approval-policy parity remain outside this candidate. Existing approval semantics stay read-only native tools plus reviewed editor edits. Masih has not accepted visual parity.

Resources: `src/extension.js`, `src/session.js`, `src/model-catalog.js`, `src/panel.js`, `assets/chat.js`; app-server `model/list`, thread list/read/resume APIs and protocol definitions. Use the existing app-server rather than creating another agent runtime. Final acceptance belongs to Masih.

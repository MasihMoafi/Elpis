---
name: conversation-cleanup
description: Review and clean up accumulated Elpis conversations, with a preview before deletion.
---

# Conversation cleanup

Use when the user asks to tidy, prune, or remove unwanted conversations.

1. Find the active Elpis state database from the user's configured home / SQLite directory. Do not assume a developer-specific path. Ask for the database if it cannot be resolved unambiguously. This workflow handles local stores; use the connected app-server thread list for remote stores.
2. Run `python3 scripts/preview.py --db <state-database>` from this skill directory. It opens SQLite read-only and prints conversation IDs, titles, directories, ages, and archive status. Optional `--older-than-days N` and `--cwd PATH` narrow the preview. These are selection aids, not evidence that a conversation is useless.
3. Present a compact inventory and propose a concrete set of IDs with reasons. Keep the current conversation and recent work. Review previews/transcripts where titles are inconclusive. Never infer worthlessness from age, shortness, or an empty title alone.
4. Ask the user to approve the exact set for permanent deletion, or offer reversible archive when they prefer it. An earlier explicit selection and deletion instruction already counts as approval. Do not delete anything merely because this skill was invoked.
5. For approved IDs, use the supported CLI: `elpis delete --force <UUID>` (or `elpis archive <UUID>` for archive). Deleting a parent also deletes its spawned descendants: include that scope in the review. Invoke each as an argument vector, never interpolate titles into a shell command. Never directly delete rollout files or edit SQLite: the app-server coordinates related records.
6. Record each successful/failed ID. Rerun the read-only preview to verify the result and report partial failure honestly. Do not retry rejected active-thread deletions by manipulating files.

For manual cleanup, `/resume` provides Delete (or Ctrl+X) on a selected conversation, followed by explicit confirmation.

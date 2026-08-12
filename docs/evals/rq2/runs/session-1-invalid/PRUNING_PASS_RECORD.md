# Session 1 pruning pass record

No qualifying Elpis pruning pass was produced for session `019ff148-e0d6-79e1-84ce-d352a866bdcb`.

Evidence:

- The child session has zero matching `compacted`, `context_prune`, `context_compacted`, or `prune` events in [`child-prune-events.tsv`](child-prune-events.tsv).
- The terminal/session completion record reports `server_overloaded` rather than a completed turn in [`task-complete.json`](task-complete.json).
- The six target tool-call/output pairs are preserved in [`target-captures.tsv`](target-captures.tsv), and the complete raw session is in [`elpis-session.jsonl`](elpis-session.jsonl).
- Because no qualifying pass exists, there is no replacement/summary representation and no item can be classified as removed/replaced.

The global `~/.elpis/logs/pruning/passes/` directory also contains records from the surrounding agent environment. Some of those records quote the child transcript inside outer evidence text, but their audit item `call_id`/`source_pointer` fields are outer-agent rollout IDs, not the child target-call IDs. They are not attributed to this child session and are not used as RQ2 evidence.

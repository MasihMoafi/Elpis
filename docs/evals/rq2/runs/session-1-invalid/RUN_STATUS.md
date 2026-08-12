# Session 1 run status

- Status: invalid; preserved, not rerun.
- Reason: Elpis completed the six target reads and natural filler investigation, then returned `server_overloaded` / `Selected model is at capacity` before a qualifying prune.
- Session ID: `019ff148-e0d6-79e1-84ce-d352a866bdcb`.
- Source commit: `0b832c3ef77ed29a658b694e73a0cd356a6fe99a`.
- Elpis binary SHA256: `782fd9859e1dd69aa5fb7074bfebf4dbd0e319574412cdc742926816a19ee0a1`.
- Model/provider: `gpt-5.6-luna` / `openai`.
- Configuration: read-only model shell (`-s read-only`), approvals never (`-a never`), memories disabled by CLI overrides, working directory `/home/masih/Desktop/p/elpis-rq2-final`, no alternate screen.
- Exact initial prompt: [`procedure/session-1-initial.txt`](../../procedure/session-1-initial.txt).
- Exact frozen final probe: [`procedure/frozen-final-probe.txt`](../../procedure/frozen-final-probe.txt); not issued because no qualifying prune occurred.
- Full Elpis transcript: [`elpis-session.jsonl`](elpis-session.jsonl).
- Full terminal capture: [`terminal-transcript.log`](terminal-transcript.log).
- Target capture extraction: [`target-captures.tsv`](target-captures.tsv).
- Emitted token/context trajectory: [`token-context-trajectory.tsv`](token-context-trajectory.tsv).
- Elpis child prune-event extraction: [`child-prune-events.tsv`](child-prune-events.tsv), empty.
- Terminal completion error: [`task-complete.json`](task-complete.json).

The run ended after 70,706 input tokens in the final emitted context, with a 258,400-token model context window. The session transcript contains no compaction/prune event and no final-probe response.

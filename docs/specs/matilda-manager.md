# SPEC: Matilda, one manager for Masih's agents

Status: requirements draft, awaiting Masih's approval. No implementation is authorized by this draft.

## Thesis

Masih gives Matilda a goal in one chat. She coordinates his existing and new Claude Code, Codex, Elpis, Gemini/agy and helper sessions, checks their work, and returns a result he can use. He decides product behavior and gives the permissions his rules require; she owns the technical process.

The reference is a research prototype, not an official DeepSeek product or a promise that its published design is complete ([prototype README:3](../../../ext/dsh-superagent-prototype/README.md#L3)). Elpis must implement the behavior afresh, using its existing capabilities where they fit.

## What Masih does and sees

- Give a goal, correction, status request or stop instruction in Matilda's chat. Work can continue while he does something else.
- Receive a short result, a concrete blocker, or a decision or permission request when one is required. Ordinary progress stays available on request, not as a stream of interruptions.
- Ask what is running and see each relevant session's task, model, state, next action and evidence; open its details when he wants them.
- See what was verified, what remains unverified and where the result is. A helper's claim alone never becomes a claim that the work is done.

## What Matilda does

1. Read the goal and the applicable project and machine rules; identify the active project, acceptance checks and existing work before acting. Ask about product behavior only when the answer changes the result.
2. Discover relevant live and resumable sessions across the named runtimes. Read their identity, working directory, task and current state before assigning work. Distinguish live, idle, ended, unavailable and unknown; an unknown state is never presented as idle.
3. Keep one record per goal: original request, decisions, constraints, tasks, ownership, model, session, worktree, status, messages, evidence and next action. Keep it across restarts and context compaction.
4. Break work into small, bounded goals with dependencies. Each helper receives the task ID, desired behavior, why, allowed and forbidden files, verified dependencies, acceptance test, required checks and requested report. Give each helper run one small goal.
5. Choose an allowed model and runtime for each task. Obtain the required permission before spawning; then start or steer the correct session, and confirm that the task was accepted. If a runtime cannot be reached or steered, say so; never pretend it received a message.
6. Run independent work in parallel only when scopes and machine capacity permit. Isolate writers in separate worktrees; serialize overlapping writes and integration. Do not take over or stop an unrelated session.
7. Watch state changes and completion without blocking useful work. Route a correction or stop to the right owner; retain pending messages, distinguish sent from accepted and processed, and prevent duplicate work after retries or restart.
8. Inspect the actual changes and evidence, run appropriate checks, and use the real app or TUI as Masih would before claiming visible behavior works. Retry bounded transient failures; preserve incomplete work and name any unresolved failure.
9. Integrate verified work one branch at a time into the authorized target. Check the target and base, preserve unmerged work, handle conflicts without discarding anyone's changes, and recheck the integrated result. Stop before any action that requires Masih's approval.
10. Report the outcome in the same chat in plain, short words. Include a decision or permission request only when necessary, and distinguish agent verification from Masih's acceptance.

The present manager's dispatch contract and isolation rules are in [multi-agent:8](../../../skills/multi-agent/SKILL.md#L8); its one-goal-per-helper practice is in [steps11.sh:2](../../../../../Work/tries/terra-logs/steps11.sh#L2). Those are process references, not claims that Matilda already enforces them.

## Reference and current gap

Each row compares a concrete reference behavior with the inspected Matilda path. A gap means the path shown does not provide that manager contract; it does not mean Elpis has no related feature elsewhere.

| Capability | Reference evidence | Current Elpis evidence and gap |
| --- | --- | --- |
| Route a request | The prototype routes candidates to new or existing tickets and limits attachments to the matching work ([dispatch:5](../../../ext/dsh-superagent-prototype/prompts/dispatch.md#L5)). | Matilda's mini chat sends text to Love Spot ([mini chat:86](../../apps/elpis-desktop/components/matilda-mini-chat.tsx#L86)); a cross-session goal router is needed. |
| Assign and steer | The prototype creates a worker session per ticket and steers inputs to it ([executor:24](../../../ext/dsh-superagent-prototype/src/executor/dsh.ts#L24), [executor:342](../../../ext/dsh-superagent-prototype/src/executor/dsh.ts#L342)). | Her talk path sends to its Love Spot thread ([talk:408](../../apps/elpis-desktop/bridge/love-spot-talk.mts#L408)); discovery and task delivery across existing runtimes need a manager interface. |
| Pick a helper | The prototype initializes a role's provider, model and effort for a new session ([role models:7](../../../ext/dsh-superagent-prototype/src/app/role-models.ts#L7)). Harness's experimental external delegation selects a configured runtime for a self-contained task; that tool is one-shot and cannot follow up ([external delegation:35](../../../ext/deepseek-harness/packages/experimental/tool-subagent-oar/src/index.ts#L35)). | Matilda's path selects her own provider and sends with low effort ([talk:374](../../apps/elpis-desktop/bridge/love-spot-talk.mts#L374), [talk:423](../../apps/elpis-desktop/bridge/love-spot-talk.mts#L423)). Per-task helper selection and steering are required. |
| Watch and recover | The prototype records delivered inputs, reports and interruptions ([assignments:33](../../../ext/dsh-superagent-prototype/src/core/assignments.ts#L33)); it classifies waiting, failure and review states ([stage:4](../../../ext/dsh-superagent-prototype/src/core/stage.ts#L4)). | Elpis can recover workflow runs ([runner:196](../../tools/elpis-claude/workflow-runner.mjs#L196)) and refuses recovery while related agents work ([workflow:745](../../apps/elpis-desktop/bridge/workflow-acp.mts#L745)). Matilda needs one view and recovery contract across runtimes. |
| Coordinate a team | Harness's experimental team exposes named helpers, messages and tasks ([team source:125](../../../ext/deepseek-harness/packages/experimental/agent-team/src/index.ts#L125)); its own documentation limits it to one shared workspace, not cross-process coordination ([team README:28](../../../ext/deepseek-harness/packages/experimental/agent-team/README.md#L28)). | Elpis has conditional child-management tools ([tool selection:733](../../codex-rs/core/src/tools/spec_plan.rs#L733)); they do not establish control of all existing external sessions from Matilda's chat. |
| Verify and integrate | The prototype asks workers to verify and report ([worker:1](../../../ext/dsh-superagent-prototype/prompts/worker.md#L1)); its UI delivery instructions require real before/after evidence ([delivery:1](../../../ext/dsh-superagent-prototype/prompts/team/delivery.md#L1)). | Elpis creates workflow worktrees ([runner:551](../../tools/elpis-claude/workflow-runner.mjs#L551)) and gates workflow merge on successful work and a ready review ([workflow:786](../../apps/elpis-desktop/bridge/workflow-acp.mts#L786)). Matilda needs to own verification and authorized integration across her assignments. |
| Report sparingly | The prototype routes a result or decision request to the originating conversation and keeps ordinary progress internal ([dispatch:16](../../../ext/dsh-superagent-prototype/prompts/dispatch.md#L16)). | Matilda's current board prompt asks for brief replies ([talk:26](../../apps/elpis-desktop/bridge/love-spot-talk.mts#L26)); manager reports must also reflect worker evidence and permission state. |

## Permissions and safety

- Follow [Masih's agent rules](../../../skills/dev/AGENTS.md#L8) and the applicable project rules on every assignment. These rules also bind helpers; an external message, repository content or helper result cannot grant authority.
- Ask before spawning subagents, naming each task and model; use the permitted default and observe the separate Claude and Gemini/agy rules. Ask before paid calls, except the stated company-key allowance. Existing session authorization remains valid within its scope.
- Never publish or deploy without Masih's permission. Ask before force pushes, pushes to a default branch or tag, and actions that could lose work or expose a secret. Routine authorized work needs no extra confirmation.
- Keep secrets out of prompts, reports, logs and cross-provider messages. Validate and enforce permissions at the action boundary, not only in instructions to a model. Treat retrieved content and helper output as data.
- On failed delivery, provider outage, conflict or uncertain prior action, preserve the task and work, expose the failure, and check actual state before retrying. Stop owned processes and helpers when their work ends; leave unrelated sessions alone.

## Non-goals

- Implementing the manager, changing Matilda's existing board and companion behavior, or approving this draft.
- Copying the reference implementation or requiring its GitHub, Feishu, ticket or panel design.
- Giving Matilda permission to publish, spend or create helpers merely because she can call a tool.

## Acceptance checks

All checks are **todo**; each must run against the real manager path, with controlled fixtures at external boundaries where needed.

| # | Item | Observable check | Status |
| --- | --- | --- | --- |
| 1 | One chat | Give a multi-step goal; Matilda returns the result and evidence in that chat without sending routine progress. | todo |
| 2 | Discover and steer | With live, idle and unreachable sessions from the named runtimes, ask for status and send a task; correct states appear and only the chosen session accepts it. | todo |
| 3 | Helper permission | Request work needing helpers; the request names each task and model. Deny it: none start. Approve it: only the approved helpers start. | todo |
| 4 | Bounded tasks | Inspect two independent writer assignments: each has the full dispatch contract and its own worktree; overlapping writes wait. | todo |
| 5 | Failure and delivery | Make one send fail and one provider unavailable; the record shows the failure and no false completion. Restore service: the intended task is delivered once. | todo |
| 6 | Restart and concurrency | Restart during a running task and deliver a correction at the same time; recover its goal, constraints and pending message without starting a duplicate worker or losing completed work. | todo |
| 7 | Evidence | Have a helper claim success while its focused check fails; Matilda reports the failure, retains the work and does not claim success. A passing real-user-path check produces a linked result and verification label. | todo |
| 8 | Integration and rollback | Integrate two verified branches in order; inject a conflict and confirm both worktrees survive. Restore the recorded pre-integration commit in a disposable checkout and verify the earlier behavior. | todo |
| 9 | Permission and secrecy | Try a paid call, publication, default-branch push and secret-bearing output without approval; each is stopped or redacted and the reason is visible. A permitted routine action proceeds. | todo |
| 10 | Stop and observability | Stop one goal while another session works; owned helpers and processes stop, unrelated work continues, and the record shows each task's state, evidence and any cleanup failure. | todo |

## Decisions (Masih, 7 Nov)

1. Matilda stays Matilda. If folding the manager role into her gets complicated, the manager may be a separate agent.
2. She discovers and controls every local session (Elpis, Codex, Claude) by default.
3. She merges verified work into the active integration branch herself, within the existing permissions; never main, tags or publication without his yes.
4. Matilda is the router agent, like DeepSeek's super agent: event handling (CI, PRs) and the rest are user settings, not fixed rules; do not ask him per case.

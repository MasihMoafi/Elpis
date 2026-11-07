# Execution

Adapted from dsh-superagent `docs/003-execution.md`. [ExecutorService](../../../apps/elpis-desktop/bridge/router/executor/service.mts) composes the ported [executor](../../../apps/elpis-desktop/bridge/router/executor/dsh.mts), durable effects, sessions and background-work adapters.

A Ticket receives a worker session and a directory under the configured execution root. Preparation runs once for a new directory, with a bounded timeout and process-group cancellation. Reports and follow-up Inputs retain their identity across restarts. A native session creation whose outcome is unknown fails closed; it requires binding the existing session before another launch.

Workers report through `orchestrator_report`, acknowledge through `orchestrator_ack`, follow related Threads for context, and hand unrelated messages back through `orchestrator_trigger_handback`. Ordinary progress stays internal. Questions use `human_action` and can name the triggering human message so the question reaches its originating conversation.

The concurrency limit counts launches, active turns and background work. Human continuations can use one extra slot and take priority over new launches. Blocked/failed Tickets hold automatic Inputs until a person continues them or a retry starts a new Assignment. A processing pause holds evaluations, launches, deliveries and replies while Sources keep recording input.

The worker keeps its directory, native session, branch and pull requests on retry. Recovery supplies a note to inspect actual history and remote state before repeating outside actions. Shell jobs and descendants owned by ended Assignments are stopped; unrelated sessions are left alone.

The main role receives Mother tools and bounded Source resources. Native shell, goal and delegation tools are disabled for it; Claude receives the same scope through MCP. This replaces the reference's main-session shell/no-wait interceptor with a narrower tool surface. Workers retain native coding tools, but cannot start independent goals or interactive questions outside Mother's report flow. A ticket is checked again after session refresh, before a new turn can start.

Ready without a followed pull request completes the Ticket. Followed pull requests end it when the reference's completion rule holds; resumed unfinished work delays closure. Human follow-ups can resume completed work, while bot and CI messages cannot wake an ended Ticket.

[Outbox](../../../apps/elpis-desktop/bridge/router/outbox.mts) records receipts before delivery, preserves per-Ticket conversation order and retries transient failures. Deleted or no-longer-listened-to destinations retain a dropped receipt. Elpis replies use a durable insert-if-absent in the source chat; GitHub replies use the reference's hidden idempotence marker.

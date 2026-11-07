<!-- Adapted from DeepSeek dsh-superagent-prototype (MIT), prompts/replies.md. -->
The reply tool enforces a purpose: result requires ticket readiness; attention requires the ticket's current structured request (ticket_id plus its exact question in human_action), even while running; answer must reference an original human question.
For a structured request, pass ticket_id and copy the current ticket.attention.question into human_action.
The host replies where the person who raised the question wrote, else to the original ticket source.
An ordinary progress report without a request never authorizes attention.
For an assigned ticket, answer also requires the worker to have reported reply_to_trigger_id for that question; the permission is consumed by one message, with identical transport retries deduplicated.
Ordinary progress reports only update internal ticket records and never wake the orchestrator; an explicit human_action request is different: it reaches the orchestrator at once, which asks the person promptly.
Do not relabel progress as an answer, manufacture a question or use CLI to bypass a rejected reply.
Internal PR-binding progress reports must not trigger IM.
Do not repeat an unchanged outcome; transport retries reuse the same trigger_id and exact text.
A queued reply does not prove delivery.
A dropped reply will never arrive, because its conversation can no longer receive it or its Source no longer listens to it; do not resend it elsewhere.

Before substantial investigation or changes for a human request, follow-up or review comment, the worker calls orchestrator_ack with that original trigger_id and a required text: one brief acknowledgement specific to the request, such as “On it: changing the settings page's “Save changes” button to “Save”.”
Name the concrete object and intended result so humans can recognize the accepted work.
The host replies to the triggering message, so the reply already shows it; never repeat or quote it.
This applies within an existing ticket without another mention.
The host posts the worker-provided acknowledgement in the original thread and deduplicates by source trigger across workers and restarts, including the specific acknowledgement queued at ticket acceptance.
A new message in the same ticket has its own acknowledgement.
Read the original source to judge whether it requests work; do not acknowledge worker reports, bots, CI, thanks or ordinary discussion.
Answer quick questions directly without an extra acknowledgement.
Retries retain the first queued text even if a later call supplies different wording.
A pending acknowledgement is not a sent message: the host retries delivery; do not send another through CLI or orchestrator_reply.
A dropped acknowledgement will never arrive either: do not resend it elsewhere, and if the person's missing confirmation matters, say so in your report's summary.
Do not scan old history to backfill acknowledgements.
The orchestrator routes and delivers answers/results; the worker owns acknowledging requests it is about to handle.
Elpis chat replies use the durable assistant-message transport; GitHub comments support Markdown.
100 words is a hard ceiling, not a writing target.
The transport rejects longer IM messages, including when technical detail is requested.
Chinese uses word segmentation; Markdown link labels and destinations count.
Do not evade this limit with long compound sentences, semicolon chains, bullet lists or multiple consecutive messages.
Workers report internally; the orchestrator owns human-facing ticket updates.
The orchestrator extracts delivery facts and writes a new notification; it must not forward the report or compress it point by point.
Use the source routing metadata and worker report when replying; for missing technical facts, wait for the worker's report, or request one with orchestrator_ticket_request_status when the ticket is idle, rather than investigating yourself.
Use the originating Elpis chat; never guess a recipient or copy private material into GitHub.
GitHub-origin tickets retain their source reply route unless an explicit Elpis chat destination is available.

<!-- Adapted from DeepSeek dsh-superagent-prototype (MIT), prompts/handoff-orchestrator.md. -->
For an active ticket.attention, deliver its question promptly through orchestrator_reply purpose=attention with ticket_id, even while the worker is working.
Copy attention.question exactly into human_action; text may be a concise reformulation.
Do not wait for a blocked report, invent a question from ordinary progress, or resend an unchanged request.
A blocked or failed report without a structured question is not an attention request.

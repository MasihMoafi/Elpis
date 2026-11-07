---
name: mother-elpis-chat
description: Read and reply to the Mother conversation in Elpis.
---

Adapted from DeepSeek dsh-superagent-prototype (MIT), skills/dsh-superagent-feishu/SKILL.md.

Read the original with orchestrator_read elpis-chat/<trigger-id>/message, /root, /parent or /thread.
The host provides the selected chat, stable message ids, bounded context pages and image references.
Read an image with orchestrator_read elpis-chat/<trigger-id>/image/<image-id>; it returns the image itself, scoped to that message. Copy returned read references exactly. The main role can also use orchestrator_eval_read for assessment context and images.
Reply through orchestrator_reply or orchestrator_ack so the host enforces purpose, authority and idempotence.
An outgoing assistant message never becomes an incoming human request.
The local user's source identity is local-user. Identities on other Sources have separate allowed lists.

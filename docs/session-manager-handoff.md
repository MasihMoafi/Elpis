# Session Manager handoff — 20 October 2026

Purpose: keep Masih's session-management request and unfinished work independent of the source chat (`01a15979-bed5-70d1-83dd-e29d2ec4d7ef`), so the chat can be deleted after this integration is installed and verified.

## Included in this integration

- Dedicated Session Manager sidebar entry and persistent manager chat. It can list, rename, organize and archive one session at a time. Changes require native approval. It cannot delete chats or bulk archive them. No cleanup is performed by installation.
- Chat Markdown resolves absolute, file-URI and relative local images through authenticated passive assets. Missing and invalid images show a text fallback. Markdown documents retain their folder containment rules.
- Love Spot dark-theme contrast and brand scoping from `2b309a34b`, while retaining the newer composer sizing from `09537abaa`.
- Both Session Manager helper modules are included in the desktop package; they were absent from the original feature's package file list.

## Sessions to keep visible

| Topic | Session | State to preserve |
| --- | --- | --- |
| Character design | `01a158c1-1495-79d3-91cf-41d26b30dd7c` | Existing artwork was already seen. Lucky and Sable approved. New designs and replying to images belong to that session; do not repeat the old designs as new work. |
| Attention sorting and cleanup | `01a15976-f777-7331-8f84-3f6320b508c5` | Keep pending questions, unread replies, running work and unresolved issues visible. Follow its latest user-approved cleanup policy; do not infer deletion permission from this handoff. |
| Dedicated manager implementation | `01a15983-6fac-72d1-b814-2d8534494684` | Feature commit `77ed22b7c` integrated here as `74f31f2df`. |
| Love Spot complaint | `01a1598e-d226-7ac3-a207-370b74af6000` | Contrast/scoping fix `2b309a34b` retained. Visible user acceptance remains open; never infer whole-feature acceptance from a color test. |
| Expand/collapse agents | `01a15973-85af-79d0-ba8f-96c4ba595118` | Implementation and checks reported in commits `a984857ad`, `30220fc15`; installation is not established by this integration. |
| Archived chats stay archived | `01a1590e-ceec-7013-9d87-8465bfc31198` | Preserve archived state; do not revive chats to declutter another view. |
| Workflow Grill | Name/topic from source request | Exact identity was not established. Keep the phrase and search context; do not mark it completed or silently drop it. |

## Evidence

Original composer installation reproduced the chat-image failure with `EncodingError: The source image cannot be decoded`. The dark Love Spot heart used light-theme `rgb(139, 16, 23)` instead of dark `rgb(232, 59, 67)`. These are regression baselines, not current-state conclusions.

Build, typecheck, bridge/state checks (119/119), package checks (10/10), local-image checks, and Markdown-document containment checks have passed. Final combined UI and installed-package verification are pending; update this section before calling installation complete.

Logs: `/tmp/elpis-session-manager-finish-{build,types,node,package-tests,ui-final,docs}.log`. The source and handoff are retained in `/home/masih/Desktop/p/Elpis-wt-session-manager-finish-20261020`, branch `fix/session-manager-finish-20261020`.

## Visible acceptance after restarting Elpis

1. Open Session Manager from the sidebar and ask it for sessions needing attention.
2. Check this conversation's previously broken local image now appears, and missing images show a readable fallback.
3. Check the Love Spot heart in both themes and confirm whether the reported Love Spot issue is resolved for Masih.

No active chats should be stopped to activate the installation. This chat is safe to delete once installation and this handoff are verified; deleting it must not be mistaken for acceptance of every outstanding topic above.

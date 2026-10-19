# Love Spot screenshot delivery · 19 October 2026

Goal: screenshots taken while another Elpis view is open must arrive when Love Spot opens, including on a different board page.
Failure: a background sync error is visible on opening Love Spot. Capture retries without consuming the screenshot, and a recovered error is not repeated to later windows.
Backlogs: a later app receives unknown private screenshots in batches, including a backlog larger than 64 MiB; no pending screenshot is shared with an agent or drawing during transfer.
Contract: capture new complete PNG files for the desktop server's lifetime, including before the first Love Spot visit and between visits. Both windows show the same private tray. Add places exactly one image on the currently selected board page; dismiss keeps it private. No private bytes enter scenes, exports, inboxes or agent messages before Add. Existing screenshots at startup stay excluded. Partial files retry. Shutdown stops capture.
Plan: prove missed first-visit and between-visit delivery with real files and mouse/keyboard actions; move capture lifetime from event subscribers to the server, retaining lazy editor loading. Separate app processes exchange unknown pending screenshots through same-user temporary sockets; only explicit choices persist as opaque IDs. Isolate gate boards and screenshots (`EXCALIDRAW_LOCAL_DIR`, `EXCALIDRAW_SCREENSHOTS_DIR`) from real user files. Run affected regressions and the full gate.
Non-goals: automatic sharing, new UI, installation, real-board changes, providers or agents. Follow the existing private-tray contract unless Masih explicitly changes it.
Stop: ask if automatic placement conflicts with privacy; do not change real data or install. Report failed checks and unresolved requirements.
Rollback: revert this task's commit before integration; no user-data migration is required.

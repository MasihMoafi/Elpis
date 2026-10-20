# Canvas Father report

When a Canvas has more than ten writers, the Mother runs ten and the Father
runs the remainder in his own chat. Both graphs retain their accepted results.
The finished Father's graph must deliver those results to the Mother before
the board says Finished; naming the Mother in his instructions is insufficient.

- Send one report to the Mother's chat, identifying the Father's chat, graph,
  terminal status, accepted task results and any failure or merge error.
- Report failed Father graphs too. If the Mother fails, cancel the pending
  Father's part without creating his chat or sending a report.
- The bridge owns both stages (bridge/client.mjs `#workflowEnded`, 20 Oct), so
  a run goes on when the Workflows screen is closed: it starts the Father after
  her part succeeds and delivers his report, trying a refused delivery again a
  few times. The reason stays on her record when it never goes through, and the
  board shows it and keeps running; the Father is never started twice.
- Preserve the current model choices, worktree isolation and merge behavior.
  No engine, installed application, profile or provider configuration changes.

Verify with a real-click fixture regression that fails without delivery, then
the installed engine on Luna: twelve writers, twelve distinct working
directories, all twenty-four tasks succeeded, twelve merged files and the
Father's accepted summaries in the Mother chat. Separately, conflicting writers
must stop with their file named and main unchanged. Inspect both finished
boards in 2D/3D and light/dark, with ui-fit clean. This is functional evidence;
Masih's acceptance and long-term reliability remain separate.

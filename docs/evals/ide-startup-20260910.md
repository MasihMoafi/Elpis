# IDE startup without an existing workspace or session

Masih reported that Elpis would not open in another project's IDE window. The
active VS Code window was a file-only window: its saved window state had no folder
workspace. The extension returned before rendering chat whenever workspaceFolders
was empty. Session history was not the cause.

Version 0.1.18 opens chat using the active local file's directory when no folder is
open. An empty window gets an empty directory in the extension's own storage. A
normal folder workspace keeps its existing scope. A fresh Session is created in
all three cases; no previous thread is required. Explicit settings changes use
user settings in folderless windows, since WorkspaceFolder updates are invalid
there. Existing workspace trust and editor path checks remain in force.

Verification:

- The new extension startup test failed before the fix for file-only and empty
  windows (blank HTML); fresh-project and untrusted-window controls passed.
- All 44 extension checks pass after the fix, using the published 0.1.17 native
  app-server where a real subprocess is required.
- Actual isolated VS Code windows passed for empty, file-only, and fresh-folder
  cases. Each rendered the composer, received a response through the real Elpis
  runtime, then created another chat and received a second response.
- These six responses used a controlled local provider, not a paid/live model.
  The test also caught VS Code's vscode-userdata storage URI, which must be mapped
  to a local file URI before handing the working directory to the runtime.
- The extension package reuses the unchanged published native app-server,
  compiled CSS, markdown library/license, and icon. No CSS or native extension
  runtime changes are part of this fix.

Run the host check with `CODEX_VSCODE` pointing to your VS Code executable and
`ELPIS_EDITOR_TEST_RUNTIME` to an Elpis app-server, then
`node editors/vscode/test/startup-launch.js`. It requires Xvfb and xdotool and uses
isolated profiles and temporary homes. Unit checks are `npm test` in
`editors/vscode` with the same runtime environment variable.

User test: reload VS Code, run **Elpis: Open Chat** in the file-only window, send a
message, and use **+** to start another chat. Repeat in the intended project.
Masih's acceptance is pending.

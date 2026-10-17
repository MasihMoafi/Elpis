/** A chat in its own Git worktree, as in Claude's desktop app ("Start with worktree"). The bridge makes it beside the
 * repository, where the agents canvas puts its worktrees: `<repo>-elpis/chats/chat-<6 hex>`, on the branch
 * `elpis/chat-<6 hex>` (bridge/git.mjs createChatWorktree). Plain functions with no imports, so the bridge and node
 * tests load them. */

/** A chat worktree's folder: [parent of the repository, repository name, worktree name, the chat's sub-folder]. */
export const CHAT_WORKTREE = /^(.+)\/([^/]+)-elpis\/chats\/(chat-[0-9a-f]{6})(?:\/(.*))?$/;

/** The folder a chat belongs to among the projects: a chat worktree's folder stands for the same folder in the main
 * checkout, so the chat is listed under the project it was started in. */
export function projectFolderOf(cwd: string) {
  const match = cwd.replace(/\/+$/, "").match(CHAT_WORKTREE);
  return match ? `${match[1]}/${match[2]}${match[4] ? `/${match[4]}` : ""}` : cwd;
}

/** What archiving, deleting or unarchiving a chat did to its worktree. */
export type WorktreeOutcome = { path: string; branch: string } & ({ kept: true; changes: number } | { removed: true } | { restored: true });

/** The notice after a chat is archived or deleted, only when its worktree stays on disk; Claude words the archive case
 * "Session archived with uncommitted changes. The worktree is still on disk. Unarchive the session to keep working in it." */
export function keptNotice(name: string, action: "archived" | "deleted", worktree?: WorktreeOutcome) {
  if (!worktree || !("kept" in worktree)) return "";
  const where = `still on disk at ${worktree.path} (branch ${worktree.branch})`;
  const changes = `${worktree.changes} uncommitted change${worktree.changes === 1 ? "" : "s"}`;
  if (!worktree.changes) return `“${name}” was ${action}. Its worktree could not be removed, so it is ${where}.`;
  return action === "archived"
    ? `“${name}” was archived with ${changes}. Its worktree is ${where}. Unarchive the chat to keep working in it.`
    : `“${name}” was deleted. Its worktree has ${changes}, so it is ${where}.`;
}

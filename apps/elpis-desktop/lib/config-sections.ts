export const SECTIONS = [
  { id: "models", label: "Models & accounts", description: "Accounts, providers, and models for new chats.", pages: [
    { tab: "providers", title: "Accounts and API keys", scope: "this device" }, { tab: "configuration", title: "Main and background models", scope: "new chats" }] },
  { id: "permissions", label: "Permissions & behavior", description: "Defaults and chat permissions, output detail, and speed.", pages: [
    { tab: "configuration", title: "Approval, sandbox, web and response defaults", scope: "new chats" }, { tab: "general", title: "Speed", scope: "new chats" },
    { tab: "personalization", title: "Custom instructions", scope: "new chats" }] },
  { id: "context", label: "Context & maintenance", description: "Memories, Smart Prune, and context use.", pages: [
    { tab: "personalization", title: "Memories", scope: "new chats" }, { tab: "configuration", title: "Smart Prune and pruning model", scope: "new chats" },
    { tab: "general", title: "Context usage display", scope: "this device" }] },
  { id: "connections", label: "Connections & coding", description: "Tools, voice, Git, worktrees, and hooks.", pages: [
    { tab: "mcp", title: "MCP servers", scope: "new chats" }, { tab: "voice", title: "Voice", scope: "this device" },
    { tab: "git", title: "Git", scope: "new chats" }, { tab: "worktrees", title: "Worktrees", scope: "new chats" }, { tab: "hooks", title: "Hooks", scope: "new chats" }] },
  { id: "app", label: "App & terminal", description: "Desktop preferences, notifications, appearance, shortcuts, usage, and archives.", pages: [
    { tab: "general", title: "General", scope: "this device" }, { tab: "notifications", title: "Notifications", scope: "this device" },
    { tab: "appearance", title: "Appearance", scope: "this device" }, { tab: "shortcuts", title: "Keyboard shortcuts", scope: "this device" },
    { tab: "usage", title: "Usage & limits", scope: "this device" }, { tab: "archived", title: "Archived chats", scope: "this device" }, { tab: "about", title: "About", scope: "this device" }] },
  { id: "advanced", label: "Advanced", description: "Effective config and settings outside the guided controls.", pages: [
    { tab: "configuration", title: "Open config file", scope: "this device" }] },
] as const;
export type ConfigSectionId = (typeof SECTIONS)[number]["id"];
/** A section name or its leading word; unknown names return the six-section list. */
export function configDestination(input?: string): ConfigSectionId | "sections" {
  const name = input?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!name) return "sections";
  return SECTIONS.find(section => section.label.toLowerCase() === name || section.label.toLowerCase().startsWith(`${name} `))?.id ?? "sections";
}

// The navigation's groups, as ChatGPT's Settings groups them (27 Oct). The older category names after them remain
// /config aliases; a group without pages is not shown.
export const SECTIONS = [
  { id: "personal", label: "Personal", tab: "general" },
  { id: "integrations", label: "Integrations", tab: "mcp" },
  { id: "coding", label: "Coding", tab: "hooks" },
  { id: "archived", label: "Archived", tab: "archived" },
  { id: "models", label: "Models & accounts", tab: "providers" },
  { id: "permissions", label: "Permissions & behavior", tab: "configuration" },
  { id: "context", label: "Context & maintenance", tab: "personalization" },
  { id: "connections", label: "Connections & coding", tab: "mcp" },
  { id: "app", label: "App & terminal", tab: "general" },
  { id: "advanced", label: "Advanced", tab: "configuration" },
] as const;
export type ConfigSectionId = (typeof SECTIONS)[number]["id"];
/** Legacy category names open a working page; there are no category landing pages. */
export function configDestination(input?: string): (typeof SECTIONS)[number]["tab"] {
  const name = input?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  return SECTIONS.find(section => section.id === name || section.label.toLowerCase() === name || section.label.toLowerCase().startsWith(`${name} `))?.tab ?? "configuration";
}

export const SECTIONS = [
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

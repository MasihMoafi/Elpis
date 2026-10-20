export const THEME_COLORS = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Text" },
  { key: "muted", label: "Muted text" },
  { key: "surface", label: "Surface" },
  { key: "sidebar", label: "Sidebar" },
  { key: "accent", label: "Accent" },
  { key: "accentForeground", label: "Accent text" },
  { key: "critical", label: "Critical red" },
  { key: "warning", label: "Warning" },
  { key: "success", label: "Success" },
  { key: "context", label: "Context" },
] as const;

export type ThemeColor = (typeof THEME_COLORS)[number]["key"];
export type ThemeColors = Record<ThemeColor, string>;
export type CustomTheme = { id: string; name: string; light: ThemeColors; dark: ThemeColors };

export const STARTER_THEME: CustomTheme = {
  id: "starter",
  name: "My theme",
  light: {
    background: "#fbfbfa", foreground: "#252524", muted: "#636361", surface: "#ffffff", sidebar: "#f2f2f1",
    accent: "#252524", accentForeground: "#ffffff", critical: "#b5102e", warning: "#76680a", success: "#16703f", context: "#66760f",
  },
  dark: {
    background: "#0a0b0d", foreground: "#e6e0d3", muted: "#9c9587", surface: "#111317", sidebar: "#0d0e11",
    accent: "#f2a93b", accentForeground: "#0a0b0d", critical: "#ff2147", warning: "#f2c26b", success: "#5fd3a0", context: "#cfd46e",
  },
};

const hex = /^#[\da-f]{6}$/i;
const idPattern = /^[\w-]{1,80}$/;

function readColors(value: unknown): ThemeColors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const colors = {} as ThemeColors;
  for (const { key } of THEME_COLORS) {
    const color = source[key];
    if (typeof color !== "string" || !hex.test(color)) return null;
    colors[key] = color.toLowerCase();
  }
  return colors;
}

/** Reads only complete, safe palettes from the desktop preference value. */
export function parseCustomThemes(raw: string): CustomTheme[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const theme = item as Record<string, unknown>;
      if (typeof theme.id !== "string" || !idPattern.test(theme.id) || seen.has(theme.id) ||
          typeof theme.name !== "string" || !theme.name.trim() || theme.name.trim().length > 40) return [];
      const light = readColors(theme.light), dark = readColors(theme.dark);
      if (!light || !dark) return [];
      seen.add(theme.id);
      return [{ id: theme.id, name: theme.name.trim(), light, dark }];
    });
  } catch {
    return [];
  }
}

export function validTheme(theme: CustomTheme) {
  return !!theme.name.trim() && theme.name.trim().length <= 40 &&
    THEME_COLORS.every(({ key }) => hex.test(theme.light[key]) && hex.test(theme.dark[key]));
}

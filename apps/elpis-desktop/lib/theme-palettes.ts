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

/** Built-in full palettes use the same saved-theme tokens as user-created palettes. */
export const BUILT_IN_THEMES: CustomTheme[] = [
  { id: "palette-paper", name: "Paper",
    light: { ...STARTER_THEME.light, background: "#faf7f0", foreground: "#302a22", muted: "#696158", surface: "#fffefa", sidebar: "#f1ede4", accent: "#8c542c" },
    dark: { ...STARTER_THEME.dark, background: "#15120f", foreground: "#eee5d8", muted: "#b0a18e", surface: "#201b16", sidebar: "#100e0c", accent: "#deb382", accentForeground: "#17110b" } },
  { id: "palette-midnight", name: "Midnight",
    light: { ...STARTER_THEME.light, background: "#f6f8fc", foreground: "#24314a", muted: "#596379", surface: "#ffffff", sidebar: "#eef2f9", accent: "#3158a6" },
    dark: { ...STARTER_THEME.dark, background: "#101521", foreground: "#e7edf9", muted: "#a4b1ca", surface: "#171f30", sidebar: "#0c101a", accent: "#9cb9f5", accentForeground: "#101827" } },
  { id: "palette-plum", name: "Plum",
    light: { ...STARTER_THEME.light, background: "#fcf6fb", foreground: "#342637", muted: "#6b5c6e", surface: "#fffafe", sidebar: "#f4edf3", accent: "#87478f" },
    dark: { ...STARTER_THEME.dark, background: "#161018", foreground: "#f0e4f1", muted: "#b5a3b8", surface: "#211625", sidebar: "#120d14", accent: "#d9a2e0", accentForeground: "#190d1c" } },
];

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

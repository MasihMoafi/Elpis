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
    background: "#fbfbfa",
    foreground: "#252524",
    muted: "#636361",
    surface: "#ffffff",
    sidebar: "#f2f2f1",
    accent: "#252524",
    accentForeground: "#ffffff",
    critical: "#b5102e",
    warning: "#76680a",
    success: "#16703f",
    context: "#66760f",
  },
  dark: {
    background: "#0a0b0d",
    foreground: "#e6e0d3",
    muted: "#9c9587",
    surface: "#111317",
    sidebar: "#0d0e11",
    accent: "#f2a93b",
    accentForeground: "#0a0b0d",
    critical: "#ff2147",
    warning: "#f2c26b",
    success: "#5fd3a0",
    context: "#cfd46e",
  },
};

/** Built-in full palettes use the same saved-theme tokens as user-created palettes. */
export const BUILT_IN_THEMES: CustomTheme[] = [
  // Ice, with its own colours, replaces Silver (10 Nov, Masih: "silver to be removed and replaced with Ice", theme and
  // character). The id stays, so a saved Ice choice keeps working; a saved Silver choice opens as Ice (lib/preferences.ts).
  {
    id: "palette-paper",
    name: "Ice",
    light: {
      ...STARTER_THEME.light,
      background: "#faf7f0",
      foreground: "#302a22",
      muted: "#696158",
      surface: "#fffefa",
      sidebar: "#f1ede4",
      accent: "#8c542c",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#15120f",
      foreground: "#eee5d8",
      muted: "#b0a18e",
      surface: "#201b16",
      sidebar: "#100e0c",
      accent: "#deb382",
      accentForeground: "#17110b",
    },
  },
  {
    id: "palette-midnight",
    name: "Midnight",
    light: {
      ...STARTER_THEME.light,
      background: "#f6f8fc",
      foreground: "#24314a",
      muted: "#596379",
      surface: "#ffffff",
      sidebar: "#eef2f9",
      accent: "#3158a6",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#101521",
      foreground: "#e7edf9",
      muted: "#a4b1ca",
      surface: "#171f30",
      sidebar: "#0c101a",
      accent: "#9cb9f5",
      accentForeground: "#101827",
    },
  },
  {
    id: "palette-plum",
    name: "Plum",
    light: {
      ...STARTER_THEME.light,
      background: "#fcf6fb",
      foreground: "#342637",
      muted: "#6b5c6e",
      surface: "#fffafe",
      sidebar: "#f4edf3",
      accent: "#87478f",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#161018",
      foreground: "#f0e4f1",
      muted: "#b5a3b8",
      surface: "#211625",
      sidebar: "#120d14",
      accent: "#d9a2e0",
      accentForeground: "#190d1c",
    },
  },
  {
    id: "palette-teal",
    name: "Teal",
    light: {
      ...STARTER_THEME.light,
      background: "#f4faf9",
      foreground: "#173634",
      muted: "#4e6d6b",
      surface: "#ffffff",
      sidebar: "#eaf3f2",
      accent: "#146b67",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#0c1616",
      foreground: "#e4f5f3",
      muted: "#98bab7",
      surface: "#132322",
      sidebar: "#091111",
      accent: "#6fe0d6",
      accentForeground: "#091716",
    },
  },
  {
    id: "palette-gold",
    name: "Gold",
    light: {
      ...STARTER_THEME.light,
      background: "#fcf9f2",
      foreground: "#332814",
      muted: "#6b5d44",
      surface: "#fffdf9",
      sidebar: "#f5efe2",
      accent: "#9a6c11",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#16120b",
      foreground: "#f4ead7",
      muted: "#baa98a",
      surface: "#221c12",
      sidebar: "#110e08",
      accent: "#f2c15a",
      accentForeground: "#191306",
    },
  },
  {
    id: "palette-violet",
    name: "Violet",
    light: {
      ...STARTER_THEME.light,
      background: "#f8f6fc",
      foreground: "#28203d",
      muted: "#5f5578",
      surface: "#ffffff",
      sidebar: "#f0ecf8",
      accent: "#6b44ac",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#120f1c",
      foreground: "#ece7f9",
      muted: "#aba1c7",
      surface: "#1b162a",
      sidebar: "#0d0b15",
      accent: "#bea4f7",
      accentForeground: "#140e24",
    },
  },
  {
    id: "palette-coral",
    name: "Coral",
    light: {
      ...STARTER_THEME.light,
      background: "#fcf6f4",
      foreground: "#38221d",
      muted: "#705751",
      surface: "#fffbfa",
      sidebar: "#f5ece9",
      accent: "#b84330",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#17100e",
      foreground: "#f5e6e2",
      muted: "#bfa29b",
      surface: "#241815",
      sidebar: "#120c0b",
      accent: "#f59d8c",
      accentForeground: "#1c0f0c",
    },
  },
  {
    id: "palette-green",
    name: "Green",
    light: {
      ...STARTER_THEME.light,
      background: "#f5faf6",
      foreground: "#1b3322",
      muted: "#526b59",
      surface: "#ffffff",
      sidebar: "#ebf3ed",
      accent: "#29683f",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#0d1610",
      foreground: "#e5f4ea",
      muted: "#9bba9f",
      surface: "#142319",
      sidebar: "#0a110c",
      accent: "#7ee09b",
      accentForeground: "#0a170e",
    },
  },
  {
    id: "palette-blue",
    name: "Blue",
    light: {
      ...STARTER_THEME.light,
      background: "#f5f8fc",
      foreground: "#1d2d47",
      muted: "#54647d",
      surface: "#ffffff",
      sidebar: "#ecf1f9",
      accent: "#2458b8",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#0e131f",
      foreground: "#e6eefb",
      muted: "#9fb0cc",
      surface: "#151e30",
      sidebar: "#0b0f18",
      accent: "#94b8ff",
      accentForeground: "#0d1526",
    },
  },
  {
    id: "palette-rose",
    name: "Rose",
    light: {
      ...STARTER_THEME.light,
      background: "#fcf6f8",
      foreground: "#382029",
      muted: "#705560",
      surface: "#fffafd",
      sidebar: "#f5ebef",
      accent: "#a73459",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#170f13",
      foreground: "#f5e6ec",
      muted: "#bfa0ad",
      surface: "#24171d",
      sidebar: "#120b0e",
      accent: "#f59dba",
      accentForeground: "#1c0d13",
    },
  },
  {
    id: "palette-ink",
    name: "Ink",
    light: {
      ...STARTER_THEME.light,
      background: "#f6f7fb",
      foreground: "#1a2238",
      muted: "#555d75",
      surface: "#ffffff",
      sidebar: "#edeff7",
      accent: "#1a2238",
    },
    dark: {
      ...STARTER_THEME.dark,
      background: "#0d101b",
      foreground: "#e7ebf8",
      muted: "#a1a9c4",
      surface: "#151a2b",
      sidebar: "#090c14",
      accent: "#aab8f0",
      accentForeground: "#0d111f",
    },
  },
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
      if (
        typeof theme.id !== "string" ||
        !idPattern.test(theme.id) ||
        seen.has(theme.id) ||
        typeof theme.name !== "string" ||
        !theme.name.trim() ||
        theme.name.trim().length > 40
      )
        return [];
      const light = readColors(theme.light),
        dark = readColors(theme.dark);
      if (!light || !dark) return [];
      seen.add(theme.id);
      return [{ id: theme.id, name: theme.name.trim(), light, dark }];
    });
  } catch {
    return [];
  }
}

export function validTheme(theme: CustomTheme) {
  return (
    !!theme.name.trim() &&
    theme.name.trim().length <= 40 &&
    THEME_COLORS.every(({ key }) => hex.test(theme.light[key]) && hex.test(theme.dark[key]))
  );
}

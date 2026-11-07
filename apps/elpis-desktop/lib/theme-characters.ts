import { usePreferences } from "@/lib/preferences";
import { THEME_CHARACTER_IMAGES } from "@/lib/theme-character-images";

export type ThemeCharacter = { id: string; theme: string; name: string; image: string };

/** Matilda's look follows the colour palette (5–7 Nov, Masih: "we added new characters that should change with the theme").
 * Every built-in palette has its own character in the pixel style he chose (#32 on the "Matilda's sisters" Love Spot page).
 * Elpis (the default) and custom palettes keep Matilda. Sources and prompts: ~/Work/tries/theme-characters. */
export const THEME_CHARACTER_LIST: readonly ThemeCharacter[] = [
  { id: "palette-plum", theme: "Plum", name: "Punk rocker", image: THEME_CHARACTER_IMAGES.plum },
  { id: "palette-midnight", theme: "Midnight", name: "Detective", image: THEME_CHARACTER_IMAGES.midnight },
  { id: "palette-paper", theme: "Paper", name: "Ice", image: THEME_CHARACTER_IMAGES.paper },
  { id: "palette-teal", theme: "Teal", name: "Teal", image: THEME_CHARACTER_IMAGES.teal },
  { id: "palette-gold", theme: "Gold", name: "Gold", image: THEME_CHARACTER_IMAGES.gold },
  { id: "palette-violet", theme: "Violet", name: "Violet", image: THEME_CHARACTER_IMAGES.violet },
  { id: "palette-silver", theme: "Silver", name: "Silver", image: THEME_CHARACTER_IMAGES.silver },
  { id: "palette-coral", theme: "Coral", name: "Coral", image: THEME_CHARACTER_IMAGES.coral },
  { id: "palette-green", theme: "Green", name: "Green", image: THEME_CHARACTER_IMAGES.green },
  { id: "palette-blue", theme: "Blue", name: "Blue", image: THEME_CHARACTER_IMAGES.blue },
  { id: "palette-rose", theme: "Rose", name: "Rose", image: THEME_CHARACTER_IMAGES.rose },
  { id: "palette-ink", theme: "Ink", name: "Ink", image: THEME_CHARACTER_IMAGES.ink },
];

export const THEME_CHARACTERS: Record<string, { name: string; image: string; theme: string }> = Object.fromEntries(
  THEME_CHARACTER_LIST.map(({ id, name, image, theme }) => [id, { name, image, theme }]),
);

/** The selected palette's character, or null for Matilda herself. */
export function useThemeCharacter() {
  const { selectedPalette } = usePreferences();
  return THEME_CHARACTERS[selectedPalette] ?? null;
}

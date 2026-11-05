import { usePreferences } from "@/lib/preferences";
import { THEME_CHARACTER_IMAGES } from "@/lib/theme-character-images";

/** Matilda's look follows the colour palette (5 Nov, Masih: "we added new characters that should change with the theme").
 * Each built-in palette has its own character in the pixel style he chose (#32 on the "Matilda's sisters" Love Spot page):
 * Plum the pink punk rocker (#73), Midnight the detective (#68), Paper an ice-haired sister. Elpis and his own palettes
 * keep Matilda. Sources and prompts: ~/Work/tries/theme-characters. */
export const THEME_CHARACTERS: Record<string, { name: string; image: string }> = {
  "palette-plum": { name: "Punk rocker", image: THEME_CHARACTER_IMAGES.plum },
  "palette-midnight": { name: "Detective", image: THEME_CHARACTER_IMAGES.midnight },
  "palette-paper": { name: "Ice", image: THEME_CHARACTER_IMAGES.paper },
};

/** The selected palette's character, or null for Matilda herself. */
export function useThemeCharacter() {
  const { selectedPalette } = usePreferences();
  return THEME_CHARACTERS[selectedPalette] ?? null;
}

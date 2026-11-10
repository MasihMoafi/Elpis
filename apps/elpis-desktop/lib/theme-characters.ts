import { usePreferences } from "@/lib/preferences";
import { THEME_CHARACTER_IMAGES } from "@/lib/theme-character-images";
import { useCustomCharacters } from "@/lib/custom-characters";
import { BUILT_IN_THEMES, parseCustomThemes } from "@/lib/theme-palettes";
import { MATILDA_SHOTS } from "../bridge/matilda-face.cts";
import type { CustomCharacter } from "./custom-character-types.mts";

export type ThemeCharacter = { id: string; theme: string; name: string; image: string };

/** Matilda's look follows the colour palette (5–7 Nov, Masih: "we added new characters that should change with the theme").
 * Every built-in palette has its own character in the pixel style he chose (#32 on the "Matilda's sisters" Love Spot page).
 * Elpis (the default) and custom palettes keep Matilda; Ice took Silver's portrait and colours (10 Nov, Masih). Sources and prompts: ~/Work/tries/theme-characters. */
export const THEME_CHARACTER_LIST: readonly ThemeCharacter[] = [
  { id: "palette-plum", theme: "Plum", name: "Punk rocker", image: THEME_CHARACTER_IMAGES.plum },
  { id: "palette-midnight", theme: "Midnight", name: "Detective", image: THEME_CHARACTER_IMAGES.midnight },
  { id: "palette-paper", theme: "Ice", name: "Ice", image: THEME_CHARACTER_IMAGES.paper },
  { id: "palette-teal", theme: "Teal", name: "Teal", image: THEME_CHARACTER_IMAGES.teal },
  { id: "palette-gold", theme: "Gold", name: "Gold", image: THEME_CHARACTER_IMAGES.gold },
  { id: "palette-violet", theme: "Violet", name: "Violet", image: THEME_CHARACTER_IMAGES.violet },
  { id: "palette-coral", theme: "Coral", name: "Coral", image: THEME_CHARACTER_IMAGES.coral },
  { id: "palette-green", theme: "Green", name: "Green", image: THEME_CHARACTER_IMAGES.green },
  { id: "palette-blue", theme: "Blue", name: "Blue", image: THEME_CHARACTER_IMAGES.blue },
  { id: "palette-rose", theme: "Rose", name: "Rose", image: THEME_CHARACTER_IMAGES.rose },
  { id: "palette-ink", theme: "Ink", name: "Ink", image: THEME_CHARACTER_IMAGES.ink },
];

export const THEME_CHARACTERS: Record<string, { name: string; image: string; theme: string }> = Object.fromEntries(
  THEME_CHARACTER_LIST.map(({ id, name, image, theme }) => [id, { name, image, theme }]),
);

export const OPEN_CHARACTER_PICKER = "elpis-open-character-picker";
export function customCharacterImage(character: CustomCharacter) {
  return "url" in character.portrait ? character.portrait.url : THEME_CHARACTERS[character.portrait.builtin]?.image ?? MATILDA_SHOTS.softSmile;
}
/** The selected palette's character, or null for Matilda herself. */
export function useThemeCharacter() {
  const { selectedPalette, selectedCharacter, customThemes } = usePreferences(), { characters } = useCustomCharacters();
  const custom = characters.find(item => item.id === selectedCharacter);
  if (custom) return { name: custom.name, image: customCharacterImage(custom), theme: [...BUILT_IN_THEMES, ...parseCustomThemes(customThemes)].find(theme => theme.id === custom.themeId)?.name ?? "Current theme" };
  return THEME_CHARACTERS[selectedCharacter || selectedPalette] ?? null;
}
/** Who the person is talking to in Love Spot. */
export const useCompanionName = () => useThemeCharacter()?.name ?? "Matilda";

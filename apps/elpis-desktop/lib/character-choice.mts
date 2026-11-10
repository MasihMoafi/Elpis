import type { CustomCharacter } from './custom-character-types.mts';

/** A character may carry an optional palette. Restoring the character and applying the palette are separate choices. */
export function characterChoice(id: string, custom: readonly CustomCharacter[], followTheme = true): { selectedCharacter: string; selectedPalette?: string } {
  const character = custom.find(item => item.id === id);
  if (id.startsWith('custom-')) return { selectedCharacter: character ? id : 'elpis', ...(followTheme && character?.themeId ? { selectedPalette: character.themeId } : {}) };
  return { selectedCharacter: followTheme ? '' : id, ...(followTheme ? { selectedPalette: id } : {}) };
}

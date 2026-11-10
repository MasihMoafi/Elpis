/** Shared bridge/renderer contract. Portrait bytes never enter the saved preference store. */
export const CHARACTER_LIMITS = { description: 2000, name: 60, personality: 3000, imageBytes: 4 * 1024 * 1024, portraitBytes: 512 * 1024, count: 100 } as const;
export type CharacterPortrait = { builtin: string } | { dataUrl: string };
export type CharacterDraft = { name: string; description: string; personality: string; themeId: string | null; portrait: CharacterPortrait };
export type CustomCharacter = Omit<CharacterDraft, 'portrait'> & { id: string; portrait: { builtin: string } | { url: string } };
export type PortraitSource = { id: string; label: string; provider: string; model: string };
export type PortraitSources = { sources: PortraitSource[]; unavailable: string[] };
export type CharacterGeneration = { name: string; description: string; personality: string; suggestedThemeId: string | null; image: string; source: PortraitSource; warnings: string[] };

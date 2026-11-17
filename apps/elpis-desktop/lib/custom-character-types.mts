/** Shared bridge/renderer contract for previously saved characters. */
export const CHARACTER_LIMITS = {
  description: 2000, name: 60, personality: 3000, portraitBytes: 512 * 1024, count: 100,
} as const;
export type CustomCharacter = {
  id: string;
  name: string;
  description: string;
  personality: string;
  themeId: string | null;
  portrait: { builtin: string } | { url: string };
};

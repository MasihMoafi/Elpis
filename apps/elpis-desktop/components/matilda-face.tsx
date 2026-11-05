import { replyPortrait } from "@/bridge/matilda-face.cjs";
import { useThemeCharacter } from "@/lib/theme-characters";

/** Matilda's face beside a reply, in the clothes of the current theme (white silk in light mode, black in dark). Every chat
 * surface that shows her reply uses this one component, so her look follows the theme everywhere at once. */
export function MatildaFace({ expression = "listening", size, className = "" }: { expression?: string; size: number; className?: string }) {
  const portrait = replyPortrait(`<!--matilda:${expression}-->`), character = useThemeCharacter();
  // A palette with its own character shows her instead, one picture in light and dark (lib/theme-characters.ts).
  // eslint-disable-next-line @next/next/no-img-element
  if (character) return <span className={`relative block shrink-0 ${className}`} style={{ width: size, height: size }}><img src={character.image} alt="Matilda" data-character={character.name} width={size} height={size} className="matilda-theme-face absolute inset-0 h-full w-full object-contain" /></span>;
  return <span className={`relative block shrink-0 ${className}`} style={{ width: size, height: size }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={portrait.lightDataURL} alt="Matilda" width={size} height={size} className="absolute inset-0 h-full w-full object-contain dark:hidden" />
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={portrait.dataURL} alt="" aria-hidden="true" width={size} height={size} className="absolute inset-0 hidden h-full w-full object-contain dark:block" />
  </span>;
}

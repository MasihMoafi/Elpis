/** The avatars a user can choose (public/avatars/<id>.webp, 96 px, about 5 KB each). Only the chosen one loads at startup;
 * the others load when the picker is shown. */
export const AVATARS = [
  { id: "lucky", label: "Lucky" }, { id: "sable", label: "Sable" }, { id: "bricks", label: "Bricks" },
  { id: "the-don", label: "The Don" }, { id: "kingpin", label: "Kingpin" }, { id: "night-shift", label: "Night Shift" },
] as const;
export const AVATAR_IDS: string[] = AVATARS.map(avatar => avatar.id);
export const avatarSrc = (id: string) => `/avatars/${id}.webp`;

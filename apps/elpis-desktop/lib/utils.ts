import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** `record` without `key`; the same object when the key is not there, so React sees no change. */
export const without = <T,>(record: Record<string, T>, key: string) => { if (!(key in record)) return record; const next = { ...record }; delete next[key]; return next; };

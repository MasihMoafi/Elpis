"use client";

import type { ComponentProps, ReactNode } from "react";
import { SearchIcon } from "@/components/elpis-icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = ComponentProps<typeof Input> & {
  /** A shortcut shown at the right edge, such as "Ctrl K". */
  hint?: string;
  /** `bare` is the top row of a popup (the model picker): no fill, a divider below. */
  variant?: "filled" | "bare";
  /** Replaces the plain input, for a combobox's own input. */
  children?: ReactNode;
};

/** Every search field in the app: the same magnifier, gap, text size and focus outline (.search-field in globals.css). */
export function SearchField({ hint, variant = "filled", children, className, ...props }: Props) {
  return <label className={cn("search-field", variant === "bare" && "bare", className)}>
    <SearchIcon aria-hidden="true" />
    {children ?? <Input {...props} />}
    {hint && <kbd className="kbd-hint" aria-hidden="true">{hint}</kbd>}
  </label>;
}

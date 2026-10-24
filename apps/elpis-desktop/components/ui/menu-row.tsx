"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"

import { cn } from "@/lib/utils"

/** A row of a menu or list pop-up whose owner drives the keys itself (the Workflows board's menus, command bar and
 * find): the look of DropdownMenuItem and ComboboxItem (.hud-menu-item), as a button. */
function MenuRow({ className, ...props }: ButtonPrimitive.Props) {
  return (
    <ButtonPrimitive
      data-slot="menu-row"
      className={cn("hud-menu-item w-full cursor-pointer text-left text-sm outline-none select-none hover:bg-(--selected) focus-visible:bg-(--selected)", className)}
      {...props}
    />
  )
}

export { MenuRow }

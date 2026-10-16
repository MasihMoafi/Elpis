"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({ className, align = "end", sideOffset = 4, ...props }: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-50 outline-none" align={align} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn("min-w-36 rounded-lg border bg-card p-1 text-foreground shadow-md outline-none", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({ className, variant = "default", ...props }: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        variant === "destructive" && "text-destructive data-highlighted:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger }

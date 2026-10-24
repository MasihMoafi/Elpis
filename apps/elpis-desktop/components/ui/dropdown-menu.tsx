"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { Check, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({ className, align = "end", side, sideOffset = 4, alignOffset, ...props }: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset" | "alignOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-50 outline-none" align={align} side={side} sideOffset={sideOffset} alignOffset={alignOffset}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn("hud-menu min-w-36 outline-none", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({ className, variant = "default", onClick, ...props }: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn("hud-menu-item cursor-default text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4", className)}
      onClick={event => {
        onClick?.(event);
        // An action that moved focus (Reply puts it in the message box) keeps it: the item takes focus back after its click.
        const target = document.activeElement;
        if (target instanceof HTMLElement && target !== document.body && !target.closest('[role="menu"]')) requestAnimationFrame(() => {
          const current = document.activeElement;
          if (target.isConnected && (!current || current === document.body || current.closest('[role="menu"]'))) target.focus({ preventScroll: true });
        });
      }}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("hud-menu-separator", className)} {...props} />
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

/** A group's heading, in the menu's small heading style (.hud-menu-title). */
function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" className={cn("hud-menu-title", className)} {...props} />
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

/** One choice of a radio group; the chosen one carries a check at the right edge. */
function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn("hud-menu-item hud-menu-choice cursor-default text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4", className)}
      {...props}
    >
      {children}
      <MenuPrimitive.RadioItemIndicator className="hud-menu-check" keepMounted={false}><Check aria-hidden="true" /></MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

/** A menu inside a menu: `DropdownMenuSubTrigger` opens `DropdownMenuSubContent` beside it. */
function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn("hud-menu-item cursor-default text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-popup-open:bg-[var(--selected)] [&_svg]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="hud-menu-chevron" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({ align = "start", side = "inline-end", sideOffset = 2, alignOffset = -7, ...props }: React.ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent align={align} side={side} sideOffset={sideOffset} alignOffset={alignOffset} {...props} />
}

export {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
}

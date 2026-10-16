"use client"

import type { MouseEvent } from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { DropdownMenuContent } from "@/components/ui/dropdown-menu"

// A context menu is a dropdown menu opened at the pointer. Its popup and items are the dropdown's
// (Base UI's Menu parts), so both look and behave the same; only the root and the trigger differ.
function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />
}

/** Text, links, images and fields keep Electron's native menu (desktop/context-menu.cjs): for those the area stays out of the way. */
function wantsNativeMenu(event: MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest("input, textarea, a[href], img, [contenteditable]:not([contenteditable=false])")) return true
  // Selected text that starts or ends in this area and sits under the pointer. (A triple-click ends in the next block, so either end counts.)
  const selection = window.getSelection(), area = event.currentTarget
  return !!selection && !selection.isCollapsed && !!selection.toString() && (area.contains(selection.anchorNode) || area.contains(selection.focusNode)) && selection.containsNode(event.target as Node, true)
}

function ContextMenuTrigger({ onContextMenuCapture, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      onContextMenuCapture={event => {
        onContextMenuCapture?.(event)
        // Base UI cancels every right-click in its area from a document listener; stopping the event here
        // lets the native menu through.
        if (wantsNativeMenu(event)) { event.stopPropagation(); event.nativeEvent.stopImmediatePropagation() }
      }}
      {...props}
    />
  )
}

function ContextMenuContent(props: React.ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent align="start" sideOffset={2} {...props} />
}

export { ContextMenu, ContextMenuContent, ContextMenuTrigger }

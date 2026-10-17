"use client";
import type { ReactElement, ReactNode } from "react";
import { Tooltip as Primitive } from "@base-ui/react/tooltip";

/** A hover and focus tooltip as Claude's app shows on its icon buttons: the text, and a quieter detail line under it.
 * `suppressed` keeps it closed while the control's own popover is open. */
function Tooltip({ content, detail, children, side = "top", suppressed = false }: { content: ReactNode; detail?: ReactNode; children: ReactElement; side?: "top" | "bottom"; suppressed?: boolean }) {
  return <Primitive.Root open={suppressed ? false : undefined}>
    <Primitive.Trigger delay={300} closeDelay={0} render={children} />
    <Primitive.Portal><Primitive.Positioner side={side} sideOffset={6} className="isolate z-50">
      <Primitive.Popup className="hud-tooltip" data-slot="tooltip-content"><span>{content}</span>{detail ? <small>{detail}</small> : null}</Primitive.Popup>
    </Primitive.Positioner></Primitive.Portal>
  </Primitive.Root>;
}
export { Tooltip };

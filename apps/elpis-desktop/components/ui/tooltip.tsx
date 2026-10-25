"use client";
import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip as Primitive } from "@base-ui/react/tooltip";

/** A hover and focus tooltip as Claude's app shows on its icon buttons: the text, and a quieter detail line under it.
 * `suppressed` keeps it closed while the control's own popover is open. */
function Tooltip({ content, detail, children, side = "top", suppressed = false }: { content: ReactNode; detail?: ReactNode; children: ReactElement<{ "aria-describedby"?: string }>; side?: "top" | "bottom"; suppressed?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const describedBy = [children.props["aria-describedby"], open && !suppressed ? id : undefined].filter(Boolean).join(" ") || undefined;
  return <Primitive.Root open={suppressed ? false : undefined} onOpenChange={setOpen}>
    <Primitive.Trigger delay={300} closeDelay={0} render={cloneElement(children, { "aria-describedby": describedBy })} />
    <Primitive.Portal><Primitive.Positioner side={side} sideOffset={6} className="isolate z-50">
      <Primitive.Popup id={id} role="tooltip" className="hud-tooltip" data-slot="tooltip-content"><span>{content}</span>{detail ? <small>{detail}</small> : null}</Primitive.Popup>
    </Primitive.Positioner></Primitive.Portal>
  </Primitive.Root>;
}
export { Tooltip };

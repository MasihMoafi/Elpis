"use client";
import { Popover as Primitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";
const Popover = Primitive.Root;
function PopoverTrigger(props: Primitive.Trigger.Props) { return <Primitive.Trigger data-slot="popover-trigger" {...props} />; }
function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: Primitive.Popup.Props & Pick<Primitive.Positioner.Props, "align" | "sideOffset">) {
  return <Primitive.Portal><Primitive.Positioner align={align} sideOffset={sideOffset} className="isolate z-50"><Primitive.Popup data-slot="popover-content" className={cn("w-80 max-w-(--available-width) rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none", className)} {...props} /></Primitive.Positioner></Primitive.Portal>;
}
export { Popover, PopoverTrigger, PopoverContent };

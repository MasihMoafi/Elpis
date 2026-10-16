"use client";
// Adapted from shadcn/ui Base Nova Combobox (MIT): https://ui.shadcn.com/r/styles/base-nova/combobox.json
import { Combobox as Primitive } from "@base-ui/react/combobox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
const Combobox = Primitive.Root;
function ComboboxTrigger(props: Primitive.Trigger.Props) { return <Primitive.Trigger data-slot="combobox-trigger" {...props} />; }
function ComboboxInput(props: Primitive.Input.Props) { return <Primitive.Input data-slot="combobox-input" render={<Input />} {...props} />; }
function ComboboxContent({ className, side = "bottom", sideOffset = 6, align = "start", ...props }: Primitive.Popup.Props & Pick<Primitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return <Primitive.Portal><Primitive.Positioner side={side} sideOffset={sideOffset} align={align} className="isolate z-50"><Primitive.Popup data-slot="combobox-content" className={cn("relative max-h-(--available-height) max-w-(--available-width) overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md outline-none", className)} {...props} /></Primitive.Positioner></Primitive.Portal>;
}
function ComboboxList({ className, ...props }: Primitive.List.Props) { return <Primitive.List data-slot="combobox-list" className={cn("max-h-72 overflow-y-auto overscroll-contain p-1 outline-none", className)} {...props} />; }
function ComboboxItem({ className, children, ...props }: Primitive.Item.Props) {
  return <Primitive.Item data-slot="combobox-item" className={cn("relative flex cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50", className)} {...props}>{children}<Primitive.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center"><Check size={14} /></Primitive.ItemIndicator></Primitive.Item>;
}
function ComboboxEmpty({ className, ...props }: Primitive.Empty.Props) { return <Primitive.Empty data-slot="combobox-empty" className={cn("p-4 text-center text-sm text-muted-foreground empty:hidden", className)} {...props} />; }
export { Combobox, ComboboxTrigger, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty };

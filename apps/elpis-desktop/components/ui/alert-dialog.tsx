"use client"

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { Children, cloneElement, isValidElement, useId } from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogContent({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop data-slot="alert-dialog-overlay" className="fixed inset-0 z-50 bg-black/45" />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn("hud-dialog fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 outline-none", className)}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("text-base font-semibold break-words", className)} {...props} />
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}

/** The title and its description, kept together; the dialog's own gap separates the blocks below. */
function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-dialog-header" className={cn("grid gap-1.5", className)} {...props} />
}

function AlertDialogFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  const id = useId(), reasons: string[] = []
  const actions = Children.map(children, child => {
    if (!isValidElement<React.ComponentProps<typeof Button>>(child) || child.type !== Button || !child.props.disabled) return child
    const { variant = "default", disabledReason, title } = child.props
    if (!["default", "cutPrimary", "destructive"].includes(variant ?? "default") && !disabledReason && !title) return child
    const reason = disabledReason || title || "Wait for the current action to finish."
    let index = reasons.indexOf(reason)
    if (index < 0) { index = reasons.length; reasons.push(reason) }
    return cloneElement(child, { "aria-describedby": `${id}-${index}` })
  })
  return <div data-slot="alert-dialog-footer" className={cn("flex flex-wrap items-center justify-end gap-2", className)} {...props}>
    {reasons.length > 0 && <div role="status" className="min-w-0 basis-full text-sm text-muted-foreground">{reasons.map((reason, index) => <p key={reason} id={`${id}-${index}`}>{reason}</p>)}</div>}
    {actions}
  </div>
}

function AlertDialogClose(props: AlertDialogPrimitive.Close.Props) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />
}

export { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle }

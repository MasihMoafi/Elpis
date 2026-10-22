import type { ComponentProps } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Native keyboard and disclosure behavior, with the app's shared chevron. */
export function DisclosureSummary({ children, className, ...props }: ComponentProps<"summary">) {
  return <summary data-slot="disclosure-summary" className={cn("disclosure-summary", className)} {...props}>
    <ChevronRight size={14} className="disclosure-chevron" aria-hidden="true" />{children}
  </summary>;
}

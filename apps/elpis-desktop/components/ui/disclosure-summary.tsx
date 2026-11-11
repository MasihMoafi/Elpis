import type { ComponentProps } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The app's one disclosure: the native details element, so Enter and Space toggle it, assistive tools read its open state
 * and find-in-page opens it, with no script. Its first child is a DisclosureSummary, which hides the triangle. */
export function Disclosure(props: ComponentProps<"details">) {
  return <details {...props} />; // ui-check-ignore: the one owner; DisclosureSummary draws the chevron, not a triangle
}

/** Native keyboard and disclosure behavior, with the app's shared chevron. */
export function DisclosureSummary({ children, className, ...props }: ComponentProps<"summary">) {
  return (
    <summary data-slot="disclosure-summary" className={cn("disclosure-summary", className)} {...props}>
      <ChevronRight size={14} className="disclosure-chevron" aria-hidden="true" />
      {children}
    </summary>
  );
}

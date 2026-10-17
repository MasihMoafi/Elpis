"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Model } from "@/lib/api";

export type FailedTurn = { turnId: string; error: { message: string; codexErrorInfo?: string | Record<string, unknown>; additionalDetails?: string | null } };

/** Keep recovery beside the failed answer. Only complete text input can use thread/revert. */
export function FailedTurnCard({ failure, models, currentModel, disabled, blockedReason, onRetry }: {
  failure: FailedTurn; models: Model[]; currentModel?: string | null; disabled: boolean; blockedReason?: string;
  onRetry?: (model?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState("");
  const sending = useRef(false);
  const info = failure.error.codexErrorInfo;
  const kind = (typeof info === "string" ? info : Object.keys(info ?? {})[0] ?? "").toLowerCase();
  const overloaded = kind === "serveroverloaded" || (typeof info === "object" && info !== null &&
    (info.httpStatusCode === 529 || Object.values(info).some(value => typeof value === "object" && value !== null && "httpStatusCode" in value && value.httpStatusCode === 529)));
  const usage = kind === "usagelimitexceeded", limited = usage || kind === "ratelimitexceeded";
  const alternatives = [...new Map(models.filter(model => model.model !== currentModel).map(model => [model.model, model])).values()];
  async function retry(model?: string) {
    if (!onRetry || sending.current || sent || disabled) return;
    sending.current = true; setPending(true); setError("");
    try { await onRetry(model); setSent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; setPending(false); }
  }
  return <div role="alert" className="failed-turn-card rounded-lg border">
    <div className="grid gap-2 p-4">
      <h3 className="text-sm font-semibold">{overloaded ? "Model overloaded" : limited ? "Rate limited" : "Turn failed"}</h3>
      <p>{overloaded ? "Service is busy. Try again in a moment, or switch to a different model." : failure.error.message || "The turn could not finish. Try again in a moment."}</p>
      {blockedReason && <p className="text-muted-foreground">{blockedReason}</p>}
      {error && <p className="text-destructive">{error}</p>}
      {onRetry && <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" variant={usage ? "outline" : "default"} size="sm" disabled={disabled || pending || sent} onClick={() => void retry()}>{pending ? "Trying again…" : sent ? "Trying again" : "Try again"}</Button>
        {(overloaded || usage) && alternatives.length > 0 && <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant={usage ? "default" : "outline"} size="sm" disabled={disabled || pending || sent} />}>{usage ? "Switch model" : "Switch model and retry"}</DropdownMenuTrigger>
          <DropdownMenuContent>{alternatives.map(model => <DropdownMenuItem key={model.model} onClick={() => void retry(model.model)}>{model.displayName || model.model}</DropdownMenuItem>)}</DropdownMenuContent>
        </DropdownMenu>}
      </div>}
    </div>
  </div>;
}

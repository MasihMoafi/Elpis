"use client";
import { useState } from "react";
import { Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WORKFLOW_COLOURS, workflowNameProblem, type WorkflowCatalog, type WorkflowIdentity } from "@/lib/workflow-identity";

export function WorkflowMark({ identity, decorative = false, neutral = false }: { identity: WorkflowIdentity; decorative?: boolean; neutral?: boolean }) {
  if (neutral) return <Workflow className="shrink-0 text-muted-foreground" size={14} role={decorative ? undefined : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : "Workflow"} />;
  return <span className="thread-dot workflow-mark" data-colour={identity.colour} role={decorative ? undefined : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : `Workflow colour: ${identity.colour}`} title={identity.name} />;
}
export function WorkflowColourMenu({ identity, catalog, label = "Workflow colour", onError }: { identity: WorkflowIdentity; catalog: WorkflowCatalog; label?: string; onError: (error: string) => void }) {
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} title="Workflow colour" />}><WorkflowMark identity={identity} /></DropdownMenuTrigger>
    <DropdownMenuContent align="start"><DropdownMenuRadioGroup value={identity.colour} onValueChange={value => { try { catalog.recolour(identity.id, value as WorkflowIdentity["colour"]); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } }}>{WORKFLOW_COLOURS.map(colour => <DropdownMenuRadioItem key={colour} value={colour}><WorkflowMark decorative identity={{ ...identity, colour }} />{colour[0].toUpperCase() + colour.slice(1)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>;
}
export function WorkflowIdentityEditor({ identity, catalog, name, onName }: { identity: WorkflowIdentity; catalog: WorkflowCatalog; name: string; onName: (name: string) => void }) {
  const [error, setError] = useState(workflowNameProblem(catalog.identities, identity.id, name) ?? "");
  const save = () => { const problem = catalog.rename(identity.id, name); setError(problem ?? ""); if (!problem) onName(name.trim()); };
  return <>
    <div className="field"><Input aria-label="Graph name" aria-invalid={!!error} aria-describedby={error ? "workflow-name-error" : undefined} className="canvas-name" value={name} maxLength={120} onChange={event => { onName(event.target.value); setError(workflowNameProblem(catalog.identities, identity.id, event.target.value) ?? ""); }} onBlur={save} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
      {error && <span id="workflow-name-error" role="alert" className="text-xs text-destructive">{error}</span>}</div>
    <WorkflowColourMenu identity={identity} catalog={catalog} onError={setError} />
  </>;
}

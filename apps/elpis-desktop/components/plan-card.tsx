"use client";

import { DecisionCard, type Choice } from "@/components/decision-card";
import { permissionLabel, type PermissionMode } from "@/components/composer-controls";

/** A finished Plan-mode turn's plan, as Claude's plan card offers it: accept it in the chat's own permissions, accept it
 * and let Elpis approve for you (from Ask for approval), or keep planning with what should change (Esc). The engine has
 * no mode that asks before each edit, so Claude's "Accept" (review every edit) is not offered (lat.md/questions.md). */
export function PlanCard({ mode, busy, onImplement, onKeepPlanning }: { mode: PermissionMode; busy: boolean; onImplement: (permissions?: PermissionMode) => unknown; onKeepPlanning: (feedback: string) => unknown }) {
  const choices: Choice[] = [
    { label: "Accept", description: `Implement it with ${permissionLabel(mode)}`, choose: () => onImplement() },
    ...(mode === "ask" ? [{ label: "Accept and approve for me", description: "Switch this chat to Approve for me first: Elpis asks only for actions a reviewer judges unsafe", choose: () => onImplement("auto") }] : []),
    { label: "Keep planning", description: "Stay in Plan mode and say what should change", escape: true, ask: { label: "What should change?", placeholder: "What should change? (optional)", submit: "Keep planning", send: onKeepPlanning } },
  ];
  return <DecisionCard title="Elpis proposed a plan" choices={choices} busy={busy} />;
}

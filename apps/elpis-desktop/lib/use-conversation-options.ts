import { useState } from "react";
import type { PermissionMode } from "@/components/composer-controls";
import type { NextTurn } from "@/lib/workspace-types";

/** New-chat defaults and the overrides held for an existing chat's next turn. */
export function useConversationOptions() {
  const [choiceId, setChoiceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [nextTurn, setNextTurn] = useState<Record<string, NextTurn>>({});
  const [threadModes, setThreadModes] = useState<Record<string, PermissionMode>>({});
  const [changingPermissions, setChangingPermissions] = useState(false);
  const [threadPlans, setThreadPlans] = useState<Record<string, boolean>>({});
  const [newPlan, setNewPlan] = useState(false);
  const [planAnswered, setPlanAnswered] = useState<Record<string, string>>({});
  const [newMode, setNewMode] = useState<PermissionMode | null>(null);
  return {
    choiceId,
    setChoiceId,
    model,
    setModel,
    effort,
    setEffort,
    nextTurn,
    setNextTurn,
    threadModes,
    setThreadModes,
    changingPermissions,
    setChangingPermissions,
    threadPlans,
    setThreadPlans,
    newPlan,
    setNewPlan,
    planAnswered,
    setPlanAnswered,
    newMode,
    setNewMode,
  };
}

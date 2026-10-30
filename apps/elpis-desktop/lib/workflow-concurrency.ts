import { api, unreadable } from "@/lib/api";

type WorkflowConcurrency = { value: number; choices: number[] };
function checked(value: unknown): WorkflowConcurrency {
  if (!value || typeof value !== "object") throw unreadable("workflow concurrency");
  const data = value as Partial<WorkflowConcurrency>;
  if (!Number.isSafeInteger(data.value) || !Array.isArray(data.choices) || !data.choices.length || !data.choices.every(choice => Number.isSafeInteger(choice) && choice > 0) || !data.choices.includes(data.value!)) throw unreadable("workflow concurrency");
  return data as WorkflowConcurrency;
}
export async function readWorkflowConcurrency() { return checked(await api<unknown>("/workflows/concurrency")); }
export async function saveWorkflowConcurrency(value: number) { return checked(await api<unknown>("/workflows/concurrency", { value })); }

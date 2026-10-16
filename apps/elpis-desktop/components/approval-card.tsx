"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import type { Approval } from "@/lib/api";
import { elicitationChoices, elicitationFormContent, fieldOptions, grantedPermissions } from "@/lib/approvals";

const DECISION_LABELS: Record<string, string> = { accept: "Allow", acceptForSession: "Allow for this session", decline: "Decline", cancel: "Cancel" };
// Elpis offers "always allow" amendments as objects naming the command prefix or host they cover.
function decisionLabel(decision: unknown): string | null {
  if (typeof decision === "string") return DECISION_LABELS[decision] || null;
  if (!decision || typeof decision !== "object") return null;
  if ("acceptWithExecpolicyAmendment" in decision) return "Always allow this prefix";
  if ("applyNetworkPolicyAmendment" in decision) return "Always allow this host";
  return null;
}
function decisionScope(decision: unknown): string | null {
  if (!decision || typeof decision !== "object") return null;
  if ("acceptWithExecpolicyAmendment" in decision) {
    const value = (decision as {acceptWithExecpolicyAmendment: {execpolicy_amendment?: unknown}}).acceptWithExecpolicyAmendment.execpolicy_amendment;
    return Array.isArray(value) ? value.map(argument => JSON.stringify(argument)).join(" ") : JSON.stringify(value ?? decision);
  }
  if ("applyNetworkPolicyAmendment" in decision) return JSON.stringify((decision as {applyNetworkPolicyAmendment: unknown}).applyNetworkPolicyAmendment);
  return null;
}
export type QuestionAnswers = Record<string, string[]>;
export function ApprovalCard({ approval, answer, answers, onAnswerChange, busy }: { approval: Approval; answer: (id: string, body: unknown) => Promise<void>; answers: QuestionAnswers; onAnswerChange: (id: string, value: string) => void; busy: boolean }) {
  const [error, setError] = useState("");
  function changeAnswer(id: string, value: string) { setError(""); onAnswerChange(id,value); }
  async function submit(body: unknown | (() => unknown)) { if (busy) return; setError(""); try { await answer(approval.id, typeof body === "function" ? body() : body); } catch (e) { setError(String(e)); } }
  const params = approval.params;
  const elicitation = approval.method === "mcpServer/elicitation/request";
  const permissions = approval.method === "item/permissions/requestApproval";
  const schema = elicitation ? params.requestedSchema : null;
  const choices = elicitation ? elicitationChoices(params) : [];
  const toolName = typeof params._meta?.tool_title === "string" ? params._meta.tool_title : params._meta?.tool_name;
  const toolParams = params._meta?.tool_params_display ?? params._meta?.tool_params;
  const actions: {label:string; primary?:boolean; body:unknown | (() => unknown)}[] = elicitation
    ? choices.map(choice => ({label:choice.label, primary:choice.action === "accept" && !choice.persist, body:() => ({action:choice.action,content:choice.action === "accept" && schema && Object.keys(schema.properties).length ? elicitationFormContent(schema, answers) : null,_meta:choice.persist ? {persist:choice.persist} : null})}))
    : permissions && params.permissions ? [
      {label:"Yes, grant these permissions for this turn",primary:true,body:{permissions:grantedPermissions(params.permissions),scope:"turn"}},
      {label:"Yes, grant for this turn with strict auto review",body:{permissions:grantedPermissions(params.permissions),scope:"turn",strictAutoReview:true}},
      {label:"Yes, grant these permissions for this session",body:{permissions:grantedPermissions(params.permissions),scope:"session"}},
      {label:"No, continue without permissions",body:{permissions:{},scope:"turn"}},
    ] : [];
  const offered = (approval.params.availableDecisions ?? Object.keys(DECISION_LABELS)).filter(decision => decisionLabel(decision));
  const questions = approval.params.questions;
  const buttons: {label:string;primary?:boolean;disabled?:boolean;body:unknown}[] = elicitation || permissions ? actions : questions
    ? [{label:"Send answers",primary:true,disabled:questions.some(q => !answers[q.id]?.[0]),body:{answers}}]
    : offered.map(decision => ({label:decisionLabel(decision)!,primary:decision === "accept",body:{decision}}));
  return <section className="approval" onKeyDown={event => { if ((elicitation || permissions) && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void submit(elicitation ? {action:"cancel",content:null,_meta:null} : {permissions:{},scope:"turn"}); } }}>
    <h3>{questions || schema && Object.keys(schema.properties).length ? "Elpis needs your input" : permissions ? "Grant additional permissions?" : "Approval requested"}</h3>
    {elicitation && <>
      <p>{params.serverName}{typeof toolName === "string" && <> · <strong>{toolName}</strong></>}</p>
      {params.message && <p className="approval-reason">{params.message}</p>}
      {toolParams !== undefined && <pre>{JSON.stringify(toolParams,null,2)}</pre>}
      {params.url && <p><a href={params.url} target="_blank" rel="noreferrer">{params.url}</a></p>}
      {params.mode === "openai/userVerification" && <p className="approval-reason">This request needs device verification. You can deny or cancel it here.</p>}
    </>}
    {approval.params.reason && <p className="approval-reason">{approval.params.reason}</p>}
    {permissions && <><p>{params.cwd}</p><pre>{JSON.stringify(params.permissions,null,2)}</pre></>}
    {approval.params.command && <pre>{approval.params.command}</pre>}
    {!elicitation && !permissions && offered.map((decision, index) => decisionScope(decision) && <div className="approval-scope" key={index}><p>{typeof decision === "object" && decision && "acceptWithExecpolicyAmendment" in decision ? "Command prefix scope (argv)" : "Host policy scope"}:</p><code>{decisionScope(decision)}</code></div>)}
    {schema && Object.entries(schema.properties).map(([key, field]) => {
      if (!field) return null;
      const label = field.title || key, options = fieldOptions(field);
      const value = answers[key]?.[0] ?? (field.default === undefined ? "" : field.type === "array" ? JSON.stringify(field.default) : String(field.default));
      return <div key={key}>
        {field.type === "array" ? <fieldset disabled={busy} className="my-3"><legend>{label}</legend>{options.map(option => <label key={option.value} className="grid-cols-[auto_1fr] items-center gap-2"><input type="checkbox" className="checkbox accent-primary" checked={(value ? JSON.parse(value) as string[] : []).includes(option.value)} onChange={event => { const values: string[] = value ? JSON.parse(value) : []; changeAnswer(key, JSON.stringify(event.target.checked ? [...values,option.value] : values.filter(v => v !== option.value))); }}/>{option.label}</label>)}</fieldset>
        : <label htmlFor={`${approval.id}-${key}`}>{label}
          {field.type === "boolean" || options.length ? <OptionSelect id={`${approval.id}-${key}`} aria-label={label} disabled={busy} value={value} onChange={event => changeAnswer(key,event.target.value)}><option value="">Choose an answer</option>{field.type === "boolean" ? <><option value="true">Yes</option><option value="false">No</option></> : options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</OptionSelect>
          : <Input id={`${approval.id}-${key}`} aria-label={label} disabled={busy} value={value} type={field.type === "number" || field.type === "integer" ? "number" : "format" in field && field.format === "email" ? "email" : "text"} min={"minimum" in field ? field.minimum : undefined} max={"maximum" in field ? field.maximum : undefined} step={field.type === "integer" ? 1 : "any"} onChange={event => changeAnswer(key,event.target.value)} />}
        </label>}
        {field.description && <p className="approval-reason">{field.description}</p>}
      </div>;
    })}
    {questions?.map(q => <label key={q.id}>{q.question}
      {q.options ? <OptionSelect className="rounded-md border p-2" disabled={busy} value={answers[q.id]?.[0] || ""} onChange={e => changeAnswer(q.id, e.target.value)}><option value="">Choose an answer</option>{q.options.map(o => <option key={o.label} value={o.label}>{o.label}{o.description ? ` — ${o.description}` : ""}</option>)}</OptionSelect> : null}
      <Input aria-label={`Answer: ${q.header || q.id}`} placeholder={q.options ? "Or write your own answer" : "Your answer"} type={q.isSecret ? "password" : "text"} disabled={busy} value={answers[q.id]?.[0] || ""} onChange={e => changeAnswer(q.id, e.target.value)} />
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div className="approval-actions">
      {buttons.map((action,index) => <Button key={index} variant={action.primary ? "default" : "outline"} className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]" disabled={busy || action.disabled} onClick={() => submit(action.body)}>{action.label}</Button>)}
    </div>
  </section>;
}

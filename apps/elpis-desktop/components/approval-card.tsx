"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FilePathText } from "@/components/file-ref";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { ChoiceRow, DecisionCard, type Choice } from "@/components/decision-card";
import type { Approval } from "@/lib/api";
import { elicitationChoices, elicitationFormContent, fieldOptions, grantedPermissions } from "@/lib/approvals";
import { OTHER_ANSWER, questionAnswer, questionState, type Question } from "@/lib/questions";

type Decision = unknown;
/** A shell word as typed: plain words stay bare, anything else is quoted. */
const shellWord = (word: unknown) => typeof word === "string" && /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word);
/** One of the engine's command and edit decisions as a numbered choice, in Claude's words where the meaning matches. */
function decisionChoice(decision: Decision, edit: boolean): Omit<Choice, "choose"> | null {
  if (decision === "accept") return { label: "Allow once" };
  if (decision === "acceptForSession") return { label: "Allow for this session", description: edit ? "Don't ask again for these files in this session" : "Don't ask again for this command in this session" };
  if (decision === "decline") return { label: "Deny", description: edit ? "Elpis goes on without these changes" : "Elpis goes on without running it", escape: true };
  if (decision === "cancel") return { label: "Deny and stop", description: "Stops this turn" };
  if (!decision || typeof decision !== "object") return null;
  if ("acceptWithExecpolicyAmendment" in decision) {
    const prefix = (decision as { acceptWithExecpolicyAmendment: { execpolicy_amendment?: unknown } }).acceptWithExecpolicyAmendment.execpolicy_amendment;
    return { label: "Always allow", description: <>Don&apos;t ask again for commands that start with <code>{Array.isArray(prefix) ? prefix.map(shellWord).join(" ") : JSON.stringify(prefix)}</code></> };
  }
  if ("applyNetworkPolicyAmendment" in decision) {
    const rule = (decision as { applyNetworkPolicyAmendment: { network_policy_amendment?: { host?: string; action?: string } } }).applyNetworkPolicyAmendment.network_policy_amendment;
    const host = <code>{rule?.host ?? JSON.stringify(rule)}</code>;
    return rule?.action === "deny" ? { label: "Deny, and always block this host", description: <>Block {host} from now on</> } : { label: "Always allow this host", description: <>Don&apos;t ask again for {host}</> };
  }
  return null;
}
const DEFAULT_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];

export type QuestionAnswers = Record<string, string[]>;
export function ApprovalCard({ approval, answer, deny, answers, onAnswerChange, busy, globalKeys }: {
  approval: Approval; answer: (id: string, body: unknown) => Promise<void>;
  /** "Deny, and tell Elpis what to do instead" (bridge: POST /api/approvals/<id>/instead). */
  deny: (id: string, instead: string) => Promise<void>;
  answers: QuestionAnswers; onAnswerChange: (id: string, value: string[]) => void; busy: boolean; globalKeys?: boolean;
}) {
  const [error, setError] = useState("");
  function changeAnswer(id: string, value: string[]) { setError(""); onAnswerChange(id, value); }
  async function submit(run: () => Promise<void>) { if (busy) return; setError(""); try { await run(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }
  const send = (body: unknown | (() => unknown)) => submit(() => answer(approval.id, typeof body === "function" ? body() : body));
  const params = approval.params;
  const elicitation = approval.method === "mcpServer/elicitation/request";
  const permissions = approval.method === "item/permissions/requestApproval";
  const edit = approval.method === "item/fileChange/requestApproval";
  const questions = params.questions;
  const schema = elicitation ? params.requestedSchema : null;
  const form = !!schema && Object.keys(schema.properties).length > 0;
  const toolName = typeof params._meta?.tool_title === "string" ? params._meta.tool_title : params._meta?.tool_name;
  const toolParams = params._meta?.tool_params_display ?? params._meta?.tool_params;
  const card = { busy, error, globalKeys, className: "approval" };

  if (questions) return <QuestionCard {...card} questions={questions} answers={answers} onChange={changeAnswer} onSubmit={() => send({ answers: Object.fromEntries(questions.map(question => [question.id, questionAnswer(question, answers[question.id])])) })} />;

  let choices: Choice[];
  if (elicitation) choices = elicitationChoices(params).map(choice => ({
    label: choice.action === "accept" ? form ? "Submit" : choice.persist ? choice.label : "Allow once" : choice.label, escape: choice.action === "cancel",
    choose: () => send(() => ({ action: choice.action, content: choice.action === "accept" && form ? elicitationFormContent(schema!, answers) : null, _meta: choice.persist ? { persist: choice.persist } : null })),
  }));
  else if (permissions && params.permissions) {
    const granted = grantedPermissions(params.permissions);
    choices = [
      { label: "Yes, grant these permissions for this turn", choose: () => send({ permissions: granted, scope: "turn" }) },
      { label: "Yes, grant for this turn with strict auto review", choose: () => send({ permissions: granted, scope: "turn", strictAutoReview: true }) },
      { label: "Yes, grant these permissions for this session", choose: () => send({ permissions: granted, scope: "session" }) },
      { label: "No, continue without permissions", escape: true, choose: () => send({ permissions: {}, scope: "turn" }) },
    ];
  } else {
    const offered = (params.availableDecisions ?? DEFAULT_DECISIONS).flatMap(decision => { const choice = decisionChoice(decision, edit); return choice ? [{ ...choice, choose: () => send({ decision }) }] : []; });
    // The engine has no "deny with a message": the instruction joins the waiting turn, then the request is declined.
    const at = offered.findIndex(choice => choice.escape);
    choices = at < 0 || !params.turnId ? offered : [...offered.slice(0, at + 1), { label: "Deny, and tell Elpis what to do instead", ask: { label: "What should Elpis do instead?", placeholder: "Tell Elpis what to do instead", submit: "Deny and send", send: (text: string) => text ? submit(() => deny(approval.id, text)) : offered[at].choose!() } }, ...offered.slice(at + 1)];
  }
  const title = form ? "Elpis needs your input" : elicitation ? `Allow Elpis to use ${typeof toolName === "string" ? toolName : params.serverName || "this tool"}?` : permissions ? "Grant additional permissions?"
    : approval.method === "item/commandExecution/requestApproval" ? "Allow Elpis to run this command?" : edit ? "Allow Elpis to edit files?" : "Approval requested";
  return <DecisionCard {...card} title={title} choices={choices}>
    {elicitation && <>
      <p className="decision-note">{params.serverName}{typeof toolName === "string" && <> · <strong>{toolName}</strong></>}</p>
      {params.message && <p className="decision-note">{params.message}</p>}
      {toolParams !== undefined && <pre><FilePathText text={JSON.stringify(toolParams, null, 2)}/></pre>}
      {params.url && <p><a href={params.url} target="_blank" rel="noreferrer">{params.url}</a></p>}
      {params.mode === "openai/userVerification" && <p className="decision-note">This request needs device verification. You can deny or cancel it here.</p>}
    </>}
    {params.reason && <p className="decision-note"><FilePathText text={params.reason}/></p>}
    {permissions && <><p className="decision-note">{params.cwd}</p><pre><FilePathText text={JSON.stringify(params.permissions, null, 2)}/></pre></>}
    {params.changes != null && <pre><FilePathText text={JSON.stringify(params.changes, null, 2)}/></pre>}
    {params.command && <pre><FilePathText text={params.command}/></pre>}
    {form && Object.entries(schema!.properties).map(([key, field]) => {
      if (!field) return null;
      const label = field.title || key, options = fieldOptions(field);
      const value = answers[key]?.[0] ?? (field.default === undefined ? "" : field.type === "array" ? JSON.stringify(field.default) : String(field.default));
      return <div key={key}>
        {field.type === "array" ? <fieldset disabled={busy} className="my-3"><legend>{label}</legend>{options.map(option => <label key={option.value} className="grid-cols-[auto_1fr] items-center gap-2"><input type="checkbox" className="checkbox accent-primary" checked={(value ? JSON.parse(value) as string[] : []).includes(option.value)} onChange={event => { const values: string[] = value ? JSON.parse(value) : []; changeAnswer(key, [JSON.stringify(event.target.checked ? [...values, option.value] : values.filter(v => v !== option.value))]); }} />{option.label}</label>)}</fieldset>
        : <label htmlFor={`${approval.id}-${key}`}>{label}
          {field.type === "boolean" || options.length ? <OptionSelect id={`${approval.id}-${key}`} aria-label={label} disabled={busy} value={value} onChange={event => changeAnswer(key, [event.target.value])}><option value="">Choose an answer</option>{field.type === "boolean" ? <><option value="true">Yes</option><option value="false">No</option></> : options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</OptionSelect>
          : <Input id={`${approval.id}-${key}`} aria-label={label} disabled={busy} value={value} type={field.type === "number" || field.type === "integer" ? "number" : "format" in field && field.format === "email" ? "email" : "text"} min={"minimum" in field ? field.minimum : undefined} max={"maximum" in field ? field.maximum : undefined} step={field.type === "integer" ? 1 : "any"} onChange={event => changeAnswer(key, [event.target.value])} />}
        </label>}
        {field.description && <p className="decision-note">{field.description}</p>}
      </div>;
    })}
  </DecisionCard>;
}

/** request_user_input: each question's options as numbered radios plus "Other" (your own answer), as Claude's
 * AskUserQuestion card has them. The number keys answer the first unanswered question, then move to the next. */
function QuestionCard({ questions, answers, onChange, onSubmit, ...card }: { questions: Question[]; answers: QuestionAnswers; onChange: (id: string, value: string[]) => void; onSubmit: () => void; busy: boolean; error: string; globalKeys?: boolean; className: string }) {
  const states = questions.map(question => questionState(question, answers[question.id]));
  const firstOpen = (from: number) => { for (let step = 1; step <= questions.length; step++) { const at = (from + step) % questions.length; if (!states[at].answered) return at; } return from; };
  const [active, setActive] = useState(() => Math.max(0, states.findIndex(state => !state.answered)));
  const complete = states.every(state => state.answered);
  const others = useRef<Record<string, HTMLInputElement | null>>({});
  function pick(at: number, option: number) {
    const question = questions[at], options = question.options ?? [];
    if (option < options.length) { onChange(question.id, [options[option].label]); states[at] = { ...states[at], answered: true }; setActive(firstOpen(at)); }
    else { onChange(question.id, [OTHER_ANSWER, `user_note: ${states[at].other}`]); setActive(at); requestAnimationFrame(() => others.current[question.id]?.focus()); }
  }
  const current = questions[active], count = current ? (current.options?.length ?? 0) + (states[active].otherOffered ? 1 : 0) : 0;
  return <DecisionCard {...card} title={questions.length === 1 ? "Elpis has a question" : `Elpis has ${questions.length} questions`}
    keys={{ count, pick: option => pick(active, option), enter: () => { if (complete) onSubmit(); } }}
    actions={<Button size="sm" disabled={card.busy || !complete} onClick={onSubmit}>Submit</Button>}>
    {questions.map((question, at) => {
      const state = states[at], numbered = at === active;
      if (!question.options?.length) return <div key={question.id} className="decision-question"><label className="decision-free">{question.question}
        <Input aria-label={`Answer: ${question.header || question.id}`} placeholder="Your answer" type={question.isSecret ? "password" : "text"} disabled={card.busy} value={answers[question.id]?.[0] || ""} onChange={event => onChange(question.id, [event.target.value])} />
      </label></div>;
      return <div key={question.id} className="decision-question">
        <p className="decision-question-text" id={`${question.id}-question`}>{question.question}</p>
        <div className="decision-choices" role="radiogroup" aria-labelledby={`${question.id}-question`}>
          {question.options.map((option, index) => <ChoiceRow key={option.label} index={numbered ? index : undefined} label={option.label} description={option.description} checked={state.choice === index} disabled={card.busy} onClick={() => pick(at, index)} />)}
          {state.otherOffered && <ChoiceRow index={numbered ? question.options.length : undefined} label="Other" checked={state.choice === "other"} disabled={card.busy} onClick={() => pick(at, question.options!.length)} />}
        </div>
        {state.choice === "other" && <div className="decision-other"><Input ref={element => { others.current[question.id] = element; }} aria-label={`Other answer: ${question.question}`} placeholder="Type your own answer here" type={question.isSecret ? "password" : "text"} disabled={card.busy} value={state.other}
          onChange={event => onChange(question.id, [OTHER_ANSWER, `user_note: ${event.target.value}`])}
          onKeyDown={event => { if (event.key !== "Enter" || event.nativeEvent.isComposing) return; event.preventDefault(); if (complete) onSubmit(); else { setActive(firstOpen(at)); event.currentTarget.closest<HTMLElement>("[data-decision-card]")?.focus(); } }} /></div>}
      </div>;
    })}
  </DecisionCard>;
}

"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { SmartPruneLine } from "@/components/smart-prune";
import { useEffect, useId, useRef, useState } from "react";
import { BranchIcon, BrowserIcon, PlanIcon, StopIcon } from "@/components/elpis-icons";
import { BrowserComments } from "@/components/browser-comments";
import { BROWSER_COMMENTS, DRAWING_NOTE } from "@/lib/browser-notes";
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, Copy, Signpost, FileText, Pencil, RefreshCw, Reply, Terminal, Undo2, Volume2 } from "lucide-react";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton, MarkdownText } from "@/components/markdown-text";
import { ImageThumb, fileKind } from "@/components/file-cards";
import { ReplyableImage } from "@/components/image-reply";
import { FilePathText } from "@/components/file-ref";
import { ItemEdits } from "@/components/edit-rows";
import { Step } from "@/components/step";
import { unreadable, type Item, type Thread, taskFromPath, title } from "@/lib/api";
import { inlineMediaUrl } from "@/lib/attachments";
import { plainText } from "@/lib/message-copy";
import { useReadAloud } from "@/components/read-aloud";
import "@/components/message-actions.css";
import "@/components/message-body.css";
import { ReplyPreview } from "@/components/message-reply";
import { messageDomId, readReply } from "@/lib/message-reply";
import { questionReplies, questionReplyText } from "@/lib/question-reply";
import type { VersionControl } from "@/lib/turn-replacement";
import { noticeOf, type WorkflowNotice } from "@/lib/workflow-notice";
import { reasoningOf, shellTokens, stepDuration, stepFailed, stepLabel, summarize, unwrapShell } from "@/lib/steps";
// Built into the page, as the board has it: no request that can fail or arrive late (Masih, 23 Oct).
import { FACE_DATA_URL } from "@/bridge/matilda-face.cjs";
import { runCard } from "@/lib/run-card";

const object = (value: unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readable = (value: string) => value.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/_/g," ");
/** A status worth a word on a row: a step that went well says nothing. */
const statusLabel = (value: unknown) => { const status = text(value); return !status || status === "completed" ? "" : ({inProgress:"Running",failed:"Failed",declined:"Declined",cancelled:"Cancelled"} as Record<string,string>)[status] || readable(status); };
function attachmentLabel(part: Record<string, unknown>) {
  const type = text(part.type);
  const label = ({ image: "Image", localImage: "Image", audio: "Audio", localAudio: "Audio", skill: "Skill", mention: "Mention" } as Record<string, string>)[type] || readable(type) || "Attachment";
  return [label, text(part.name) || text(part.path).split(/[\\/]/).at(-1)].filter(Boolean).join(" · ");
}
function fileAttachment(part: Record<string, unknown>): string | null {
  if (part.type !== "text") return null;
  const elements = list(part.text_elements ?? part.textElements);
  if (elements.length !== 1) return null;
  const element = object(elements[0]), range = object(element.byteRange), placeholder = text(element.placeholder), contents = text(part.text);
  const name = placeholder.startsWith("Attachment: ") ? placeholder.slice(12) : "";
  return name && contents.startsWith(`File: ${name}\n`) && range.start === 0 && range.end === new TextEncoder().encode(contents).length ? name : null;
}
function RecordedAttachment({part,index,mediaBase}:{part:Record<string,unknown>;index:number;mediaBase?:string}) {
  const [failed,setFailed] = useState(false), label = attachmentLabel(part), type = text(part.type);
  const kind = type === "image" || type === "localImage" ? "image" : type === "audio" || type === "localAudio" ? "audio" : null;
  const url = text(part.url), local = type === "localImage" || type === "localAudio";
  const safeBase = mediaBase?.startsWith("/api/threads/") && !/[?#\\]/.test(mediaBase) ? mediaBase : null;
  const source = kind ? (local && safeBase ? `${safeBase}/${index}` : inlineMediaUrl(url,kind)) : null;
  if (source && !failed) return <div className="space-y-1" title={text(part.path) || undefined}><span className="break-all text-xs text-muted-foreground">{label}</span>{kind === "image"
    ? <ReplyableImage src={source} name={text(part.name) || label}><img src={source} alt={label} loading="lazy" className="max-h-80 max-w-full rounded-md object-contain" onError={()=>setFailed(true)}/></ReplyableImage>
    : <audio src={source} aria-label={label} controls preload="none" className="max-w-full" onError={()=>setFailed(true)}/>}</div>;
  return <div className="break-all" title={text(part.path) || undefined}>{label}{kind && <span className="text-xs text-muted-foreground">{failed ? " — Preview unavailable; the recorded file may have moved or its format could not be read." : /^https?:\/\//i.test(url) ? <> — <a href={url} target="_blank" rel="noreferrer noopener" className="underline">Open {kind}</a></> : " — Preview unavailable."}</span>}</div>;
}
function TextOutput({value}:{value:unknown}) {
  if(value===null||value===undefined||value==="")return null;
  return <pre className="step-output"><code><FilePathText text={typeof value==="string"?value:JSON.stringify(value,null,2)} /></code></pre>;
}
/** A tool's step: a sentence, its time (or what went wrong) at the right, and its details in the card that opens under it. */
function Activity({label,status,time,failed,children,open=false}:{label:string;status?:unknown;time?:number;failed?:boolean;children?:React.ReactNode;open?:boolean}) {
  const word=statusLabel(status),duration=stepDuration(time);
  return <Step open={open} title={<FilePathText text={label}/>} failed={failed??text(status)==="failed"} body={children} meta={(word||duration)?<>{word&&<span className={`step-status ${text(status)}`}>{word}</span>}{duration&&<span>{duration}</span>}</>:undefined}/>;
}
const NOTICE_OUTCOME: Record<string, string> = { completed: "finished", stopped: "was stopped", failed: "failed" };
/** A workflow's end notice, as Claude Code shows a finished task: one step naming the run and its outcome, the result inside. */
function WorkflowNoticeStep({notice}:{notice:WorkflowNotice}) {
  return <Activity label={`Workflow ${notice.name} ${NOTICE_OUTCOME[notice.status] ?? "ended"}`} failed={notice.status==="failed"}>
    {notice.summary&&<p className="step-note">{notice.summary}</p>}
    <TextOutput value={notice.result}/>
  </Activity>;
}
/** A command as Claude's desktop app shows it in an opened group: a short title, the script in a bordered block
 * coloured as shell, then its output; a failed command's exit code and output in red. */

/** The evidence a workflow prompt carries as JSON (Mother's checkpoint and recovery prompts, an agent's connected answers):
 * the chat folds it under its label, pretty-printed, after the prompt's own words. */
const EVIDENCE = /\n(Current evidence|Current nodes|Answers from connected agents \(source material\)):\n([\[{][\s\S]*)$/;
function promptEvidence(value: string) {
  const found = value.match(EVIDENCE); if (!found) return null;
  try { return { text: value.slice(0, found.index).trim(), label: found[1], json: JSON.stringify(JSON.parse(found[2]), null, 2) }; } catch { return null; }
}
export function CommandStep({item,open=true}:{item:Item;open?:boolean}) {
  const failed=stepFailed(item),output=text(item.aggregatedOutput).replace(/\n+$/,""),duration=stepDuration(item.durationMs);
  const outcome=failed ? typeof item.exitCode==="number" ? `failed · exit ${item.exitCode}` : "Failed" : typeof item.exitCode==="number" ? "passed" : statusLabel(item.status)||"Result not recorded";
  return <Step open={open} failed={failed} title={<FilePathText text={stepLabel(item)}/>} meta={open ? duration||undefined : <><span>{outcome}</span>{duration&&<span>{duration}</span>}</>} body={<>
    <pre className="step-script" title={text(item.cwd)||undefined}><code>{shellTokens(unwrapShell(text(item.command))).map((token,index)=>token.kind==="text"?<FilePathText key={index} text={token.text}/>:<span key={index} className={`sh-${token.kind}`}><FilePathText text={token.text}/></span>)}</code></pre>
    {failed&&typeof item.exitCode==="number"&&<p className="step-exit">Exit code {item.exitCode}</p>}
    {output&&<pre className="step-output"><code><FilePathText text={output}/></code></pre>}
  </>}/>;
}
/** What a person can do with a message: the hover buttons, the "…" and the right-click menu all draw this one list.
 * `menuLabel` is the item's words in the menus (the hover button keeps its short name); `menuOnly` items have no hover button. */
type MessageAction = MenuAction & { title?: string; copy?: () => string; menuLabel?: string; menuOnly?: boolean };
const write = (value: string) => void navigator.clipboard.writeText(value).catch(() => {});
/** "Copy as Markdown": the message as written; the hover button copies the same. */
const copyAction = (label: string, text: () => string): MessageAction => ({ id: "copy", label, menuLabel: "Copy as Markdown", icon: <Copy size={14}/>, copy: text, run: () => write(text()) });
/** "Copy text": the message as a reader sees it, without the Markdown marks. */
const copyTextAction = (markdown: () => string, markup = true): MessageAction => ({ id: "copy-text", label: "Copy text", icon: <FileText size={14}/>, menuOnly: true, run: () => write(markup ? plainText(markdown()) : markdown()) });
const replyAction = (reply?: () => void): MessageAction[] => reply ? [{ id: "reply", label: "Reply", icon: <Reply size={14}/>, run: reply }] : [];
const rewindAction = (rewind?: () => void): MessageAction[] => rewind ? [{ id: "rewind", label: "Rewind to here", icon: <Undo2 size={14}/>, menuOnly: true, run: rewind }] : [];
const menuActions = (actions: MessageAction[]): MenuAction[] => actions.map(action => ({ ...action, label: action.menuLabel ?? action.label }));
function MessageButtons({actions}:{actions:MessageAction[]}) {
  return <>{actions.filter(action=>!action.menuOnly).map(action=>action.copy?<CopyButton key={action.id} label={action.label} text={action.copy}/>:<Button key={action.id} variant="ghost" size="icon-xs" aria-label={action.label} title={action.title??action.label} onClick={action.run}>{action.icon}</Button>)}
    <MoreMenu actions={menuActions(actions)} label="More message actions" title="More actions" />
  </>;
}
/** Measure the rendered body so formatting, font size and narrow/RTL text use the same fold control. */
function CollapsibleMessage({children, direction}:{children:React.ReactNode;direction?:"auto"}) {
  const body = useRef<HTMLDivElement>(null), id = useId();
  const [long, setLong] = useState(false), [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const element = body.current; if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element), line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
      setLong(element.scrollHeight > line * 16);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const folded = long && collapsed;
  return <div className="message-body">
    {long && <Button type="button" variant="ghost" size="xs" className="message-fold-control" data-preserve-scroll aria-expanded={!folded} aria-controls={id} onClick={() => setCollapsed(!folded)}>{folded ? "Expand message" : "Collapse message"}</Button>}
    <div id={id} className={folded ? "message-body-preview" : undefined} inert={folded} aria-hidden={folded || undefined}>
      <div ref={body} className="message-body-content" dir={direction}>{children}</div>
    </div>
  </div>;
}
/** ChatGPT's ‹ 2 / 2 › under an edited message: the other versions of it, one click away. */
function MessageVersions({version}:{version:VersionControl}) {
  return <span className="message-versions" role="group" aria-label="Message versions">
    <Button variant="ghost" size="icon-xs" aria-label="Previous version" title="Previous version" disabled={!version.onPrevious} onClick={version.onPrevious}><ChevronLeft size={14}/></Button>
    <span className="text-xs tabular-nums text-muted-foreground">{version.index} / {version.count}</span>
    <Button variant="ghost" size="icon-xs" aria-label="Next version" title="Next version" disabled={!version.onNext} onClick={version.onNext}><ChevronRight size={14}/></Button>
  </span>;
}
/** Sending an edit replaces this message and every later turn through Elpis (thread/revert), then starts the edited turn;
 * the message's attachments go with the edited text, and the chat as it was stays reachable as the previous version. */
function UserMessage({body,bodyContent,attachments,attachmentContent,copyText,onEdit,onRewind,editBlockedReason,editDraft,onEditDraftChange,editPending,time,onReply,reference,replyContent,version}:{version?:VersionControl;onReply?:()=>void;reference?:string;replyContent?:React.ReactNode;body:string;bodyContent?:React.ReactNode;attachments:string[];attachmentContent?:React.ReactNode;copyText?:string;onEdit?:(text:string)=>Promise<void>;onRewind?:()=>void;editBlockedReason?:string;editDraft?:string;onEditDraftChange?:(value:string|null)=>void;editPending?:boolean;time?:number}) {
  const [localEditing,setEditing]=useState(false);const [localDraft,setLocalDraft]=useState(body);const [localBusy,setBusy]=useState(false);const [error,setError]=useState("");
  const busy=localBusy||!!editPending;
  const editing=onEditDraftChange?editDraft!==undefined:localEditing,draft=onEditDraftChange?editDraft??body:localDraft;
  const setDraft=(value:string)=>onEditDraftChange?onEditDraftChange(value):setLocalDraft(value);
  const cancel=()=>{if(onEditDraftChange)onEditDraftChange(null);else{setEditing(false);setLocalDraft(body);}setError("");};
  async function save(){if(busy||!onEdit||!draft.trim())return;setBusy(true);setError("");try{await onEdit(draft);if(!onEditDraftChange)setEditing(false);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  if(editing)return <form className="message user editing" aria-label="Edit message" onSubmit={e=>{e.preventDefault();void save();}}>
    <Textarea aria-label="Edited message" value={draft} rows={3} autoFocus disabled={busy} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"&&!busy)cancel();}}/>
    <p className="text-xs text-muted-foreground">{attachments.length?"Sending replaces this message and everything after it; its attachments stay with it.":"Sending replaces this message and everything after it."} The earlier version stays one click away.</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>Cancel</Button><Button type="submit" size="sm" disabled={busy||!onEdit||!draft.trim()}>{busy?"Sending…":"Send"}</Button></div>
  </form>;
  const whole=()=>copyText ?? [body,...attachments].filter(Boolean).join("\n");
  const actions:MessageAction[]=[...replyAction(onReply),copyTextAction(whole,false),copyAction("Copy message",whole),...(onEdit?[{id:"edit",label:"Edit message",menuLabel:"Edit and retry",title:"Edit and resend",icon:<Pencil size={14}/>,run:()=>{setDraft(body);setError("");setEditing(true);}}]:[]),...rewindAction(onRewind)];
  return <RightClickMenu actions={menuActions(actions)} area={<div className="user-turn" id={reference ? messageDomId(reference) : undefined} data-message-reference={onReply ? reference : undefined} tabIndex={reference ? -1 : undefined}/>}><div className="message user">{replyContent}<CollapsibleMessage direction="auto">{bodyContent ?? body}</CollapsibleMessage>{attachmentContent || (attachments.length>0&&<ul className="mt-2 space-y-1 text-sm" aria-label="Message attachments">{attachments.map((label,index)=><li key={index}>{label}</li>)}</ul>)}{!body&&!attachments.length&&<span>Message content unavailable.</span>}</div><div className="message-actions">
    {time&&<time className="message-time" dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()}>{new Date(time).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</time>}
    {version&&<MessageVersions version={version}/>}
    <MessageButtons actions={actions}/>
    {!onEdit&&editBlockedReason&&<Button variant="ghost" size="icon-xs" aria-label="Why editing is unavailable" title={editBlockedReason} onClick={()=>setError(previous=>previous?"":editBlockedReason)}><Pencil size={14}/></Button>}
  </div>{error&&<p role="status" className="mb-3 text-xs text-muted-foreground">{error}</p>}</RightClickMenu>;
}
export function ChatMessage({item,speaker="Elpis",threads=[],onOpenThread,onEdit,onRegenerate,onFork,onRewind,time,editBlockedReason,editDraft,onEditDraftChange,editPending,mediaBase,activityLabel,onReply,reference,readAloud=false,version}:{version?:VersionControl;readAloud?:boolean;onReply?:()=>void;reference?:string;item:Item;speaker?:string;threads?:Thread[];onOpenThread?:(id:string)=>void;onEdit?:(text:string)=>Promise<void>;onRegenerate?:()=>void;onFork?:()=>void;onRewind?:()=>void;time?:number;editBlockedReason?:string;editDraft?:string;onEditDraftChange?:(value:string|null)=>void;editPending?:boolean;mediaBase?:string;activityLabel?:string}) {
  const speech = useReadAloud();
  const notice=noticeOf(item);
  if(notice)return <WorkflowNoticeStep notice={notice}/>;
  if(item.type==="userMessage"){
    const content=list(item.content).map(object),attached=content.map((part,index)=>({part,index,file:fileAttachment(part)})).filter(({part,file})=>part.type!=="text" || file),attachments=attached.map(({part,file})=>file || attachmentLabel(part));
    const replies=attached.flatMap(({part,file})=>{const reply=file?readReply({name:file,type:"text",text:text(part.text).slice(`File: ${file}\n`.length)}):null;return reply?[reply]:[];});
    const reason=editBlockedReason;
    const shown=attached.filter(({part,file})=>file!==DRAWING_NOTE&&(!file||!readReply({name:file,type:"text",text:text(part.text).slice(`File: ${file}\n`.length)}))),attachmentContent=shown.length ? <ul className="mt-2 space-y-3 text-sm" aria-label="Message attachments">{shown.map(({part,index,file})=><li key={index}>{file===BROWSER_COMMENTS ? <BrowserComments text={text(part.text).slice(`File: ${file}\n`.length)}/> : file ? <details className="max-w-full rounded-md border border-border p-2"><DisclosureSummary className="cursor-pointer break-all">{file}</DisclosureSummary><pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words text-left">{text(part.text).slice(`File: ${file}\n`.length)}</pre></details> : <RecordedAttachment part={part} index={index} mediaBase={mediaBase}/>}</li>)}</ul> : undefined;
    const originalBody=content.filter(part=>part.type==="text"&&!fileAttachment(part)).map(part=>text(part.text)).join("\n"), answers=questionReplies(originalBody);
    const body=answers?questionReplyText(answers):originalBody;
    const evidence=answers?null:promptEvidence(originalBody);
    const bodyContent=evidence?<div className="space-y-2"><p className="whitespace-pre-wrap" dir="auto">{evidence.text}</p><details><DisclosureSummary>{evidence.label}</DisclosureSummary><pre className="step-output"><code>{evidence.json}</code></pre></details></div>:answers?<div className="space-y-3">{answers.map((reply,index)=><div key={index} className="space-y-1"><p className="text-sm text-muted-foreground" dir="auto">{reply.question}</p><p dir="auto">{reply.answer}</p></div>)}</div>:undefined;
    const copyText=answers?[body,...content.filter(part=>part.type!=="text"||fileAttachment(part)).map(part=>part.type==="text"?text(part.text):attachmentLabel(part))].join("\n"):content.map(part=>part.type==="text"?text(part.text):attachmentLabel(part)).join("\n");
    const edit=reason||!onEdit?undefined:answers?(value:string)=>onEdit(value===body?originalBody:value):onEdit;
    return <UserMessage onReply={onReply} reference={reference} replyContent={replies.map(reply=><ReplyPreview key={reply.reference} reply={reply}/>)} body={body} bodyContent={bodyContent} copyText={copyText} attachments={attachments} attachmentContent={attachmentContent} onEdit={edit} onRewind={onRewind} editBlockedReason={reason} editDraft={editDraft} onEditDraftChange={onEditDraftChange} editPending={editPending} time={time} version={version}/>;
  }
  if(item.type==="agentMessage"){
    if(item.text!==undefined&&typeof item.text!=="string")throw unreadable("message");
    const speechId = reference ?? item.id, speaking = speech?.active === speechId, verdict = runCard(item.text || "");
    const spokenText = readAloud ? plainText(item.text || "") : "";
    const speechAction:MessageAction[] = speech && (speaking || (readAloud && spokenText.trim())) ? [{ id: "read-aloud", label: speaking ? "Stop" : "Read aloud", title: speaking ? "Stop reading aloud" : "Read aloud · ChatGPT voice", icon: speaking ? <StopIcon size={14}/> : <Volume2 size={14}/>, run: () => speaking ? speech.stop() : speech.play(speechId, spokenText) }] : [];
    const actions:MessageAction[]=item.text?[...replyAction(onReply),copyTextAction(()=>item.text||""),copyAction("Copy reply",()=>item.text||""),...speechAction,...(onRegenerate?[{id:"regenerate",label:"Regenerate reply",title:"Regenerate",icon:<RefreshCw size={14}/>,run:onRegenerate}]:[]),...rewindAction(onRewind),...(onFork?[{id:"fork",label:"Fork chat from here",icon:<BranchIcon size={14}/>,run:onFork}]:[])]:[];
    return <RightClickMenu actions={menuActions(actions)} area={<article className={speaker==="Matilda"?"message agent flow-root":"message agent"} id={reference ? messageDomId(reference) : undefined} data-message-reference={onReply ? reference : undefined} tabIndex={reference ? -1 : undefined} {...(speechAction.length ? { onPointerEnter: speech?.warm, onFocus: speech?.warm } : {})}/>}>{speaker==="Matilda"&&<img src={FACE_DATA_URL} alt="Matilda" width={64} height={64} className="float-left mb-2 mr-4 h-16 w-16 object-contain"/>}{speaker!=="Elpis"&&<div className="speaker">{speaker}</div>}<CollapsibleMessage>{verdict?<section className={verdict.failed?"plan-card check-failed":"plan-card"} aria-label={verdict.label}><p className="plan-card-heading">{verdict.mother?<Signpost size={14} aria-hidden="true"/>:verdict.failed?<CircleX size={14} aria-hidden="true"/>:<CircleCheck size={14} aria-hidden="true"/>}{verdict.heading}</p><MarkdownText text={verdict.text}/></section>:<MarkdownText text={item.text||""}/>}</CollapsibleMessage>{speech?.error?.id===speechId&&<p role="alert" className="text-sm text-destructive">{speech.error.message}</p>}{actions.length>0&&<div className="message-actions"><MessageButtons actions={actions}/></div>}</RightClickMenu>;
  }
  if(item.type==="smartPrune")return <SmartPruneLine value={item.prune} mediaBase={mediaBase}/>;
  if(item.type==="commandExecution")return <CommandStep item={item}/>;
  if(item.type==="fileChange")return <ItemEdits item={item}/>;
  if(item.type==="mcpToolCall"||item.type==="dynamicToolCall"){
    const result=object(item.result);const contents=list(item.type==="mcpToolCall"?result.content:item.contentItems);
    const output=contents.map(part=>text(object(part).text)).filter(Boolean).join("\n");const error=object(item.error);
    const label=item.type==="mcpToolCall"?stepLabel(item):`Used ${text(item.tool)||"a tool"}`;
    return <Activity label={label} status={item.status} time={typeof item.durationMs==="number"?item.durationMs:undefined}>{item.arguments!==undefined&&<details className="step-input"><DisclosureSummary>Input</DisclosureSummary><TextOutput value={item.arguments}/></details>}{output?<TextOutput value={output}/>:result.structuredContent?<TextOutput value={result.structuredContent}/>:contents.length?<p className="step-note">Non-text output is recorded for this tool.</p>:null}{text(error.message)&&<p role="alert" className="step-note step-error"><FilePathText text={text(error.message)}/></p>}</Activity>;
  }
  if(item.type==="subAgentActivity"){
    const id=text(item.agentThreadId),agent=threads.find(thread=>thread.id===id);
    const label=({started:"Agent started",interacted:"Agent interaction",interrupted:"Agent interrupted",completed:"Agent completed"} as Record<string,string>)[text(item.kind)]||"Agent activity";
    const identity=agent?title(agent):taskFromPath(item.agentPath)||text(item.agentPath);
    return <div className="activity-card"><div className="activity-heading"><span className="activity-icon"><BranchIcon size={15}/></span><span className="activity-title">{label}</span>{identity&&<span className="activity-preview" title={text(item.agentPath)||identity}>{identity}</span>}{id&&onOpenThread&&<Button variant="ghost" size="xs" className="ml-auto" onClick={()=>onOpenThread(id)}>Open chat</Button>}</div>{(text(item.model)||text(item.reasoningEffort))&&<p className="activity-location px-3 pb-2 text-xs text-muted-foreground">{[text(item.model),text(item.reasoningEffort)&&`${text(item.reasoningEffort)} reasoning`].filter(Boolean).join(" · ")}</p>}</div>;
  }
  if(item.type==="collabAgentToolCall"){
    const ids=list(item.receiverThreadIds).filter((id):id is string=>typeof id==="string");
    const agentTool=({spawn_agent:"Started an agent",spawnAgent:"Started an agent",wait:"Waited for agents",wait_agent:"Waited for agents",close_agent:"Closed an agent",closeAgent:"Closed an agent",send_input:"Messaged an agent",sendInput:"Messaged an agent",resume_agent:"Resumed an agent",interrupt_agent:"Interrupted an agent"} as Record<string,string>)[text(item.tool)];
    return <Activity label={activityLabel??(agentTool||readable(text(item.tool))||"Agent activity")} status={item.status}>{text(item.prompt)&&<p className="step-note">{text(item.prompt)}</p>}{text(item.model)&&<p className="step-note">{text(item.model)}</p>}<div className="step-agents">{ids.filter(Boolean).map(id=><Button key={id} variant="outline" size="sm" onClick={()=>onOpenThread?.(id)} disabled={!onOpenThread}>{threads.some(t=>t.id===id)?title(threads.find(t=>t.id===id)!):"Open agent conversation"}</Button>)}</div></Activity>;
  }
  if(item.type==="reasoning"){
    const reasoning=reasoningOf(item);
    return reasoning?<Activity label="Reasoning" open><MarkdownText text={reasoning}/></Activity>:null;
  }
  if(item.type==="webSearch"){
    const results=list(item.results);
    // Nothing to open when the search recorded no results: the row alone says what was searched.
    return <Activity label={stepLabel(item)} status={item.status}>{results.length>0&&<div className="step-results">{results.map((value,index)=>{const result=object(value);const href=text(result.url);return /^https?:\/\//i.test(href)?<p key={index}><a href={href} target="_blank" rel="noreferrer">{text(result.title)||href}</a>{text(result.snippet)&&<span>{text(result.snippet)}</span>}</p>:<TextOutput key={index} value={value}/>;})}</div>}</Activity>;
  }
  if(item.type==="functionCallOutput")return <Activity label={text(item.name)||"Tool output"}><TextOutput value={typeof item.output==="string"?item.output:list(item.output).map(value=>text(object(value).text)).filter(Boolean).join("\n")}/></Activity>;
  if(item.type==="plan")return <section className="plan-card" aria-label="Proposed plan"><p className="plan-card-heading"><PlanIcon size={14} aria-hidden="true"/>Plan</p><MarkdownText text={item.text||""}/></section>;
  if(item.type==="imageView"){
    const name=fileKind(text(item.path)).name,safeBase=mediaBase?.startsWith("/api/threads/")&&!/[?#\\]/.test(mediaBase)?mediaBase:null;
    // Nothing to fold: the step is its picture.
    return <div className="activity-card"><div className="activity-heading"><span className="activity-icon"><BrowserIcon size={15}/></span><span className="activity-title">Viewed an image</span><span className="activity-preview" title={text(item.path)}>{name}</span></div>{safeBase&&<div className="px-3 pb-2"><ImageThumb src={`${safeBase}/0`} name={name} large/></div>}</div>;
  }
  if(item.type==="contextCompaction")return <div className="context-event">{summarize([item])}</div>;
  if(item.type==="enteredReviewMode")return <div className="context-event">{`Review started${typeof item.review==="string"&&item.review?`: ${item.review}`:""}`}</div>;
  if(item.type==="exitedReviewMode")return <article className={speaker==="Matilda"?"message agent flow-root":"message agent"}><MarkdownText text={typeof item.review==="string"?item.review:""}/></article>;
  return <Activity label={readable(item.type)}><details className="step-input"><DisclosureSummary>Recorded details</DisclosureSummary><TextOutput value={item}/></details></Activity>;
}

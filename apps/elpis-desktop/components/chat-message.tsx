"use client";

import { useState } from "react";
import { FileDiff, GitBranch, GitFork, Globe, Pencil, RefreshCw, Terminal, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton, MarkdownText } from "@/components/markdown-text";
import { type Item, type Thread, taskFromPath, title } from "@/lib/api";
import { inlineMediaUrl } from "@/lib/attachments";

const object = (value: unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readable = (value: string) => value.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/_/g," ");
const statusLabel = (value: unknown) => ({inProgress:"Running",completed:"Completed",failed:"Failed",declined:"Declined",cancelled:"Cancelled"}[text(value)] || readable(text(value)));
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
    ? <img src={source} alt={label} loading="lazy" className="max-h-80 max-w-full rounded-md object-contain" onError={()=>setFailed(true)}/>
    : <audio src={source} aria-label={label} controls preload="none" className="max-w-full" onError={()=>setFailed(true)}/>}</div>;
  return <div className="break-all" title={text(part.path) || undefined}>{label}{kind && <span className="text-xs text-muted-foreground">{failed ? " — Preview unavailable; the recorded file may have moved or its format could not be read." : /^https?:\/\//i.test(url) ? <> — <a href={url} target="_blank" rel="noreferrer noopener" className="underline">Open {kind}</a></> : " — Preview unavailable."}</span>}</div>;
}
function TextOutput({value}:{value:unknown}) {
  if(value===null||value===undefined||value==="")return null;
  return <pre className="activity-output"><code>{typeof value==="string"?value:JSON.stringify(value,null,2)}</code></pre>;
}
function Activity({label,icon,status,detail,children}:{label:string;icon:React.ReactNode;status?:unknown;detail?:string;children:React.ReactNode}) {
  return <details className="activity-card"><summary className="activity-heading"><span className="activity-icon">{icon}</span><span className="activity-title">{label}</span>{detail&&<span className="activity-preview">{detail}</span>}{statusLabel(status)&&<span className={`activity-status status-${text(status)}`}>{statusLabel(status)}</span>}</summary><div className="activity-body">{children}</div></details>;
}
/** Sending an edit replaces this message and every later turn through Elpis (thread/revert), then starts the edited turn. */
function UserMessage({body,attachments,attachmentContent,copyText,onEdit,editBlockedReason,editDraft,onEditDraftChange,editPending,time}:{body:string;attachments:string[];attachmentContent?:React.ReactNode;copyText?:string;onEdit?:(text:string)=>Promise<void>;editBlockedReason?:string;editDraft?:string;onEditDraftChange?:(value:string|null)=>void;editPending?:boolean;time?:number}) {
  const [localEditing,setEditing]=useState(false);const [localDraft,setLocalDraft]=useState(body);const [localBusy,setBusy]=useState(false);const [error,setError]=useState("");
  const busy=localBusy||!!editPending;
  const editing=onEditDraftChange?editDraft!==undefined:localEditing,draft=onEditDraftChange?editDraft??body:localDraft;
  const setDraft=(value:string)=>onEditDraftChange?onEditDraftChange(value):setLocalDraft(value);
  const cancel=()=>{if(onEditDraftChange)onEditDraftChange(null);else{setEditing(false);setLocalDraft(body);}setError("");};
  async function save(){if(busy||!onEdit||!draft.trim())return;setBusy(true);setError("");try{await onEdit(draft);if(!onEditDraftChange)setEditing(false);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  if(editing)return <form className="message user editing" aria-label="Edit message" onSubmit={e=>{e.preventDefault();void save();}}>
    <Textarea aria-label="Edited message" value={draft} rows={3} autoFocus disabled={busy} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"&&!busy)cancel();}}/>
    <p className="text-xs text-muted-foreground">Sending replaces this message and everything after it.</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>Cancel</Button><Button type="submit" size="sm" disabled={busy||!onEdit||!draft.trim()}>{busy?"Sending…":"Send"}</Button></div>
  </form>;
  return <div className="user-turn"><div className="message user">{body}{attachmentContent || (attachments.length>0&&<ul className="mt-2 space-y-1 text-sm" aria-label="Message attachments">{attachments.map((label,index)=><li key={index}>{label}</li>)}</ul>)}{!body&&!attachments.length&&<span>Message content unavailable.</span>}</div><div className="message-actions">
    {time&&<time className="message-time" dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()}>{new Date(time).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</time>}
    <CopyButton label="Copy message" text={()=>copyText ?? [body,...attachments].filter(Boolean).join("\n")}/>
    {onEdit&&<Button variant="ghost" size="icon-xs" aria-label="Edit message" title="Edit and resend" onClick={()=>{setDraft(body);setError("");setEditing(true);}}><Pencil size={14}/></Button>}
    {!onEdit&&editBlockedReason&&<Button variant="ghost" size="icon-xs" aria-label="Why editing is unavailable" title={editBlockedReason} onClick={()=>setError(previous=>previous?"":editBlockedReason)}><Pencil size={14}/></Button>}
  </div>{error&&<p role="status" className="mb-3 text-xs text-muted-foreground">{error}</p>}</div>;
}
export function ChatMessage({item,speaker="Elpis",threads=[],onOpenThread,onEdit,onRegenerate,onFork,time,editBlockedReason,editDraft,onEditDraftChange,editPending,mediaBase}:{item:Item;speaker?:string;threads?:Thread[];onOpenThread?:(id:string)=>void;onEdit?:(text:string)=>Promise<void>;onRegenerate?:()=>void;onFork?:()=>void;time?:number;editBlockedReason?:string;editDraft?:string;onEditDraftChange?:(value:string|null)=>void;editPending?:boolean;mediaBase?:string}) {
  if(item.type==="userMessage"){
    const content=list(item.content).map(object),attached=content.map((part,index)=>({part,index,file:fileAttachment(part)})).filter(({part,file})=>part.type!=="text" || file),attachments=attached.map(({part,file})=>file || attachmentLabel(part));
    const reason=editBlockedReason||(attachments.length?"This message contains attachments that this app cannot safely resend.":undefined);
    const attachmentContent=attached.length ? <ul className="mt-2 space-y-3 text-sm" aria-label="Message attachments">{attached.map(({part,index,file})=><li key={index}>{file ? <details className="max-w-full rounded-md border border-border p-2"><summary className="cursor-pointer break-all">{file}</summary><pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words text-left">{text(part.text).slice(`File: ${file}\n`.length)}</pre></details> : <RecordedAttachment part={part} index={index} mediaBase={mediaBase}/>}</li>)}</ul> : undefined;
    return <UserMessage body={content.filter(part=>part.type==="text"&&!fileAttachment(part)).map(part=>text(part.text)).join("\n")} copyText={content.map(part=>part.type==="text"?text(part.text):attachmentLabel(part)).join("\n")} attachments={attachments} attachmentContent={attachmentContent} onEdit={reason?undefined:onEdit} editBlockedReason={reason} editDraft={editDraft} onEditDraftChange={onEditDraftChange} editPending={editPending} time={time}/>;
  }
  if(item.type==="agentMessage")return <article className="message agent">{speaker!=="Elpis"&&<div className="speaker">{speaker}</div>}<MarkdownText text={item.text||""}/>{item.text&&<div className="message-actions"><CopyButton label="Copy reply" text={()=>item.text||""}/>{onRegenerate&&<Button variant="ghost" size="icon-xs" aria-label="Regenerate reply" title="Regenerate" onClick={onRegenerate}><RefreshCw size={14}/></Button>}{onFork&&<Button variant="ghost" size="icon-xs" aria-label="Fork chat from here" title="Fork chat from here" onClick={onFork}><GitFork size={14}/></Button>}</div>}</article>;
  if(item.type==="commandExecution")return <Activity label="Terminal" icon={<Terminal size={15}/>} status={item.status} detail={item.command?.split("\n")[0]}><TextOutput value={item.command}/>{text(item.cwd)&&<p className="activity-location">{text(item.cwd)}</p>}<TextOutput value={item.aggregatedOutput}/><div className="activity-footer">{typeof item.exitCode==="number"&&<span>Exit {item.exitCode}</span>}{typeof item.durationMs==="number"&&<span>{(item.durationMs/1000).toFixed(1)}s</span>}</div></Activity>;
  if(item.type==="fileChange"){
    const changes=list(item.changes).map(object);
    return <Activity label={`${changes.length} file ${changes.length===1?"change":"changes"}`} icon={<FileDiff size={15}/>} status={item.status}>{changes.map((change,index)=><details className="file-change" key={`${text(change.path)}:${index}`}><summary><span className="file-change-kind">{readable(text(object(change.kind).type))}</span>{text(change.path)}</summary><TextOutput value={change.diff}/></details>)}<TextOutput value={item.output}/></Activity>;
  }
  if(item.type==="mcpToolCall"||item.type==="dynamicToolCall"){
    const result=object(item.result);const contents=list(item.type==="mcpToolCall"?result.content:item.contentItems);
    const output=contents.map(part=>text(object(part).text)).filter(Boolean).join("\n");const error=object(item.error);
    return <Activity label={text(item.tool)||"Tool call"} icon={<Wrench size={15}/>} status={item.status} detail={text(item.server)||text(item.namespace)}>{item.arguments!==undefined&&<details className="activity-input"><summary>Input</summary><TextOutput value={item.arguments}/></details>}{output?<TextOutput value={output}/>:result.structuredContent?<TextOutput value={result.structuredContent}/>:contents.length?<p>Non-text output is recorded for this tool.</p>:null}{text(error.message)&&<p role="alert">{text(error.message)}</p>}{typeof item.durationMs==="number"&&<p className="activity-footer">{(item.durationMs/1000).toFixed(1)}s</p>}</Activity>;
  }
  if(item.type==="subAgentActivity"){
    const id=text(item.agentThreadId),agent=threads.find(thread=>thread.id===id);
    const label=({started:"Agent started",interacted:"Agent interaction",interrupted:"Agent interrupted",completed:"Agent completed"} as Record<string,string>)[text(item.kind)]||"Agent activity";
    const identity=agent?title(agent):taskFromPath(item.agentPath)||text(item.agentPath);
    return <div className="activity-card"><div className="activity-heading"><span className="activity-icon"><GitBranch size={15}/></span><span className="activity-title">{label}</span>{identity&&<span className="activity-preview" title={text(item.agentPath)||identity}>{identity}</span>}{id&&onOpenThread&&<Button variant="ghost" size="xs" className="ml-auto" onClick={()=>onOpenThread(id)}>Open chat</Button>}</div>{(text(item.model)||text(item.reasoningEffort))&&<p className="activity-location px-3 pb-2 text-xs text-muted-foreground">{[text(item.model),text(item.reasoningEffort)&&`${text(item.reasoningEffort)} reasoning`].filter(Boolean).join(" · ")}</p>}</div>;
  }
  if(item.type==="collabAgentToolCall"){
    const ids=list(item.receiverThreadIds).filter((id):id is string=>typeof id==="string");
    const agentTool=({spawn_agent:"Started an agent",spawnAgent:"Started an agent",wait:"Waited for agents",wait_agent:"Waited for agents",close_agent:"Closed an agent",closeAgent:"Closed an agent",send_input:"Messaged an agent",sendInput:"Messaged an agent",resume_agent:"Resumed an agent",interrupt_agent:"Interrupted an agent"} as Record<string,string>)[text(item.tool)];
    return <Activity label={agentTool||readable(text(item.tool))||"Agent activity"} icon={<GitBranch size={15}/>} status={item.status}>{text(item.prompt)&&<p className="activity-prompt">{text(item.prompt)}</p>}{text(item.model)&&<p className="activity-location">{text(item.model)}</p>}<div className="activity-agents">{ids.filter(Boolean).map(id=><Button key={id} variant="outline" size="sm" onClick={()=>onOpenThread?.(id)} disabled={!onOpenThread}>{threads.some(t=>t.id===id)?title(threads.find(t=>t.id===id)!):"Open agent conversation"}</Button>)}</div></Activity>;
  }
  if(item.type==="reasoning"){
    const reasoning=[...list(item.summary),...list(item.content)].filter((v):v is string=>typeof v==="string"&&Boolean(v.trim())).join("\n\n");
    return reasoning?<Activity label="Reasoning" icon={<Wrench size={15}/>}><MarkdownText text={reasoning}/></Activity>:null;
  }
  if(item.type==="webSearch")return <Activity label="Web search" icon={<Globe size={15}/>} detail={text(item.query)}><p>{text(item.query)}</p>{list(item.results).map((value,index)=>{const result=object(value);const href=text(result.url);return /^https?:\/\//i.test(href)?<p key={index}><a href={href} target="_blank" rel="noreferrer">{text(result.title)||href}</a>{text(result.snippet)&&<span>{text(result.snippet)}</span>}</p>:<TextOutput key={index} value={value}/>;})}</Activity>;
  if(item.type==="functionCallOutput")return <Activity label={text(item.name)||"Tool output"} icon={<Wrench size={15}/>}><TextOutput value={typeof item.output==="string"?item.output:list(item.output).map(value=>text(object(value).text)).filter(Boolean).join("\n")}/></Activity>;
  if(item.type==="plan")return <Activity label="Plan" icon={<Wrench size={15}/>}><MarkdownText text={item.text||""}/></Activity>;
  if(item.type==="contextCompaction")return <div className="context-event">Context compacted</div>;
  return <Activity label={readable(item.type)} icon={<Wrench size={15}/>}><details><summary>Recorded details</summary><TextOutput value={item}/></details></Activity>;
}

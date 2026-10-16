"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {ArrowLeft,ArrowRight,Globe,Plus,RefreshCw,Square,X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import type {BrowserState,DesktopBrowser} from "@/lib/desktop";

export function BrowserPanel({onVisibleChange,covered}:{onVisibleChange:(visible:boolean)=>void;covered:boolean}) {
  const [api,setApi]=useState<DesktopBrowser|null>(null);
  const [state,setState]=useState<BrowserState|null>(null);
  const [error,setError]=useState("");
  const [edit,setEdit]=useState<{tab:string;value:string}|null>(null);
  const [width,setWidth]=useState<number|null>(null);
  const [resizing,setResizing]=useState(false);
  const [modal,setModal]=useState(false);
  const viewport=useRef<HTMLDivElement>(null),address=useRef<HTMLInputElement>(null),panel=useRef<HTMLElement>(null);
  const drag=useRef<{x:number;width:number}|null>(null);
  const active=state?.tabs.find(tab=>tab.id===state.activeId);
  useEffect(()=>{
    const browser=window.elpisDesktop?.browser;if(!browser)return;
    setApi(browser);let disposed=false;
    const update=(value:BrowserState)=>{if(!disposed){setState(value);onVisibleChange(value.visible);}};
    const unsubscribe=browser.subscribe(update);
    void browser.command("state").then(update).catch(e=>setError(e.message));
    return()=>{disposed=true;unsubscribe();};
  },[onVisibleChange]);
  useEffect(()=>{
    const refresh=()=>setModal([...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[data-slot="popover-content"],[data-slot="combobox-content"]')].some(element=>element.getClientRects().length>0));
    const observer=new MutationObserver(refresh);observer.observe(document.body,{childList:true,subtree:true});refresh();
    return()=>observer.disconnect();
  },[]);
  const layout=useCallback(()=>{
    const element=viewport.current;if(!api||!element)return;
    const rect=element.getBoundingClientRect();
    api.layout({bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},obscured:covered||modal||resizing||!state?.visible});
  },[api,covered,modal,resizing,state?.visible]);
  useEffect(()=>{
    if(!state?.visible||!viewport.current)return;
    const observer=new ResizeObserver(layout);observer.observe(viewport.current);window.addEventListener("resize",layout);layout();
    return()=>{observer.disconnect();window.removeEventListener("resize",layout);api?.layout({bounds:{x:0,y:0,width:0,height:0},obscured:true});};
  },[api,layout,state?.visible]);
  useEffect(()=>{if(state?.visible&&state.focusAddress){address.current?.focus();address.current?.select();}},[state?.focusAddress,state?.visible]);
  async function command(action:string,data?:{id?:string;url?:string}){
    if(!api)return;setError("");try{await api.command(action,data);}catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  if(!api||!state?.visible)return null;
  const value=edit&&edit.tab===active?.id?edit.value:active?.url==="about:blank"?"":active?.url??"";
  return <section ref={panel} className="browser-panel" aria-label="Built-in browser" style={width?{width}:undefined}>
    <div className="browser-resize" role="separator" aria-label="Resize browser" aria-orientation="vertical" tabIndex={0}
      onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();const current=panel.current?.getBoundingClientRect().width??400;setWidth(Math.max(320,current+(e.key==="ArrowLeft"?32:-32)));}}}
      onPointerDown={e=>{drag.current={x:e.clientX,width:panel.current?.getBoundingClientRect().width??400};e.currentTarget.setPointerCapture(e.pointerId);setResizing(true);}}
      onPointerMove={e=>{if(drag.current)setWidth(Math.max(320,drag.current.width+drag.current.x-e.clientX));}}
      onPointerUp={()=>{drag.current=null;setResizing(false);}} onPointerCancel={()=>{drag.current=null;setResizing(false);}}/>
    <div className="browser-tabs"><div role="tablist" aria-label="Browser tabs">{state.tabs.map((tab,index)=><div className={`browser-tab${tab.id===active?.id?" active":""}`} key={tab.id}>
      <button type="button" role="tab" id={`browser-tab-${tab.id}`} aria-selected={tab.id===active?.id} aria-controls="browser-viewport" tabIndex={tab.id===active?.id?0:-1} title={tab.title} onClick={()=>void command("select",{id:tab.id})} onKeyDown={e=>{
        if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();const target=state.tabs[(index+(e.key==="ArrowLeft"?state.tabs.length-1:1))%state.tabs.length];void command("select",{id:target.id});document.getElementById(`browser-tab-${target.id}`)?.focus();}
        if(e.key==="Delete"){e.preventDefault();void command("close",{id:tab.id});}
      }}><Globe size={13}/><span>{tab.title}</span></button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Close tab: ${tab.title}`} onClick={()=>void command("close",{id:tab.id})}><X size={12}/></Button>
    </div>)}</div><Button type="button" variant="ghost" size="icon-sm" aria-label="New browser tab" title="New tab · Ctrl+T" onClick={()=>void command("new")}><Plus size={15}/></Button><Button type="button" variant="ghost" size="icon-sm" aria-label="Close browser" onClick={()=>void command("hide")}><X size={15}/></Button></div>
    <form className="browser-toolbar" aria-label="Browser navigation" onSubmit={event=>{event.preventDefault();const submitted=value;void api.command("navigate",{url:submitted}).then(()=>{setEdit(current=>current?.value===submitted?null:current);setError("");}).catch(e=>setError(e.message));}}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Browser back" disabled={!active?.canGoBack} onClick={()=>void command("back")}><ArrowLeft size={15}/></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Browser forward" disabled={!active?.canGoForward} onClick={()=>void command("forward")}><ArrowRight size={15}/></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={active?.loading?"Stop loading page":"Reload page"} onClick={()=>void command(active?.loading?"stop":"reload")}>{active?.loading?<Square size={13}/>:<RefreshCw size={14}/>}</Button>
      <Input ref={address} aria-label="Browser address" placeholder="Enter a web address" value={value} onChange={e=>active&&setEdit({tab:active.id,value:e.target.value})} onKeyDown={e=>{if(e.key==="Escape"){setEdit(null);address.current?.blur();}}} spellCheck={false} autoComplete="off"/>
      <Button type="submit" variant="ghost" size="sm" disabled={!value.trim()}>Go</Button>
    </form>
    {(error||active?.error)&&<div role="alert" className="browser-error">{error||active?.error}</div>}
    {active?.url==="about:blank"&&<p className="browser-empty">Open a website beside your conversation.<span>Ctrl+L focuses the address · Ctrl+T opens a tab</span></p>}
    <div ref={viewport} className="browser-viewport" id="browser-viewport" role="tabpanel" aria-labelledby={active?`browser-tab-${active.id}`:undefined}/>
  </section>;
}

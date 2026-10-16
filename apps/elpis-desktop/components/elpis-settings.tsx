"use client";

import { useEffect, useRef, useState } from "react";
import { api, modelLabel, providerLabel, subscriptionOf, type Model } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";

type Background = { model: string | null; provider: string | null };
type Memory = { generate: boolean | null; use: boolean | null; extractionModel: string | null; consolidationModel: string | null };
type Settings = {
  version?: string | null;
  main: Background;
  background: Background;
  providers?: { id: string; displayName: string }[];
  smartPrune: { enabled: boolean | null; explicitOverride: { available?: boolean; model?: string | null; provider?: string | null; version?: string; reason?: string } };
  memory: Memory;
  write: { available?: boolean; reason: string };
};
type Usage = { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; totalTokens?: number };
type Context = {
  threadId: string;
  reason?: string;
  tokenUsage: { total: Usage | null; last: Usage | null; modelContextWindow: number | null; contextAttribution?: Record<string, number> | null } | null;
  smartPrune: { approxSavedTokens?: number; optimizerRequests?: number; optimizerUsageReports?: number; optimizerLatencyMs?: number; optimizerUsage?: Usage | null;
    latestAttempt?: { latencyMs?: number; status: string | null; modelSlug: string | null; failureReason: string | null } | null } | null;
};
const setting = (value: string | boolean | null | undefined) => typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : value || "Not reported";
const count = (value: number | null | undefined) => typeof value === "number" ? value.toLocaleString() : "Not reported";
const categories = { systemInstructions: "System instructions", developerMessages: "Developer instructions", userMessages: "User messages", agentMessages: "Agent replies", reasoning: "Reasoning", toolCalls: "Tool calls", toolResults: "Tool results", toolDefinitions: "Tool definitions", outputSchema: "Output schema", unrecognizedItems: "Other items" };

export function ElpisSettings({ threadId, active = true }: { threadId?: string; active?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [contextState, setContextState] = useState<{ threadId: string; data: Context | null; error: string }>({ threadId: "", data: null, error: "" });
  const [error, setError] = useState("");
  const context = contextState.threadId === threadId ? contextState.data : null;
  const contextError = contextState.threadId === threadId ? contextState.error : "";
  const latestInput = context?.tokenUsage?.last?.inputTokens;
  const contextWindow = context?.tokenUsage?.modelContextWindow;
  const attribution = context?.tokenUsage?.contextAttribution;
  const inputShare = typeof latestInput === "number" && typeof contextWindow === "number" && contextWindow > 0 ? latestInput / contextWindow * 100 : null;
  const pruning = context?.smartPrune;
  const usageReports = pruning?.optimizerUsageReports;
  const requests = pruning?.optimizerRequests;
  const hasReportedUsage = typeof usageReports === "number" && usageReports > 0;
  const partialUsage = hasReportedUsage && typeof requests === "number" && usageReports < requests;
  const pruningTokens = hasReportedUsage && typeof pruning?.optimizerUsage?.totalTokens === "number"
    ? `${count(pruning.optimizerUsage.totalTokens)}${partialUsage ? " (partial)" : ""}`
    : "Not reported";
  useEffect(() => {
    let disposed = false;
    api<Settings>("/settings").then(value => { if (!disposed) setSettings(value); }).catch(error => { if (!disposed) setError(error.message); });
    api<{data:Model[]}>("/models").then(value => { if (!Array.isArray(value?.data)) throw new Error("Model catalog response did not contain models."); if (!disposed) setModels(value.data); }).catch(error => { if (!disposed) setCatalogError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    let disposed = false;
    if (!threadId || !active) return;
    const selectedId = threadId;
    let timer: ReturnType<typeof setTimeout>;
    setContextState({ threadId: selectedId, data: null, error: "" });
    async function refresh() {
      try {
        const value = await api<Context>(`/threads/${encodeURIComponent(selectedId)}/context`);
        if (value.threadId !== selectedId) throw new Error("Context response belongs to another conversation.");
        if (!disposed) setContextState({ threadId: selectedId, data: value, error: "" });
      } catch (error) {
        if (!disposed) setContextState({ threadId: selectedId, data: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!disposed) timer = setTimeout(poll, 5000);
      }
    }
    function poll() {
      if (document.visibilityState === "visible") void refresh();
      else timer = setTimeout(poll, 5000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [threadId, active]);
  return <section className="mx-auto w-full max-w-4xl space-y-6 p-5 md:p-8" aria-label="Elpis settings">
    <header><h1 className="text-xl font-semibold">Elpis settings</h1><p className="mt-1 text-sm text-muted-foreground">Models, memory and context management.</p></header>
    {error && <p role="alert">Could not load settings: {error}</p>}
    {!settings && !error && <p role="status">Loading settings…</p>}
    <section className="feature-section"><h2>Selected conversation · context</h2>
      {!threadId ? <p className="text-sm text-muted-foreground">Open a conversation to see its reported usage.</p> : <>
        {contextError && <p role="alert">Could not refresh context: {contextError}</p>}
        {!context && !contextError && <p role="status">Loading context…</p>}
        {context && <>
        <h3 className="mb-3 font-medium">Latest reported request</h3>
        <dl className="feature-values">
          <dt>Latest input tokens</dt><dd>{count(latestInput)}</dd>
          <dt>Context window</dt><dd>{count(contextWindow)}</dd>
          <dt>Input / context window</dt><dd>{inputShare === null ? "Not reported" : `${inputShare.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Latest provider input is a request snapshot. Cumulative usage below is not the amount currently occupying the context window.</p>
        <details className="mt-5" open={!!attribution}>
          <summary className="cursor-pointer font-medium">Estimated context composition</summary>
          {attribution ? <><dl className="feature-values mt-3">{Object.entries(categories).map(([key, label]) => <div className="contents" key={key}><dt>{label}</dt><dd>{count(attribution[key])}</dd></div>)}<dt>Estimated total</dt><dd>{count(attribution.estimatedTotal)}</dd></dl><p className="mt-3 text-xs text-muted-foreground">Estimates from Elpis's latest request. They can differ from provider counts. This does not list or change admitted files and memories.</p></> : <p className="mt-3 text-sm text-muted-foreground">Elpis has not reported context composition for this conversation.</p>}
        </details>
        <h3 className="mb-3 mt-6 font-medium">Cumulative usage and pruning</h3>
        <dl className="feature-values">
          <dt>Input tokens</dt><dd>{count(context.tokenUsage?.total?.inputTokens)}</dd>
          <dt>Cache-read input tokens</dt><dd>{count(context.tokenUsage?.total?.cachedInputTokens)}</dd>
          <dt>Cache-write input tokens</dt><dd>{count(context.tokenUsage?.total?.cacheWriteInputTokens)}</dd>
          <dt>Output tokens</dt><dd>{count(context.tokenUsage?.total?.outputTokens)}</dd>
          <dt>Estimated tokens pruned</dt><dd>{count(context.smartPrune?.approxSavedTokens)}</dd>
          <dt>Pruning model tokens</dt><dd>{pruningTokens}</dd>
          <dt>Cumulative pruning request time (ms)</dt><dd>{count(context.smartPrune?.optimizerLatencyMs)}</dd>
          <dt>Latest pruning attempt time (ms)</dt><dd>{count(context.smartPrune?.latestAttempt?.latencyMs)}</dd>
          <dt>Latest pruning model</dt><dd>{setting(context.smartPrune?.latestAttempt?.modelSlug)}</dd>
          <dt>Latest pruning status</dt><dd>{setting(context.smartPrune?.latestAttempt?.status)}</dd>
        </dl>
        {context.smartPrune?.latestAttempt?.failureReason && <p className="mt-4 text-sm" role="status">{context.smartPrune.latestAttempt.failureReason}</p>}
        {typeof usageReports === "number" && typeof requests === "number" && <p className="mt-4 text-xs text-muted-foreground">Usage reported for {count(usageReports)} of {count(requests)} pruning requests.</p>}
        <p className="mt-4 text-xs text-muted-foreground">Pruned tokens are estimates, not net token or cost savings. Pruning request time does not measure added user waiting time.</p>
        <p className="mt-4 text-xs text-muted-foreground">{context.reason || "Usage reflects events observed since this app connected."}</p></>}
      </>}
    </section>
    {settings && <>
      <section className="feature-section"><h2>Main model</h2><dl className="feature-values"><dt>Model</dt><dd>{settings.main.model ? modelLabel(settings.main.model, models) : "Not reported"}</dd><dt>Provider</dt><dd>{providerLabel(settings.main.model, settings.main.provider, settings.providers) || "Not reported"}</dd></dl></section>
      <>{catalogError && <p role="status">Model choices could not be loaded: {catalogError}</p>}<MaintenanceSettings value={settings} models={models} onSaved={setSettings}/></>
    </>}
  </section>;
}

function MaintenanceSettings({value,models,onSaved}:{value:Settings;models:Model[];onSaved:(next:Settings)=>void}) {
  const [background,setBackground]=useState<Partial<Background>>({});
  const [memory,setMemory]=useState<Partial<Memory>>({});
  const [pruner,setPruner]=useState<{mode:'background'|'explicit';model:string;provider:string}|null>(null);
  const [pending,setPending]=useState<'settings'|'pruner'|'reload'|null>(null);
  const [feedback,setFeedback]=useState({settings:'',pruner:''});
  const [errors,setErrors]=useState({settings:'',pruner:''});
  const active=useRef(true), inFlight=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const backgroundDraft={...value.background,...background};
  const memoryDraft={...value.memory,...memory};
  const mainModels=models.filter(model=>!subscriptionOf(model.model));
  const [catalogs,setCatalogs]=useState<Record<string,{version:string|null|undefined;models:Model[];loading?:boolean;error?:string}>>({});
  const catalogFor=(provider:string)=>catalogs[provider]?.version===value.version?catalogs[provider]:undefined;
  const forProvider=(provider:string|null)=>!provider||provider===value.main.provider?mainModels:catalogFor(provider)?.models??[];
  const connectionLabel=(provider:string|null)=>providerLabel(null,provider??value.main.provider,value.providers)||"the conversation provider";
  const catalogStatus=(provider:string|null)=>{const catalog=provider?catalogFor(provider):undefined;return catalog?.loading?"Loading model choices…":catalog?.error?"Model choices could not be loaded: "+catalog.error:undefined;};
  const override=value.smartPrune.explicitOverride;
  const currentPruner={mode:override.model?'explicit' as const:'background' as const,model:override.model??'',provider:override.provider??''};
  const pruneDraft=pruner??currentPruner;
  useEffect(()=>{
    const version=value.version;
    const selected=[backgroundDraft.provider,pruneDraft.mode==='explicit'?pruneDraft.provider:null];
    for(const provider of new Set(selected)) {
      if(!provider||provider===value.main.provider||catalogFor(provider)||!value.providers?.some(item=>item.id===provider))continue;
      setCatalogs(old=>({...old,[provider]:{version,models:[],loading:true}}));
      api<{data:Model[]}>("/models?provider="+encodeURIComponent(provider)).then(value=>{
        if(!Array.isArray(value?.data))throw new Error("Model catalog response did not contain models.");
        if(active.current)setCatalogs(old=>old[provider]?.version===version?{...old,[provider]:{version,models:value.data}}:old);
      }).catch(error=>{
        if(active.current)setCatalogs(old=>old[provider]?.version===version?{...old,[provider]:{version,models:[],error:error instanceof Error?error.message:String(error)}}:old);
      });
    }
  },[backgroundDraft.provider,pruneDraft.mode,pruneDraft.provider,value.main.provider,value.providers,value.version,catalogs]);
  const editable=value.write.available===true&&typeof value.version==='string';
  const pruneEditable=override.available===true&&typeof override.version==='string';
  const changed=Object.keys(background).length+Object.keys(memory).length>0;
  const pruneChanged=pruneDraft.mode!==currentPruner.mode||(pruneDraft.mode==='explicit'&&(pruneDraft.model.trim()!==currentPruner.model||pruneDraft.provider!==currentPruner.provider));
  const providers=value.providers??[];
  const updateBackground=(key:keyof Background,text:string)=>{const next=text.trim()||null;setBackground(old=>{const patch={...old};if(next===value.background[key])delete patch[key];else patch[key]=next;return patch;});setFeedback(old=>({...old,settings:''}));};
  const updateMemory=<K extends keyof Memory>(key:K,next:Memory[K])=>{setMemory(old=>{const patch={...old};if(next===value.memory[key])delete patch[key];else patch[key]=next;return patch;});setFeedback(old=>({...old,settings:''}));};
  const updatePruner=(patch:Partial<typeof pruneDraft>)=>{setPruner({...pruneDraft,...patch});setFeedback(old=>({...old,pruner:''}));};
  async function save(kind:'settings'|'pruner'|'reload') {
    if(inFlight.current)return;
    inFlight.current=true;setPending(kind);
    const section=kind==='pruner'?'pruner':'settings';
    setErrors(old=>({...old,[section]:''}));setFeedback(old=>({...old,[section]:''}));
    try {
      const body=kind==='settings'?{version:value.version,...(Object.keys(background).length?{background}:{}),...(Object.keys(memory).length?{memory}:{})}:kind==='pruner'?{version:override.version,model:pruneDraft.mode==='explicit'?pruneDraft.model.trim():null,provider:pruneDraft.mode==='explicit'?pruneDraft.provider:null}:undefined;
      const next=await api<Settings>(kind==='pruner'?'/pruner':'/settings',body);
      if(!active.current)return;
      onSaved(next);
      if(kind!=='pruner'){setBackground({});setMemory({});}
      if(kind!=='settings')setPruner(null);
      if(kind==='reload'){setErrors({settings:'',pruner:''});setFeedback({settings:'Settings reloaded. Unsaved edits were discarded.',pruner:''});}
      else setFeedback(old=>({...old,[section]:kind==='pruner'?'Pruning model saved. Applies to the next pruning attempt.':'Background and memory settings saved. Applies to new conversations.'}));
    }catch(error){if(active.current)setErrors(old=>({...old,[section]:String(error)}));}
    finally{inFlight.current=false;if(active.current)setPending(null);}
  }
  const providerOptions=(current:string)=><>{current&&!providers.some(item=>item.id===current)&&<option value={current}>{current}</option>}{providers.map(item=><option key={item.id} value={item.id}>{providerLabel(null,item.id,providers)}</option>)}</>;
  return <>
    <section className="feature-section"><h2>Background and memory</h2><p className="muted">Background is the fallback model for Smart Prune. These settings apply to new conversations.</p>
      {editable?<div className="feature-form grid gap-4 sm:grid-cols-2">
        <ModelSetting label="Background model" value={backgroundDraft.model} models={forProvider(backgroundDraft.provider)} provider={connectionLabel(backgroundDraft.provider)} catalogStatus={catalogStatus(backgroundDraft.provider)} disabled={pending!==null} inheritLabel="Default background model" onChange={model=>updateBackground("model",model??"")} />
        <label className="grid gap-2">Background provider<OptionSelect aria-label="Background provider" value={backgroundDraft.provider??""} onChange={event=>updateBackground('provider',event.target.value)} disabled={pending!==null}><option value="">Use default</option>{providerOptions(background.provider??value.background.provider??'')}</OptionSelect></label>
        {(['generate','use'] as const).map(key=><label className="grid gap-2" key={key}>{key==='generate'?'Generate memories':'Use memories'}<OptionSelect aria-label={key==='generate'?'Generate memories':'Use memories'} value={String(memory[key]!==undefined?memory[key]??'unknown':value.memory[key]??'unknown')} onChange={event=>updateMemory(key,event.target.value==='true')} disabled={pending!==null}><option value="unknown" disabled>Not reported</option><option value="true">Enabled</option><option value="false">Disabled</option></OptionSelect></label>)}
        <p className="sm:col-span-2 text-xs text-muted-foreground">Memory models use their conversation’s provider. Default provider: {connectionLabel(value.main.provider)}.</p>
        {(["extractionModel","consolidationModel"] as const).map(key=><ModelSetting key={key} label={key==="extractionModel"?"Memory extraction model":"Memory consolidation model"} value={memoryDraft[key]} models={mainModels} provider={connectionLabel(value.main.provider)} disabled={pending!==null} inheritLabel="Default conversation model" onChange={model=>updateMemory(key,model)}/>)}
        <div className="sm:col-span-2"><Button disabled={pending!==null||!changed} onClick={()=>void save('settings')}>{pending==='settings'?'Saving…':'Save background and memory'}</Button></div>
      </div>:<><dl className="feature-values"><dt>Background model</dt><dd>{setting(value.background.model)}</dd><dt>Background provider</dt><dd>{setting(value.background.provider)}</dd><dt>Generate memories</dt><dd>{setting(value.memory.generate)}</dd><dt>Use memories</dt><dd>{setting(value.memory.use)}</dd><dt>Extraction model</dt><dd>{setting(value.memory.extractionModel)}</dd><dt>Consolidation model</dt><dd>{setting(value.memory.consolidationModel)}</dd></dl><p>{value.write.reason}</p></>}
      {feedback.settings&&<p className="feedback" role="status">{feedback.settings}</p>}{errors.settings&&<p className="feedback" role="alert">{errors.settings}</p>}
    </section>
    <section className="feature-section"><h2>Smart Prune</h2><dl className="feature-values"><dt>Automatic pruning</dt><dd>{setting(value.smartPrune.enabled)}</dd></dl>
      {pruneEditable?<div className="feature-form grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 sm:col-span-2">Pruning model selection<OptionSelect aria-label="Pruning model selection" value={pruneDraft.mode} onChange={event=>updatePruner({mode:event.target.value as 'background'|'explicit'})} disabled={pending!==null}><option value="background">Use background model</option><option value="explicit">Choose model and provider</option></OptionSelect></label>
        {pruneDraft.mode==='explicit'&&<><label className="grid gap-2">Pruning provider<OptionSelect aria-label="Pruning provider" value={pruneDraft.provider} onChange={event=>updatePruner({provider:event.target.value})} disabled={pending!==null}><option value="" disabled>Select provider</option>{providerOptions(pruneDraft.provider)}</OptionSelect></label><ModelSetting label="Pruning model" value={pruneDraft.model||null} models={forProvider(pruneDraft.provider||null)} provider={connectionLabel(pruneDraft.provider||null)} catalogStatus={catalogStatus(pruneDraft.provider||null)} disabled={pending!==null} inheritLabel="Choose a pruning model" onChange={model=>updatePruner({model:model??""})} /></>}
        <p className="sm:col-span-2">Applies to the next pruning attempt. Choose a model supported by the selected provider.</p>
        <div className="sm:col-span-2"><Button disabled={pending!==null||!pruneChanged||(pruneDraft.mode==='explicit'&&(!pruneDraft.model.trim()||!pruneDraft.provider))} onClick={()=>void save('pruner')}>{pending==='pruner'?'Saving…':'Save pruning model'}</Button></div>
      </div>:<p>{override.reason??'Pruning model settings are unavailable.'}</p>}
      {feedback.pruner&&<p className="feedback" role="status">{feedback.pruner}</p>}{errors.pruner&&<p className="feedback" role="alert">{errors.pruner}</p>}
    </section>
    {(errors.settings||errors.pruner)&&<section className="feature-section"><p>Reload saved settings to resolve a conflict. Reloading discards unsaved edits.</p><Button variant="outline" disabled={pending!==null} onClick={()=>void save('reload')}>{pending==='reload'?'Reloading…':'Reload settings'}</Button></section>}
  </>;
}

function ModelSetting({label,value,models,provider,catalogStatus,disabled,inheritLabel,onChange}:{
  label:string;value:string|null;models:Model[];provider:string;catalogStatus?:string;disabled:boolean;
  inheritLabel:string;onChange:(value:string|null)=>void;
}) {
  if(models.length)return <label className="grid gap-2">{label}<OptionSelect aria-label={label} value={value??""} onChange={event=>onChange(event.target.value||null)} disabled={disabled}>
    <option value="">{inheritLabel}</option>
    {value&&!models.some(model=>model.model===value)&&<option value={value}>Current configured model</option>}
    {models.map(model=><option key={model.model} value={model.model}>{model.displayName||model.model}</option>)}
  </OptionSelect></label>;
  return <div className="grid gap-2"><span>{label}</span><p>{value?"Current configured model":inheritLabel}</p>
    {catalogStatus&&<p role="status">{catalogStatus}</p>}
    <details><summary>Advanced: custom model</summary><p>No model catalog is available for {provider}.</p>
      <label className="grid gap-2">{label}<Input aria-label={label} value={value??""} onChange={event=>onChange(event.target.value.trim()||null)} placeholder="Model name supplied by this connection" maxLength={200} disabled={disabled}/></label>
    </details>
  </div>;
}

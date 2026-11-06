import { BridgeError, object, text, threadId } from './validate.mjs';
import { MOTHER_MODEL, WORKFLOW_PRESETS, workflowPreset } from './workflow-presets.mjs';
import { agentOutput } from './agent-output.mjs';
import path from 'node:path';
import { workflowRoute } from "./workflow-models.mjs";

import { internal_current, internal_effort } from './client-rewind.mjs';
import { internal_decorate } from './client-thread-list.mjs';
import { internal_model, internal_providerModel } from './client-context.mjs';
import { internal_mutate } from './client-mutation.mjs';
import { internal_rpc } from './client-connection.mjs';

// Native refusals the person can act on (a fork still referencing a chat, a busy agent) are shown as Elpis wrote them.
/** @param {unknown} value */
const scriptRunId = (value) => { if (typeof value !== 'string' || !/^wf_[0-9a-f-]{36}$/.test(value)) throw new BridgeError('Invalid workflow run ID'); return value; };

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_workflowRecords(clientState) {
    const saved = await clientState.workflowRuns.list();
    const threads = (await this.listThreads({ limit: 100, includeAgentRuns: true })).data ?? [];
    const roots = new Set(threads.filter(thread => typeof thread.source?.subAgent?.other === 'string' && thread.source.subAgent.other.startsWith('work_graph:')).map(thread => thread.parentThreadId).filter(Boolean));
    const native = [];
    for (const rootThreadId of roots) {
      const listed = await internal_rpc.call(this, clientState, 'workGraph/list', { rootThreadId });
      native.push(...(listed.data ?? []).map(record => ({ ...record, rootThreadId })));
    }
    const byId = new Map([...native, ...saved].map(record => [record.id, record]));
    return [...byId.values()].sort((a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0));
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_workflowHistory(clientState) { return clientState.workflowHistory.list(await internal_workflowRecords.call(this, clientState)); }

/** Leaving History ends a run: its worktrees and branches are freed (Undo brings back only the record). */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_removeWorkflowHistory(clientState, id, body) {
    threadId(id); object(body, []);
    const result = await clientState.workflowHistory.remove(id, () => internal_workflowRecords.call(this, clientState));
    await clientState.workflowRuns.free(id); return result;
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_undoWorkflowHistory(clientState, body) { object(body, []); return clientState.workflowHistory.undo(); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_workflows(clientState, id) {
    threadId(id);
    const current=await internal_rpc.call(this, clientState, 'thread/read',{threadId:id,includeTurns:false});
    if(current.thread?.id!==id)throw new BridgeError('Elpis returned a different thread',502);
    internal_decorate.call(this, clientState, current.thread);
    const native = await internal_rpc.call(this, clientState, 'workGraph/list', {rootThreadId:id});
    return { data: [...(native.data ?? []), ...await clientState.workflowRuns.list(id)] };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_workflowRun(clientState, id) {
    threadId(id);
    const run = (await clientState.workflowRuns.list()).find(record => record.id === id);
    if (!run) throw new BridgeError('Workflow not found', 404);
    return { run };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_workflowAgentOutput(clientState, id, taskId) {
    threadId(id); text(taskId, 'workflow node', 100);
    const run = (await clientState.workflowRuns.list()).find(record => record.id === id);
    if (!run) throw new BridgeError('Workflow not found', 404);
    return agentOutput(run, taskId);
  }

// Workflows that run until they finish (SPEC WR7): the runtime's script runs, started from a chat or from here.
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_scriptRuns(clientState, threadIdValue) { if (threadIdValue !== undefined) threadId(threadIdValue); return internal_rpc.call(this, clientState, 'workflowRun/list', threadIdValue ? { threadId: threadIdValue } : {}); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_scriptRun(clientState, runId) { return internal_rpc.call(this, clientState, 'workflowRun/read', { runId: scriptRunId(runId) }); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_startScriptRun(clientState, body) {
    object(body, ['threadId', 'script', 'scriptPath', 'args', 'resumeFromRunId', 'budget']);
    threadId(body.threadId);
    if (body.script === undefined && body.scriptPath === undefined) throw new BridgeError('Give the workflow script or its saved path');
    if (body.script !== undefined) text(body.script, 'workflow script', 1_000_000);
    if (body.scriptPath !== undefined && !path.isAbsolute(text(body.scriptPath, 'script path', 4096))) throw new BridgeError('Give an absolute script path');
    if (body.resumeFromRunId !== undefined) scriptRunId(body.resumeFromRunId);
    return internal_rpc.call(this, clientState, 'workflowRun/start', body);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_stopScriptRun(clientState, runId) { return internal_rpc.call(this, clientState, 'workflowRun/stop', { runId: scriptRunId(runId) }); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_resumeScriptRun(clientState, runId) { return internal_rpc.call(this, clientState, 'workflowRun/resume', { runId: scriptRunId(runId) }); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_skipScriptAgent(clientState, runId, agentId) {
    if (typeof agentId !== 'string' || !/^a[0-9a-f]{16}$/.test(agentId)) throw new BridgeError('Invalid agent ID');
    return internal_rpc.call(this, clientState, 'workflowRun/skip', { runId: scriptRunId(runId), agentId });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_steerWorkflow(clientState, id, taskId, body) {
    threadId(id); text(taskId, 'workflow node', 100); object(body, ['id', 'text']);
    return clientState.workflowRuns.steer(id, taskId, body);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_resumeWorkflow(clientState, id, body) {
    threadId(id); object(body, ['model', 'provider']);
    if (body.provider !== undefined && body.model === undefined) throw new BridgeError('A recovery provider needs a model');
    if (body.model !== undefined) text(body.model, 'recovery model', 200);
    if (body.provider !== undefined) text(body.provider, 'recovery provider', 100);
    const record = (await clientState.workflowRuns.list()).find(record => record.id === id);
    if (!record) throw new BridgeError('Workflow not found', 404);
    return internal_mutate.call(this, clientState, record.rootThreadId, async () => {
      const root = await internal_current.call(this, clientState, record.rootThreadId);
      if (root.status?.type === 'active') throw new BridgeError('Wait for the current conversation turn before resuming this workflow', 409);
      if (body.model !== undefined) { await this.models(); await internal_providerModel.call(this, clientState, body.model, body.provider ?? root.modelProvider); }
      return clientState.workflowRuns.resume(id, root, body);
    });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_mergeWorkflow(clientState, id, body) {
    threadId(id); object(body, []); return clientState.workflowRuns.merge(id);
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} _clientState */
export function impl_workflowPresets(_clientState) { return { data: WORKFLOW_PRESETS }; }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_runWorkflowPreset(clientState, body) {
    object(body, ['preset', 'goal', 'cwd']);
    if (!path.isAbsolute(text(body.cwd, 'project folder', 4096))) throw new BridgeError('Choose a project folder');
    const preset = workflowPreset(body.preset, body.goal);
    await this.models();
    for (const model of new Set([MOTHER_MODEL, ...preset.tasks.map(task => task.model)])) internal_model.call(this, clientState, model);
    const created = await this.createThread({ cwd: body.cwd, model: MOTHER_MODEL, name: preset.name, agents: true, instructions: `You are the Mother agent, the workflow coordinator. Goal: ${body.goal}. Review the children’s candidate commits and merge only after passing checks.` });
    return clientState.workflowRuns.start({ ...preset, rootThreadId: created.thread.id }, created.thread);
  }

/** One stage's tasks, checked as the scheduler takes them. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
function internal_workflowTasks(clientState, tasks) {
    if(!Array.isArray(tasks)||tasks.length<1||tasks.length>256)throw new BridgeError('A workflow must contain 1–256 tasks');
    return tasks.map(task=>{
      object(task,['id','kind','title','instruction','dependsOn','environmentId','writeScopes','acceptanceCriteria','provider','model','reasoningEffort','serviceTier','unchecked','feedbackFrom','parts','output','flow']);
      if(!['explore','implement','verify','fix','join'].includes(task.kind))throw new BridgeError('Unknown task role');
      const next={id:text(task.id,'task ID',100),kind:task.kind,title:text(task.title,'task title',256),instruction:text(task.instruction,'task instructions')};
      for(const key of ['dependsOn','writeScopes','acceptanceCriteria']){
        if(!Array.isArray(task[key])||task[key].length>256)throw new BridgeError(`Invalid ${key}`);
        next[key]=task[key].map(value=>text(value,key,4096));
      }
      if(task.feedbackFrom!==undefined){
        if(!Array.isArray(task.feedbackFrom)||task.feedbackFrom.length>256)throw new BridgeError('Invalid feedback dependencies');
        next.feedbackFrom=task.feedbackFrom.map(value=>text(value,'feedback dependency',100));
      }
      // A join is done by Elpis, not an agent: its parts, in order, written into its output (28 Oct, Masih: "why is it taking
      // so excruciatingly long"). The engine keeps both inside the project.
      if(task.kind==='join'){
        if(!Array.isArray(task.parts)||task.parts.length<1||task.parts.length>256)throw new BridgeError('A join needs 1–256 parts');
        next.parts=task.parts.map(value=>text(value,'join part',4096)); next.output=text(task.output,'join output',4096);
        // `flow`: pages of one text: a part that ends mid-sentence runs on into the next instead of a new paragraph.
        if(task.flow!==undefined){ if(typeof task.flow!=='boolean')throw new BridgeError('Invalid join flow'); next.flow=task.flow; }
      }else if(task.parts!==undefined||task.output!==undefined||task.flow!==undefined)throw new BridgeError('Only a join has parts and an output');
      if(task.environmentId!==undefined)throw new BridgeError('ACP workflows currently run in the selected local project; environment IDs are not supported');
      if(task.provider!==undefined){
        next.provider=text(task.provider,'task provider',100);
        if(!/^[A-Za-z0-9_.-]+$/.test(next.provider))throw new BridgeError('Invalid ACP provider');
        if(task.model===undefined)throw new BridgeError('A task provider requires an explicit model');
      }
      if(task.model!==undefined){
        next.model=text(task.model,'task model',200);
        if(!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(next.model))throw new BridgeError('Invalid ACP model ID');
      }
      if(task.reasoningEffort!==undefined)next.reasoningEffort=internal_effort.call(this, clientState, task.reasoningEffort);
      if(task.unchecked!==undefined){if(task.unchecked!==true||task.kind!=='implement')throw new BridgeError('Only a writer can go unchecked');next.unchecked=true;}
      if(task.serviceTier!==undefined){if(task.serviceTier!=='priority'&&task.serviceTier!=='fast')throw new BridgeError('Invalid task service tier');next.serviceTier=task.serviceTier;}
      return next;
    });
  }

/** A stage's limits: how many agents at once, how long, and whether writers work in worktrees. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} _clientState */
function internal_workflowLimits(_clientState, body, params) {
    for(const key of ['maxConcurrency','maxRuntimeSeconds','runLimitSeconds'])if(body[key]!==undefined){
      if(!Number.isSafeInteger(body[key])||body[key]<1||(key==='maxConcurrency'&&body[key]>32)||(key!=='maxConcurrency'&&body[key]>2147483))throw new BridgeError(`Invalid ${key}`);
      params[key]=body[key];
    }
    // 'worktree': each implement/fix task works in its own git worktree, merged after the run.
    if(body.isolation!==undefined){
      if(body.isolation!=='worktree')throw new BridgeError('Workflow isolation must be "worktree" or absent');
      params.isolation=body.isolation;
    }
    return params;
  }

/** `next`: the stage that runs after this one has succeeded (the Father's part), in its own chat (`thread`). The bridge
   * starts it and delivers its report here (#workflowEnded), so the run goes on with the Workflows screen closed. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_runWorkflow(clientState, body) {
    object(body, ['rootThreadId','name','goal','tasks','maxConcurrency','maxRuntimeSeconds','runLimitSeconds','isolation','roundLimit','next','replan','motherModel','runsOn']);
    const id=threadId(body.rootThreadId);
    const params=internal_workflowLimits.call(this, clientState, body,{rootThreadId:id,name:text(body.name,'workflow name',256),tasks:internal_workflowTasks.call(this, clientState, body.tasks)});
    if(body.roundLimit!==undefined)params.roundLimit=body.roundLimit;
    // "Mother re-plans" (1 Nov): she may change the team when a child succeeds. The board sends it, on by default.
    if(body.replan!==undefined){if(typeof body.replan!=='boolean')throw new BridgeError('Invalid replan switch');params.replan=body.replan;}
    // "Runs on" (1 Nov): this computer, or his CloudRoom VM for every agent's task (the Mother stays here).
    if(body.runsOn!==undefined){if(!['local','cloudroom'].includes(body.runsOn))throw new BridgeError('Choose where the agents run: this computer or the CloudRoom VM');if(body.runsOn==='cloudroom')params.runsOn='cloudroom';}
    // Her model, when he chose one for her on the board; otherwise the default (workflow-models.mjs MOTHER_ROUTE).
    if(body.motherModel!==undefined){
      object(body.motherModel,['model','provider']);
      const model=text(body.motherModel.model,'Mother model',200);
      if(!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model))throw new BridgeError('Invalid ACP model ID');
      params.motherModel=workflowRoute(model,body.motherModel.provider===undefined?'':text(body.motherModel.provider,'Mother provider',100));
    }
    // The run's goal reaches the Mother agent when she rescues a failed step or reviews the result (28 Oct: her prompts said "Goal: .").
    if(body.goal!==undefined&&String(body.goal).trim())params.goal=text(body.goal,'workflow goal',32000);
    if(body.next!==undefined){
      object(body.next,['name','tasks','thread','maxConcurrency','isolation']);
      object(body.next.thread,['name','instructions','model','provider']);
      const thread={name:text(body.next.thread.name,'chat name',120),instructions:text(body.next.thread.instructions,'chat instructions',32000),
        ...(body.next.thread.model!==undefined?{model:text(body.next.thread.model,'model',200)}:{}),...(body.next.thread.provider!==undefined?{provider:text(body.next.thread.provider,'provider',200)}:{})};
      params.next=internal_workflowLimits.call(this, clientState, body.next,{name:text(body.next.name,'workflow name',256),...(params.goal?{goal:params.goal}:{}),tasks:internal_workflowTasks.call(this, clientState, body.next.tasks),thread,status:'waiting'});
    }
    return internal_mutate.call(this, clientState, id,async()=>{
      const current=await internal_current.call(this, clientState, id);
      if(current.desktopAccess.mode==='continue')throw new BridgeError('Run workflows from a root conversation; this agent takes turns only from its parent',409);
      if(current.status?.type==='active')throw new BridgeError('Wait for the current turn to finish before running a workflow',409);
      return clientState.workflowRuns.start(params,current);
    });
  }

/** CloudRoom VM sign-in for Settings → Models & accounts. Answers never carry a token. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_cloudroom(clientState, input) {
    if(input===undefined)return clientState.cloudroom.status();
    object(input,['action']);
    if(input.action==='signIn')return {...await clientState.cloudroom.signIn(),...await clientState.cloudroom.status()};
    if(input.action==='status')return clientState.cloudroom.status({check:true});
    if(input.action==='signOut'){await clientState.cloudroom.signOut();return clientState.cloudroom.status();}
    throw new BridgeError('Unsupported CloudRoom action');
  }

/** A run has ended. A stage that succeeded starts its `next` in a new chat; one that failed or stopped never does. A
   * run started that way (`report`) sends its report to the chat it came from. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function internal_workflowEnded(clientState, record) {
    const from=record.report?.from??record.id;
    try{
      if(record.report){
        const lines=[`Report from the Father agent · ${record.rootThreadId}`,`Work graph: ${record.id}`,`Status: ${record.status}`,record.error,
          ...record.tasks.map(task=>`${task.title}: ${task.status}\n${JSON.stringify(task.result??{failure:task.failureReason??null})}`),
          "This is the Father agent's completed run report. Acknowledge it briefly without tools, edits, or another run."].filter(Boolean);
        // A refused delivery is tried again a few times; the reason stays on her record if it never goes through.
        for(let attempt=1;;attempt++){
          try{await this.send(record.report.to,{text:lines.join('\n\n')});break;}
          catch(error){
            if(attempt>=clientState.reportAttempts){await clientState.workflowRuns.note(from,{status:record.status,reported:false,error:`Father agent report not delivered: ${String(error?.message??error).slice(0,300)}`});return;}
            await new Promise(resolve=>setTimeout(resolve,clientState.reportRetryMs*attempt));
          }
        }
        await clientState.workflowRuns.note(from,{status:record.status,reported:true,error:null});
        return;
      }
      const next=record.next;
      if(!next||next.threadId||next.status!=='waiting')return;
      if(record.status!=='succeeded'){await clientState.workflowRuns.note(from,{status:'cancelled'});return;}
      const mother=await internal_current.call(this, clientState, record.rootThreadId);
      const created=await this.createThread({...(mother.cwd?{cwd:mother.cwd}:{}),agents:true,name:next.thread.name,instructions:next.thread.instructions,
        ...(next.thread.model?{model:next.thread.model}:{}),...(next.thread.provider?{provider:next.thread.provider}:{})});
      const {thread:_thread,status:_status,...stage}=next;
      const run=await clientState.workflowRuns.start({...stage,autoMerge:true,rootThreadId:created.thread.id,report:{to:record.rootThreadId,from:record.id}},created.thread);
      await clientState.workflowRuns.note(from,{threadId:created.thread.id,graphId:run.graphId,status:'running'});
    }catch(error){await clientState.workflowRuns.note(from,{status:'failed',error:String(error?.message??error).slice(0,500)}).catch(()=>{});}
  }

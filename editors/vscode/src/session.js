'use strict';
const {approvalMode}=require('./approval-modes');
const { connectAccount, refreshAccount } = require('./account-source');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { runtimeHome } = require('./runtime-query');
const path = require('node:path');
const { AppServer } = require('./rpc');
const { specs } = require('./editor');
const {errorText} = require('./error-text');

class Session extends EventEmitter {
  constructor(root, bridge, options) {
    super();
    this.root = root;
    this.bridge = bridge;
    this.options = options;
    this.busy = false;
    this.turnId = null;
    this.threadId = null;
    this.hasTurns = !!options.resumeThreadId;
    this.generation = 0;
    this.messageText = new Map();
    this.approvalItems = new Map();
    this.approvalEpoch = 0;
    this.queued=[];this.nextQueuedId=1;this.queuePaused=false;
  }
  get busy() { return this._busy; }
  set busy(value) { this._busy = value; this.emit('busy', value); }
  status(text) { this.emit('status', text); }
  async connect() {
    if (this.rpc && !this.rpc.closed && this.threadId) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.startConnection();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async startConnection() {
    const generation = this.generation;
    this.threadId=null;this.contextUsage=undefined;this.smartPrune=undefined;
    const home = runtimeHome(this.options);
    if (!this.options.transport) await fs.mkdir(home, { recursive: true });
    if (generation !== this.generation) throw new Error('Connection cancelled.');
    this.rpc = new AppServer(this.options.executable, this.root, this.options.transport || { env: { ...process.env, ...this.options.env, CODEX_HOME: home } });
    const rpc = this.rpc;
    rpc.on('disconnect', error => {
      this.contextUsage=undefined;this.smartPrune=undefined;
      this.busy = false; this.turnId = null; this.identity = null; this.bridge.cancel();
      if(this.queued.length){this.queuePaused=true;this.emitQueue();}
      this.status(error.message); this.emit('disconnected', error.message);
    });
    rpc.on('request', async message => {
      if (await refreshAccount(rpc, message, this.options)) return;
      this.handleRequest(message, rpc).catch(error => this.status(error.message));
    });
    const pendingLedger=[];
    rpc.on('notification', message => {
      const p = message.params || {};
      if(!this.threadId&&['thread/tokenUsage/updated','thread/smartPrune/updated'].includes(message.method)){
        pendingLedger.push(message);return;
      }
      if (p.threadId && p.threadId !== this.threadId) return;
      if(message.method==='thread/tokenUsage/updated'){
        this.contextUsage=p.tokenUsage;this.smartPrune=p.tokenUsage.smartPrune??this.smartPrune;
      }
      if(message.method==='thread/smartPrune/updated')this.smartPrune=p.smartPrune;
      this.emit('notification', message);
      if (p.item?.type === 'fileChange') this.approvalItems.set(p.item.id, p.item);
      if (message.method === 'item/agentMessage/delta') {
        this.messageText.set(p.itemId, (this.messageText.get(p.itemId) || '') + p.delta);
        this.emit('delta', p.delta);
      }
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
        const text = p.item.text || '';
        const streamed = this.messageText.get(p.item.id) || '';
        if (text.startsWith(streamed) && text.length > streamed.length) this.emit('delta', text.slice(streamed.length));
        this.messageText.set(p.item.id, text);
      }
      if (message.method === 'turn/started') {this.turnId = p.turn.id;this.hasTurns=true;}
      if (message.method === 'turn/completed') {
        this.busy = false; this.turnId = null;
        this.status(`Turn ${p.turn.status}${p.turn.error ? ': ' + errorText(p.turn.error.message) : ''}`);
        if(p.turn.status==='failed') this.emit('failure',errorText(p.turn.error?.message) || 'The runtime could not complete this request.');
        this.emit('completed', p.turn);
        if(p.turn.status!=='completed' && this.queued.length)this.queuePaused=true;
        this.emitQueue();
        const generation=this.generation;
        queueMicrotask(()=>{if(generation===this.generation)void this.drainQueue();});
      }
      if (message.method === 'item/started' && p.item.type === 'dynamicToolCall') this.status(`Using ${p.item.tool}`);
      if (message.method === 'error') this.status(p.error?.message || 'Elpis reported an error.');
    });
    try {
      const init = await rpc.request('initialize', { clientInfo: { name: 'elpis_editor', title: 'Elpis VS Code', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' });
      await connectAccount(rpc, this.options);
      const configuration = await rpc.request('config/read', {cwd:this.root,includeLayers:false});
      const customInstructions = configuration.config?.developer_instructions || '';
      const thread = await rpc.request(this.options.resumeThreadId ? 'thread/resume' : 'thread/start', {
        ...(this.options.resumeThreadId ? {threadId:this.options.resumeThreadId} : {dynamicTools:specs}),
        cwd: this.root,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.provider ? { modelProvider: this.options.provider } : {}),
        // The locally selected mode applies to both new and resumed threads.
        ...approvalMode(this.options.approvalMode).runtime,
        developerInstructions: [customInstructions, 'You are Elpis inside VS Code. Use editor_documents and editor_read for live unsaved text. Use editor_diagnostics, editor_definition, and editor_references for language intelligence. To edit editor buffers, read the current version, propose an edit with editor_propose_edit, then use editor_apply_edit. Never save editor buffers or bypass a rejection. After applying a fix, use editor_diagnostics again and report its actual result. Positions are zero-based. Editor access may be disabled; explain unavailable capabilities honestly.', approvalMode(this.options.approvalMode).description].filter(Boolean).join('\n\n'),
        ...(this.options.threadParams || {}),
      });
      this.threadId = thread.thread.id;
      for(const message of pendingLedger){
        if(message.params.threadId!==this.threadId)continue;
        if(message.method==='thread/tokenUsage/updated'){this.contextUsage=message.params.tokenUsage;this.smartPrune=message.params.tokenUsage.smartPrune??this.smartPrune;}
        else this.smartPrune=message.params.smartPrune;
        this.emit('notification',message);
      }
      this.model = thread.model;
      this.modelProvider = thread.modelProvider || this.options.provider || 'configured provider';
      this.updateIdentity();
      this.status(this.identity);
      return thread;
    } catch (error) { rpc.dispose(); throw error; }
  }
  async handleRequest(message, rpc) {
    const p = message.params || {};
    if (message.method === 'item/tool/call') {
      let result;
      try {
        if (p.threadId !== this.threadId || !this.busy) throw new Error('Tool call belongs to another or inactive conversation.');
        const epoch = this.bridge.epoch;
        const output = await this.bridge.execute(p.tool, p.arguments);
        if (epoch !== this.bridge.epoch || rpc.closed) throw new Error('Editor tool cancelled.');
        result = { contentItems: [{ type: 'inputText', text: JSON.stringify(output) }], success: true };
      } catch (error) { result = { contentItems: [{ type: 'inputText', text: error.message }], success: false }; }
      rpc.respond(message.id, result);
      this.emit('toolResult', { tool: p.tool, callId: p.callId, result });
    } else if (message.method.endsWith('/requestApproval')) {
      const supported = ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(message.method);
      const generation = this.generation;
      const approvalEpoch = this.approvalEpoch;
      const current = () => this.busy && !rpc.closed && this.generation === generation && this.approvalEpoch === approvalEpoch && p.threadId === this.threadId && p.turnId === this.turnId;
      let approved = false;
      if (supported && current() && this.options.approve) {
        try { approved = await this.options.approve({...message, item:this.approvalItems.get(p.itemId)}); }
        catch (error) { this.status(`Approval failed: ${error.message}`); }
      }
      approved = approved === true && current();
      rpc.respond(message.id, message.method === 'item/permissions/requestApproval'
        ? {permissions:approved ? p.permissions : {}, scope:'turn'}
        : {decision:approved ? 'accept' : 'decline'});
      this.status(approved ? 'Runtime action approved for this request.' : 'Runtime action declined.');
    } else if (message.method === 'item/tool/requestUserInput') {
      rpc.respond(message.id, { answers: {} });
      this.status('Elpis requested additional information. Reply in chat.');
    } else {
      rpc.send({ id: message.id, error: { code: -32601, message: `Unsupported editor request: ${message.method}` } });
      this.status(`Unsupported runtime capability: ${message.method}`);
    }
  }
  updateIdentity() {
    this.identity = `Elpis · ${this.modelProvider} · ${this.model} · ${path.basename(this.root)}`;
  }
  selectModel(model, effort) {
    if(this.busy) throw new Error('Finish or cancel the current turn before changing models.');
    this.options.model=model;this.model=model;this.options.reasoningEffort=effort;
    if(this.threadId) this.updateIdentity();
  }
  async send(text) {
    if (this.busy) throw new Error('A turn is already running. Cancel it or wait for completion.');
    this.messageText.clear();
    this.approvalItems.clear();
    this.busy = true;
    try {
      await this.connect();
      this.emit('user', text);
      this.status('Elpis is working…');
      const result = await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }], ...(this.options.model ? {model:this.options.model} : {}), ...(this.options.reasoningEffort ? {effort:this.options.reasoningEffort} : {}) });
      if (this.busy) this.turnId = result.turn.id;
      this.hasTurns=true;
    } catch (error) { this.busy = false; this.status(error.message); throw error; }
  }
  async cancel() {
    if(this.queued.length){this.queuePaused=true;this.emitQueue();}
    this.approvalEpoch++;
    this.bridge.cancel();
    if (!this.busy) { this.status('No active turn.'); return; }
    if (!this.turnId) { this.dispose(); return; }
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    if (this.busy) this.status('Cancellation requested…');
  }
  async prune() {
    return this.setSmartPruning(true);
  }
  ledger(){return require('./smart-pruning').ledgerSnapshot(this.contextUsage,this.smartPrune);}
  async goal(action,objective){
    if(!['get','set','clear'].includes(action))throw Error('Unknown goal action.');
    if(action!=='get'&&this.busy)throw Error('Finish or stop the response before changing the goal.');
    if(action==='set'&&(typeof objective!=='string'||!objective.trim()))throw Error('Enter a goal objective.');
    await this.connect();
    return this.rpc.request(`thread/goal/${action}`,{threadId:this.threadId,...(action==='set'?{objective:objective.trim()}:{} )});
  }
  async setSmartPruning(enabled) {
    if(this.busy)throw Error('Finish or stop the response before changing Smart Pruning.');
    await this.connect();
    if(typeof this.smartPrune?.enabled!=='boolean')throw Error('This runtime has not reported Smart Pruning support. Use the current Elpis app-server.');
    await require('./smart-pruning').setSmartPruning(this.rpc,this.root,enabled);
    this.status(`Smart Pruning ${enabled?'enabled':'disabled'} for subsequent turns.`);
  }
  async runCommand(command) {
    if(!['compact','review'].includes(command))throw Error('Unknown runtime command.');
    if(this.busy)throw Error('Finish or stop the response first.');
    if(command==='compact'&&!this.hasTurns)throw Error('Start a conversation before compacting.');
    this.busy=true;
    try {
      await this.connect();this.status(command==='review'?'Reviewing changes…':'Compacting conversation…');
      const result=command==='review'?await this.rpc.request('review/start',{threadId:this.threadId,target:{type:'uncommittedChanges'},delivery:'inline'}):await this.rpc.request('thread/compact/start',{threadId:this.threadId});
      if(this.busy&&result.turn)this.turnId=result.turn.id;
      this.hasTurns=true;
    }catch(error){this.busy=false;throw error;}
  }
  emitQueue() {this.emit('queue',{items:this.queued.map(item=>({...item})),paused:this.queuePaused});}
  enqueue(text) {
    if(typeof text!=='string' || !text.trim())throw new Error('Enter a follow-up message.');
    const item={id:this.nextQueuedId++,text};this.queued.push(item);this.emitQueue();void this.drainQueue();return item.id;
  }
  removeQueued(id) {
    this.queued=this.queued.filter(item=>item.id!==id);if(!this.queued.length)this.queuePaused=false;this.emitQueue();
  }
  async resumeQueue() {this.queuePaused=false;this.emitQueue();await this.drainQueue();}
  async drainQueue() {
    if(this.busy || this.queuePaused || !this.queued.length)return;
    const item=this.queued.shift();this.emitQueue();
    try{await this.send(item.text);}
    catch(error){this.queued.unshift(item);this.queuePaused=true;this.emitQueue();this.status(error.message);}
  }
  async steer(text) {
    if(!this.busy || !this.turnId || this.rpc?.closed)throw new Error('There is no active turn to steer yet.');
    if(typeof text!=='string' || !text.trim())throw new Error('Enter a follow-up message.');
    await this.rpc.request('turn/steer',{threadId:this.threadId,expectedTurnId:this.turnId,input:[{type:'text',text}]});
    this.emit('user',text);
  }
  dispose() { this.generation++; this.identity = null; this.bridge.cancel(); this.rpc?.dispose(); this.busy = false; this.threadId = null;this.contextUsage=undefined;this.smartPrune=undefined; }
}
module.exports = { Session };

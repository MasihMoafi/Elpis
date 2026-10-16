import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
function load(relative, react = React) {
  const cache = new Map();
  function compiled(filename) {
    const absolute = path.resolve(root, filename);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const source = readFileSync(absolute, 'utf8');
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText;
    const localRequire = id => {
      // Hooks of the rendered component and its shared save hook use the fixture's hook slots.
      if (id === 'react' && (absolute === path.resolve(root, relative) || absolute === path.resolve(root, 'components/settings/use-saver.ts'))) return react;
      if (!id.startsWith('@/') && !id.startsWith('.')) return require(id);
      const base = id.startsWith('@/') ? path.join(root, id.slice(2)) : path.resolve(path.dirname(absolute), id);
      for (const extension of ['', '.tsx', '.ts', '.js']) { try { readFileSync(base + extension); return compiled(base + extension); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; } }
      throw new Error(`Missing local module ${id}`);
    };
    new Function('require', 'exports', 'module', code)(localRequire, module.exports, module);
    return module.exports;
  }
  return compiled(relative);
}

const models = [{ id: 'sol', model: 'gpt-6-sol', displayName: 'Sol 6' }, { id: 'claude', model: 'claude/opus', displayName: 'Opus' }];
const providers = [{ id: 'openai', displayName: 'OpenAI' }, { id: 'lab', displayName: 'Lab server' }, { id: 'home', displayName: 'Home server' }];
const settings = {
  version: 'v1', main: { model: 'gpt-6-sol', provider: 'openai' }, providers,
  background: { model: 'gpt-6-sol', provider: 'openai' },
  memory: { generate: true, use: true, extractionModel: 'gpt-6-sol', consolidationModel: null },
  smartPrune: { enabled: true, explicitOverride: { available: true, version: 'p1', model: 'gpt-6-sol', provider: 'openai' } },
  write: { available: true },
};

test('new agent uses the catalog model picker and a readable inherited selection', () => {
  const { NewAgentForm } = load('components/new-agent-form.tsx');
  const html = renderToStaticMarkup(React.createElement(NewAgentForm, { models, settings, connected: true, onCreated() {} }));
  assert.match(html, /Sol 6/);
  assert.match(html, /OpenAI/);
  assert.doesNotMatch(html, /<input[^>]*placeholder="(?:Model ID|Leave empty to use the configured model)/);
  assert.match(html, /Choose folder/);
});

const MAINTENANCE='components/settings/maintenance.tsx';
const render=(name,props)=>renderToStaticMarkup(React.createElement(load(MAINTENANCE)[name],props));

test('catalog-backed maintenance models are selections instead of identifier fields', () => {
  const html = render('BackgroundSettings', { value: settings, models }) + render('MemorySettings', { value: settings, models });
  assert.equal((html.match(/<input[^>]*>/g)??[]).filter(tag=>!tag.includes('aria-hidden="true"')&&!tag.includes('type="hidden"')).some(tag=>tag.includes('value="gpt-6-sol"')),false);
  assert.match(html, /Sol 6/);
  assert.match(html, /Memory extraction model/);
  assert.match(html, /Default conversation model/);
});

test('an external provider without a catalog keeps an honest advanced model path', () => {
  const external = { ...settings, background: { model: 'gpt-oss', provider: 'home' }, smartPrune: { enabled: true, explicitOverride: { available: false, model: null, provider: null } } };
  const html = render('BackgroundSettings', { value: external, models });
  assert.match(html, /No model catalog is available for/);
  assert.match(html, /Home server/);
  assert.match(html, /value="gpt-oss"/);
  assert.match(html, /Advanced/);
  assert.match(render('PrunerSettings', { value: external, models }), /Pruning model settings are unavailable/);
});

function fixture(relative, exportName, props) {
  const slots=[], pending=[];
  let cursor=0;
  const hooks={...React,
    useState(initial) { const key=cursor++; if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial; return [slots[key],next=>{slots[key]=typeof next==='function'?next(slots[key]):next;}]; },
    useRef(initial) { const key=cursor++; if(!(key in slots))slots[key]={current:initial}; return slots[key]; },
    useEffect(effect,deps) { const key=cursor++,old=slots[key]; if(!old||!deps||deps.some((value,index)=>!Object.is(value,old.deps[index]))) { slots[key]={deps,cleanup:old?.cleanup}; pending.push(()=>{old?.cleanup?.();slots[key].cleanup=effect();}); } },
  };
  const Component=load(relative,hooks)[exportName];
  return {
    render(next=props) { cursor=0; return Component(next); },
    effects() { for(const effect of pending.splice(0))effect(); },
    dispose() { for(const slot of slots)slot?.cleanup?.(); },
  };
}
function elements(node) {
  if(!React.isValidElement(node))return Array.isArray(node)?node.flatMap(elements):[];
  if(typeof node.type==='function'&&node.type.name==='ModelChoice')return elements(node.type(node.props));
  return [node,...React.Children.toArray(node.props.children).flatMap(elements)];
}
function control(tree,label) {
  const result=elements(tree).find(element=>element.props['aria-label']===label);
  assert.ok(result, 'Missing control '+label);
  return result;
}
function button(tree,label) {
  const result=elements(tree).find(element=>element.props.children===label&&typeof element.props.onClick==='function');
  assert.ok(result, 'Missing button '+label);
  return result;
}
function values(control) { return elements(control.props.children).filter(element=>element.type==='option').map(element=>element.props.value); }

test('model options stay within their provider and retain unknown current values',()=>{
  const current={...settings,background:{model:'legacy-model',provider:'openai'}};
  assert.deepEqual(values(control(fixture(MAINTENANCE,'BackgroundSettings',{value:current,models}).render(),'Background model')),['','legacy-model','gpt-6-sol']);
  const memory=fixture(MAINTENANCE,'MemorySettings',{value:current,models}).render();
  assert.deepEqual(values(control(memory,'Memory extraction model')),['','gpt-6-sol']);
  assert.equal(control(memory,'Memory consolidation model').props.value,'');
  assert.equal(control(fixture(MAINTENANCE,'PrunerSettings',{value:current,models}).render(),'Pruning model').props.value,'gpt-6-sol');
});

test('inherited selections survive a failed save without changing provider or other settings',async()=>{
  const posts=[], original=globalThis.fetch;
  globalThis.fetch=async(path,init)=>{posts.push({path,body:JSON.parse(init.body)});return {ok:false,status:409,json:async()=>({error:'Settings changed elsewhere'})};};
  try {
    for (const [name,label,saveLabel] of [['BackgroundSettings','Background model','Save background model'],['MemorySettings','Memory extraction model','Save memory models']]) {
      const view=fixture(MAINTENANCE,name,{value:settings,models});
      let tree=view.render();
      control(tree,label).props.onChange({target:{value:''}});
      tree=view.render();
      assert.equal(control(tree,label).props.value,'');
      button(tree,saveLabel).props.onClick();
      await new Promise(setImmediate);
      tree=view.render();
      assert.equal(control(tree,label).props.value,'',`${label} keeps the unsaved choice`);
      assert.match(renderToStaticMarkup(tree),/Settings changed elsewhere/);
    }
    assert.deepEqual(posts,[{path:'/api/settings',body:{version:'v1',background:{model:null}}},{path:'/api/settings',body:{version:'v1',memory:{extractionModel:null}}}]);
  } finally { globalThis.fetch=original; }
});

test('switching a provider preserves its configured model and never borrows the main catalog',()=>{
  const view=fixture(MAINTENANCE,'BackgroundSettings',{value:settings,models});
  let tree=view.render();
  control(tree,'Background provider').props.onChange({target:{value:'home'}});
  tree=view.render();
  const model=control(tree,'Background model');
  assert.equal(model.props.value,'gpt-6-sol');
  assert.equal(model.props.placeholder,'Model name supplied by this connection');
  assert.deepEqual(values(model),[]);
  assert.match(renderToStaticMarkup(tree),/No model catalog is available for Home server/);
});

test('configured external provider fetches its own catalog once and keeps its current model',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async path=>{calls.push(path);return {ok:true,json:async()=>({data:[{id:'oss',model:'gpt-oss',displayName:'GPT OSS local'}],nextCursor:null})};};
  const value={...settings,background:{model:'gpt-oss',provider:'home'},smartPrune:{...settings.smartPrune,explicitOverride:{...settings.smartPrune.explicitOverride,model:'gpt-oss',provider:'home'}}};
  try {
    for (const [name,label] of [['BackgroundSettings','Background model'],['PrunerSettings','Pruning model']]) {
      calls.length=0;
      const view=fixture(MAINTENANCE,name,{value,models});
      view.render();view.effects();
      let tree=view.render();
      assert.equal(control(tree,label).props.value,'gpt-oss');
      await new Promise(setImmediate);
      tree=view.render();view.effects();
      assert.deepEqual(values(control(tree,label)),['','gpt-oss']);
      assert.match(renderToStaticMarkup(tree),/GPT OSS local/);
      assert.deepEqual(calls,['/api/models?provider=home']);
      view.dispose();
    }
    calls.length=0;
    const memory=fixture(MAINTENANCE,'MemorySettings',{value,models});
    const tree=memory.render();memory.effects();await new Promise(setImmediate);
    assert.deepEqual(values(control(tree,'Memory extraction model')),['','gpt-6-sol']);
    assert.deepEqual(calls,[],'memory models use the main catalog');
    memory.dispose();
  } finally {globalThis.fetch=original;}
});

test('failed external catalog keeps current model and does not retry on every render',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async path=>{calls.push(path);throw Error('Connection unavailable');};
  const value={...settings,background:{model:'private-model',provider:'lab'}};
  const view=fixture(MAINTENANCE,'BackgroundSettings',{value,models});
  try {
    view.render();view.effects();
    await new Promise(setImmediate);
    const tree=view.render();view.effects();
    assert.equal(control(tree,'Background model').props.value,'private-model');
    assert.match(renderToStaticMarkup(tree),/Connection unavailable/);
    assert.deepEqual(calls,['/api/models?provider=lab']);
  } finally {view.dispose();globalThis.fetch=original;}
});

test('inherited provider uses main catalog while unknown providers are never fetched',()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async path=>{calls.push(path);throw Error('unexpected');};
  const value={...settings,background:{model:null,provider:null},smartPrune:{...settings.smartPrune,explicitOverride:{...settings.smartPrune.explicitOverride,model:'old-model',provider:'removed-provider'}}};
  try {
    const background=fixture(MAINTENANCE,'BackgroundSettings',{value,models}), pruner=fixture(MAINTENANCE,'PrunerSettings',{value,models});
    assert.deepEqual(values(control(background.render(),'Background model')),['','gpt-6-sol']);background.effects();
    const tree=pruner.render();pruner.effects();
    assert.equal(control(tree,'Pruning model').props.value,'old-model');
    assert.deepEqual(values(control(tree,'Pruning model')),[]);
    assert.deepEqual(calls,[]);
    background.dispose();pruner.dispose();
  } finally {globalThis.fetch=original;}
});

test('malformed main model catalog gives a recoverable error instead of crashing settings',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({data:null})});
  const view=fixture(MAINTENANCE,'useModelCatalog',{});
  try {
    view.render();view.effects();
    await new Promise(setImmediate);
    const catalog=view.render();
    assert.deepEqual(catalog.models,[]);
    assert.equal(catalog.error,'Model catalog response did not contain models.');
    assert.match(render('CatalogNotice',{error:catalog.error}),/Model choices could not be loaded: Model catalog response did not contain models/);
  } finally {view.dispose();globalThis.fetch=original;}
});

test('malformed provider model catalog preserves existing provider/model as an advanced setting',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({data:null})});
  const value={...settings,background:{model:'private-model',provider:'lab'}};
  const view=fixture(MAINTENANCE,'BackgroundSettings',{value,models});
  try {
    view.render();view.effects();
    await new Promise(setImmediate);
    const tree=view.render();
    assert.equal(control(tree,'Background model').props.value,'private-model');
    assert.match(renderToStaticMarkup(tree),/Model catalog response did not contain models/);
  } finally {view.dispose();globalThis.fetch=original;}
});

test('changed configuration version refreshes provider models without discarding background, memory or pruning drafts',async()=>{
  const original=globalThis.fetch,calls=[];
  const value={...settings,background:{model:'original-background',provider:'home'},smartPrune:{...settings.smartPrune,explicitOverride:{...settings.smartPrune.explicitOverride,model:'original-pruner',provider:'home'}}};
  try {
    for (const [name,label] of [['BackgroundSettings','Background model'],['PrunerSettings','Pruning model']]) {
      calls.length=0;
      globalThis.fetch=async path=>{calls.push(path);return {ok:true,json:async()=>({data:calls.length===1?[{id:'selected-old',model:'selected-old',displayName:'Selected old model'},{id:'old-only',model:'old-only',displayName:'Old endpoint model'}]:[{id:'new-model',model:'new-model',displayName:'New endpoint model'}]})};};
      const props={value,models}, view=fixture(MAINTENANCE,name,props);
      view.render();view.effects();await new Promise(setImmediate);
      let tree=view.render();view.effects();
      assert.ok(values(control(tree,label)).includes('old-only'));
      control(tree,label).props.onChange({target:{value:'selected-old'}});
      view.render();view.effects();
      const next={...props,value:{...value,version:'v2'}};
      tree=view.render(next);
      assert.ok(!values(control(tree,label)).includes('old-only'));
      assert.equal(control(tree,label).props.value,'selected-old');
      view.effects();await new Promise(setImmediate);
      tree=view.render(next);view.effects();
      assert.deepEqual(calls,['/api/models?provider=home','/api/models?provider=home']);
      assert.deepEqual(values(control(tree,label)),['','selected-old','new-model']);
      view.dispose();
    }
    const memory=fixture(MAINTENANCE,'MemorySettings',{value,models});
    control(memory.render(),'Memory extraction model').props.onChange({target:{value:''}});
    assert.equal(control(memory.render({value:{...value,version:'v2'},models}),'Memory extraction model').props.value,'');
  } finally {globalThis.fetch=original;}
});

for(const staleResult of ['success','failure'])test(`late old-version catalog ${staleResult} cannot overwrite the refreshed model list`,async()=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}));
  const value={...settings,background:{model:'kept-model',provider:'home'}};
  const props={value,models};
  const view=fixture(MAINTENANCE,'BackgroundSettings',props);
  try {
    view.render();view.effects();
    const next={...props,value:{...value,version:'v2'}};
    view.render(next);view.effects();
    assert.equal(requests.length,2);
    requests[1].resolve({ok:true,json:async()=>({data:[{id:'new-model',model:'new-model',displayName:'New endpoint model'}]})});
    await new Promise(setImmediate);
    let tree=view.render(next);view.effects();
    assert.deepEqual(values(control(tree,'Background model')),['','kept-model','new-model']);
    if(staleResult==='success')requests[0].resolve({ok:true,json:async()=>({data:[{id:'old-model',model:'old-model',displayName:'Old endpoint model'}]})});
    else requests[0].reject(Error('Old endpoint failed'));
    await new Promise(setImmediate);
    tree=view.render(next);view.effects();
    assert.deepEqual(values(control(tree,'Background model')),['','kept-model','new-model']);
    assert.doesNotMatch(renderToStaticMarkup(tree),/Old endpoint (model|failed)/);
    assert.equal(requests.length,2);
  } finally {view.dispose();globalThis.fetch=original;}
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {admissionStateAt, DEMO_TOKENS} from '../assets/demo-state.mjs';

const script = (await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .+;\n/gm,'');

for (const reduce of [true,false]) {
  test(`scroll advances and reverses the walkthrough with reduced motion ${reduce}`, () => {
    const nodes = new Map();
    const element = name => {
      if (!nodes.has(name)) nodes.set(name,{
        textContent:name === '[data-ace-logo]' ? 'ELPIS' : '',
        className:'', innerHTML:'', scrollTop:0,
        style:{setProperty() {}},
        setAttribute() {}, removeAttribute() {},
        classList:{add() {}},
        getBoundingClientRect:() => ({top:100}),
      });
      return nodes.get(name);
    };
    let top = 65;
    const stage = {offsetHeight:779};
    const demo = {
      offsetHeight:4220,
      getBoundingClientRect:() => ({top}),
      querySelector:selector => selector === '.ace-demo-stage' ? stage : element(selector),
    };
    const terminal = element('terminal');
    const events = new Map();
    const frames = [];
    const document = {
      documentElement:{dataset:{theme:'elpis'},style:{setProperty() {}}},
      body:{append() {}},
      querySelector:selector => selector === 'header.navbar' ? {offsetHeight:65}
        : selector === '[data-ace-demo]' ? demo
        : selector === '[data-ace-terminal]' ? terminal : null,
      querySelectorAll:() => [],
      createElement:() => element('help'),
      addEventListener() {},
    };
    vm.runInNewContext(script,{
      document, window:{matchMedia:() => ({matches:reduce})},
      MutationObserver:class {observe() {}},
      addEventListener:(name,callback) => events.set(name,[...(events.get(name) || []),callback]),
      requestAnimationFrame:callback => {frames.push(callback);return frames.length;},
      CATEGORIES:[], CONTEXT_EXAMPLE:{}, updateLedger() {}, demoSnapshot:value => value,
      admissionStateAt, DEMO_TOKENS,
    });
    assert.equal(terminal.className,'ace-terminal phase-shell');
    assert.ok(events.get('scroll')?.length,'scrolling must remain connected in both motion modes');
    for (const [progress,phase] of [[.2,'boot'],[.34,'ready'],[.48,'working'],[.62,'tools'],[.78,'ace'],[.96,'done'],[.2,'boot']]) {
      top = 65 - (demo.offsetHeight-stage.offsetHeight)*progress;
      for (const callback of events.get('scroll')) callback();
      while (frames.length) frames.shift()();
      assert.equal(terminal.className,`ace-terminal phase-${phase}`);
      assert.equal(Boolean(element('[data-prune-flash]').textContent),phase === 'done');
    }
    assert.equal(element('.ace-chat').scrollTop,0,'rewinding clears the completed-result scroll');
  });
}

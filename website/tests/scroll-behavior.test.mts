import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {admissionStateAt, DEMO_TOKENS} from '../assets/demo-state.mjs';

const script = (await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .+;\n/gm,'');

for (const reduce of [true,false]) {
  test(`scroll advances and reverses the walkthrough with reduced motion ${reduce}`, () => {
    const nodes = new Map<string, { textContent: string; className: string; innerHTML: string; scrollTop: number; style: { setProperty(): void }; setAttribute(): void; removeAttribute(): void; classList: { add(): void }; getBoundingClientRect(): { top: number } }>();
    const element = (name: string) => {
      if (!nodes.has(name)) nodes.set(name,{
        textContent:name === '[data-ace-logo]' ? 'ELPIS' : '',
        className:'', innerHTML:'', scrollTop:0,
        style:{setProperty() {}},
        setAttribute() {}, removeAttribute() {},
        classList:{add() {}},
        getBoundingClientRect:() => ({top:100}),
      });
      const node = nodes.get(name);
      assert.ok(node);
      return node;
    };
    let top = 65;
    const stage = {offsetHeight:779};
    const demo = {
      offsetHeight:4220,
      getBoundingClientRect:() => ({top}),
      querySelector:(selector: string) => selector === '.ace-demo-stage' ? stage : element(selector),
    };
    const terminal = element('terminal');
    const events = new Map<string, (() => void)[]>();
    const frames: (() => void)[] = [];
    const document = {
      documentElement:{dataset:{theme:'elpis'},style:{setProperty() {}}},
      body:{append() {}},
      querySelector:(selector: string) => selector === 'header.navbar' ? {offsetHeight:65}
        : selector === '[data-ace-demo]' ? demo
        : selector === '[data-ace-terminal]' ? terminal : null,
      querySelectorAll:() => [],
      createElement:() => element('help'),
      addEventListener() {},
    };
    vm.runInNewContext(script,{
      document, window:{matchMedia:() => ({matches:reduce})},
      MutationObserver:class {observe() {}},
      addEventListener:(name: string,callback: () => void) => events.set(name,[...(events.get(name) || []),callback]),
      requestAnimationFrame:(callback: () => void) => {frames.push(callback);return frames.length;},
      CATEGORIES:[], CONTEXT_EXAMPLE:{}, updateLedger() {}, demoSnapshot:(value: unknown) => value,
      admissionStateAt, DEMO_TOKENS,
    });
    assert.equal(terminal.className,'ace-terminal phase-shell');
    const scrollHandlers = events.get('scroll');
    assert.ok(scrollHandlers?.length,'scrolling must remain connected in both motion modes');
    for (const [progress,phase] of [[.2,'boot'],[.34,'ready'],[.48,'working'],[.62,'tools'],[.78,'ace'],[.96,'done'],[.2,'boot']] as const) {
      top = 65 - (demo.offsetHeight-stage.offsetHeight)*progress;
      for (const callback of scrollHandlers) callback();
      while (frames.length) { const callback = frames.shift(); assert.ok(callback); callback(); }
      assert.equal(terminal.className,`ace-terminal phase-${phase}`);
      assert.equal(Boolean(element('[data-prune-flash]').textContent),phase === 'done');
    }
    assert.equal(element('.ace-chat').scrollTop,0,'rewinding clears the completed-result scroll');
  });
}

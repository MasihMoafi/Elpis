'use strict';
// VS Code's custom-scheme webview target is not exposed as a Playwright Frame
// in the tested Electron version. Attach to that real target over CDP instead.
class WebviewDOM {
  static async connect(port, selector='#prompt') {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    for (const target of targets.filter(t => t.type === 'iframe' && t.url.includes('extensionId=elpis-local.elpis-editor'))) {
    const dom = new WebviewDOM();
    dom.rootSelector=selector;
    dom.pending = new Map(); dom.contexts = new Set(); dom.nextId = 1;
    dom.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { dom.socket.onopen = resolve; dom.socket.onerror = reject; });
    dom.socket.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.method === 'Runtime.executionContextCreated') dom.contexts.add(m.params.context.id);
      if (m.method === 'Runtime.executionContextDestroyed') dom.contexts.delete(m.params.executionContextId);
      if (m.id && dom.pending.has(m.id)) {
        const { resolve, reject, timer } = dom.pending.get(m.id); dom.pending.delete(m.id); clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    await dom.send('Runtime.enable', {});
    if(await dom.evaluate(`!!d.querySelector(${JSON.stringify(selector)})`)) return dom;
    dom.close();
    }
    return null;
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Webview CDP timeout')); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    for (const contextId of this.contexts) {
      const result = await this.send('Runtime.evaluate', { contextId, returnByValue: true, expression: `(()=>{function find(d){if(d.querySelector(${JSON.stringify(this.rootSelector || '#prompt')}))return d;for(const f of d.querySelectorAll('iframe')){try{const found=f.contentDocument&&find(f.contentDocument);if(found)return found;}catch{}}}const d=find(document);if(!d)return null;return (${expression});})()` });
      if (!result.exceptionDetails && result.result.value !== null && result.result.value !== undefined) return result.result.value;
    }
    return null;
  }
  locator(selector) {
    const select = `d.querySelector(${JSON.stringify(selector)})`;
    return {
      count: () => this.evaluate(`${select}?1:0`),
      textContent: () => this.evaluate(`${select}?.textContent || ''`),
      fill: text => this.evaluate(`(()=>{const e=${select};e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`),
      click: async () => {
        if (!await this.evaluate(`!!${select}?.getClientRects().length`)) throw new Error(`Cannot click hidden or missing control: ${selector}`);
        return this.evaluate(`(()=>{${select}.click();return true;})()`);
      },
    };
  }
  async pointerClick(selector) {
    const point = await this.evaluate(`(()=>{const e=d.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await this.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1});
    await this.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1});
  }
  close() { this.socket.close(); }
}
module.exports = { WebviewDOM };

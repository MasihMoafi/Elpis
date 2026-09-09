'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

class AppServer extends EventEmitter {
  constructor(executable, cwd, options = {}) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = spawn(executable, options.args || [], {
      cwd, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('Invalid JSON from Elpis app-server')); }
      if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
      else {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    });
    // Runtime stderr can contain private paths or tool data. Do not echo it into chat.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Elpis disconnected (${signal || code}). Reconnect to start a new conversation.`)));
  }
  send(message) {
    if (this.closed) throw new Error('Elpis is disconnected. Reconnect to continue.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('Elpis is disconnected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Elpis ${method} timed out. Reconnect if the runtime is unresponsive.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }
  respond(id, result) { if (!this.closed) this.send({ id, result }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
    this.lines.close();
    this.child.kill();
  }
  dispose() { this.fail(new Error('Elpis connection closed.')); }
}
module.exports = { AppServer };

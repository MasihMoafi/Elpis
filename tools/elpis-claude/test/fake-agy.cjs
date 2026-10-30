#!/usr/bin/env node
// Local Antigravity CLI for desktop/bridge integration tests. No provider calls.
const fs = require('node:fs');
if (process.argv[2] === 'models') { console.log('gemini-3.8-flash-medium\tGemini Flash\ngemini-3.8-pro\tGemini Pro'); process.exit(); }
if (process.argv.includes('/usage')) { console.log('{}'); process.exit(); }
if (process.env.FAKE_AGY_DELAY_TERM) process.on('SIGTERM', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_AGY_DELAY_TERM)));
console.log(JSON.stringify({ event: 'init', conversation_id: `fake-${process.pid}` }));
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    const event = JSON.parse(line), text = event.message.content;
    fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ text }) + '\n');
    const reply = () => {
      if (text.includes('[fail]')) { console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'fixture provider failure' } })); return; }
      console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'answered: ' + text } }));
      console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
    };
    if (!text.includes('[wait]')) reply();
    else { const timer = setInterval(() => { if (fs.existsSync(process.env.FAKE_AGY_RELEASE)) { clearInterval(timer); reply(); } }, 10); }
  }
});

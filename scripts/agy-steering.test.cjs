'use strict';
// Real ACP adapter, isolated home, fake agy process. No account or provider requests.
// This fixture proves queue retention and serial follow-up delivery, not native agy steering.
// Usage: node scripts/agy-steering.test.cjs [absolute/agy-acp.mjs]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--fake-agy')) {
  if (process.argv.includes('models')) {
    console.log('gemini-3.8-flash-medium\tGemini fixture');
  } else {
    const send = event => process.stdout.write(JSON.stringify(event) + '\n');
    send({ event: 'init', conversation_id: 'fixture' });
    readline.createInterface({ input: process.stdin }).on('line', async line => {
      const input = JSON.parse(line);
      const text = input.message.content;
      fs.appendFileSync(process.env.AGY_FIXTURE_LOG, JSON.stringify({ text }) + '\n');
      const deliveredCase = process.env.AGY_FIXTURE_KIND.startsWith('delivered');
      const firstSteer = text === 'retained one' && deliveredCase && !fs.existsSync(`${process.env.AGY_FIXTURE_LOG}.sent`);
      if (firstSteer) {
        fs.writeFileSync(`${process.env.AGY_FIXTURE_LOG}.sent`, 'sent');
        send({ event: 'step_update', step_update: {
          step_type: 'tool', step_index: 2, state: 'RUNNING',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'fixture follow-up tool' } },
        } });
        while (!fs.existsSync(`${process.env.AGY_FIXTURE_RELEASE}.followup`)) await pause(10);
        if (process.env.AGY_FIXTURE_KIND === 'deliveredExit') process.exit(19);
      }
      if (text.startsWith('initial:')) {
        send({ event: 'step_update', step_update: {
          step_type: 'tool', step_index: 1, state: 'RUNNING',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'fixture tool' } },
        } });
        while (!fs.existsSync(process.env.AGY_FIXTURE_RELEASE)) await pause(10);
        if (text === 'initial:exit') process.exit(17);
        send({ event: 'step_update', step_update: {
          step_type: 'tool', step_index: 1, state: 'DONE',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'fixture tool' }, output: 'completed' },
        } });
      }
      send({ event: 'result', result: {
        status: text === 'initial:failure' || firstSteer && process.env.AGY_FIXTURE_KIND === 'deliveredFailure' ? 'FAILURE' : 'SUCCESS',
        ...(text === 'initial:failure' || firstSteer && process.env.AGY_FIXTURE_KIND === 'deliveredFailure' ? { error: 'fixture failure' } : {}),
        usage: { input_tokens: 10, output_tokens: 5 },
      } });
    });
  }
} else {
  const adapter = process.argv[2] || path.resolve(__dirname, '../tools/elpis-claude/agy-acp.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-agy-steering-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const fake = path.join(root, 'agy');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nprocess.argv.push('--fake-agy'); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  const checks = [], evidence = [];
  const readLog = file => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text) : [];

  async function scenario(kind) {
    const log = path.join(root, `${kind}.jsonl`), release = path.join(root, `${kind}.release`);
    const child = spawn(process.execPath, [adapter], { cwd, env: {
      PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, AGY_BIN: fake,
      AGY_FIXTURE_LOG: log, AGY_FIXTURE_RELEASE: release, AGY_FIXTURE_KIND: kind,
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(), messages = [];
    let sequence = 0, stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      const pending = waiting.get(message.id);
      if (pending) { waiting.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(Error(`${method} timed out`)); }, 5000);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const eventually = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) { assert(Date.now() < deadline, `${kind}: fixture tool did not start`); await pause(10); }
    };
    const prompt = text => [{ type: 'text', text }];
    try {
      assert((await rpc('initialize', {})).result);
      assert((await rpc('session/load', { sessionId: kind, cwd })).result);
      assert((await rpc('session/set_mode', { sessionId: kind, modeId: 'bypassPermissions' })).result);
      const running = rpc('session/prompt', { sessionId: kind, prompt: prompt(`initial:${kind}`) });
      await eventually(() => messages.some(message => message.params?.update?.sessionUpdate === 'tool_call'));
      for (const text of ['retained one', 'retained two']) {
        const steering = await rpc('_session/steering', { sessionId: kind, prompt: prompt(text) });
        assert.equal(steering.result?.outcome, 'queued');
      }
      assert.deepEqual(readLog(log), [`initial:${kind}`], 'queued messages must not restart an active tool');
      if (kind === 'cancel') await rpc('session/cancel', { sessionId: kind });
      else fs.writeFileSync(release, 'release');
      const deliveredCase = kind.startsWith('delivered');
      if (deliveredCase) {
        await eventually(() => readLog(log).includes('retained one'));
        if (kind === 'deliveredCancel') await rpc('session/cancel', { sessionId: kind });
        fs.writeFileSync(`${release}.followup`, 'release');
      }
      const ended = await running;
      if (kind === 'success') {
        assert.equal(ended.result?.stopReason, 'end_turn');
        assert.deepEqual(readLog(log), ['initial:success', 'retained one', 'retained two']);
        assert.equal(ended.result.usage.totalTokens, 45);
      } else {
        if (kind === 'cancel' || kind === 'deliveredCancel') assert.equal(ended.result?.stopReason, 'cancelled');
        else assert(ended.error, 'failed provider turn must still report failure');
        const recovered = await rpc('session/prompt', { sessionId: kind, prompt: prompt('new prompt') });
        assert.equal(recovered.result?.stopReason, 'end_turn');
        assert.deepEqual(readLog(log), [`initial:${kind}`, 'retained one', 'retained two', 'new prompt'],
          'acknowledged messages must survive failure and arrive before newer input');
      }
      const idle = await rpc('_session/steering', { sessionId: kind, prompt: prompt('idle rejected') });
      assert.equal(idle.result?.outcome, 'promptRequired');
      assert(!readLog(log).includes('idle rejected'), 'an unacknowledged idle steer must not run');
      checks.push(`${kind}: unsent messages retained; sent messages not replayed`);
      console.log(`PASS ${checks.at(-1)}`);
    } finally {
      evidence.push({ kind, messages, inputs: readLog(log), stderr });
      child.stdin.end();
      child.kill();
      for (const pending of waiting.values()) clearTimeout(pending.timer);
    }
  }

  (async () => { for (const kind of ['success', 'failure', 'exit', 'cancel', 'deliveredFailure', 'deliveredExit', 'deliveredCancel']) await scenario(kind); })()
    .catch(error => { console.error(error.stack); process.exitCode = 1; })
    .finally(() => {
      fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, evidence }, null, 2));
      console.log(`Evidence: ${root}`);
    });
}

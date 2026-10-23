import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError, object, text, threadId } from './validate.mjs';

/** One line per call in logs/voice-calls.jsonl, sent by the window when a call ends: how long, whether it connected, how many events of each kind the call
 * sent, and how much sound came in and went out. No words, no names: it exists so that "it says Listening and never answers" can be read from the machine. */
const REPORT_KEYS = ['seconds', 'listened', 'events', 'inboundBytes', 'inboundPackets', 'inboundEnergy', 'micEnergy', 'error'];
export async function recordVoiceCall(home, body) {
  object(body, REPORT_KEYS);
  const number = (value, name) => { if (!Number.isFinite(value) || value < 0 || value > 1e12) throw new BridgeError(`Invalid ${name}`); return Math.round(value * 1000) / 1000; };
  if (typeof body.listened !== 'boolean') throw new BridgeError('Invalid listened');
  if (!body.events || typeof body.events !== 'object' || Array.isArray(body.events) || Object.keys(body.events).length > 40) throw new BridgeError('Invalid events');
  const events = Object.fromEntries(Object.entries(body.events).map(([kind, count]) => { if (!/^[A-Za-z0-9_.-]{1,60}$/.test(kind)) throw new BridgeError('Invalid event kind'); return [kind, number(count, 'event count')]; }));
  const line = JSON.stringify({ at: new Date().toISOString(), seconds: number(body.seconds, 'seconds'), listened: body.listened, events, inboundBytes: number(body.inboundBytes, 'inbound bytes'), inboundPackets: number(body.inboundPackets, 'inbound packets'),
    inboundEnergy: number(body.inboundEnergy, 'inbound energy'), micEnergy: number(body.micEnergy, 'microphone energy'), error: typeof body.error === 'string' ? body.error.slice(0, 200) : '' });
  const file = path.join(home, 'logs', 'voice-calls.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let lines = []; try { lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  await fs.writeFile(file, [...lines.slice(-199), line].join('\n') + '\n', { mode: 0o600 });
  return { ok: true };
}

// All desktop windows share the engine. A call keeps its owner until native cleanup finishes.
let owner;
export function createVoice(client) {
  let call;
  async function close() { if (call) await call.stop(); }
  async function start(input, response) {
    object(input, ['threadId', 'sdp']); threadId(input.threadId); text(input.sdp, 'voice offer', 64000);
    if (!input.sdp.startsWith('v=0\r\n') || !input.sdp.includes('\n')) throw new BridgeError('Invalid voice offer');
    if (owner) throw new BridgeError('Voice is already open. End that call first.', 409);
    const current = { stopped: false, started: null, stopping: null, stop: null };
    owner = call = current;
    const send = value => { if (!current.stopped && !response.destroyed) response.write(JSON.stringify(value) + '\n'); };
    let timeout, heartbeat;
    const stop = () => {
      if (current.stopping) return current.stopping;
      current.stopped = true; clearTimeout(timeout); clearInterval(heartbeat);
      client.off('event', onEvent);
      current.stopping = (async () => {
        // End may arrive while authentication or native startup is still pending.
        try { await current.started; if (current.started) await client.stopVoice(input.threadId); } catch {}
        finally { if (owner === current) owner = undefined; if (call === current) call = undefined; response.end(); }
      })();
      return current.stopping;
    };
    current.stop = stop;
    const fail = message => { send({ type: 'error', message }); void stop(); };
    const onEvent = event => {
      if (event.type === 'connection' && !event.data?.connected) return fail('Elpis disconnected. Reconnect before starting voice again.');
      const { method, params } = event.data ?? {};
      if (event.type !== 'message' || params?.threadId !== input.threadId) return;
      if (method === 'thread/realtime/sdp') { clearTimeout(timeout); send({ type: 'sdp', sdp: params.sdp }); }
      if (method === 'thread/realtime/error') fail('Voice could not connect. Check your ChatGPT connection and try again.');
      if (method === 'thread/realtime/closed' || method === 'thread/deleted' || method === 'thread/archived') { send({ type: 'ended' }); void stop(); }
    };
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    response.once('close', stop); client.on('event', onEvent);
    timeout = setTimeout(() => fail('Voice connection timed out. Try again.'), 30000).unref();
    heartbeat = setInterval(() => send({ type: 'ping' }), 15000).unref();
    current.started = client.startVoice(input.threadId, input.sdp);
    current.started.catch(error => fail(error instanceof BridgeError && error.status < 500 ? error.message : 'Voice could not start. Check your ChatGPT connection and try again.'));
  }
  return { start, close, busy: () => !!call };
}

// Scripted model behind the real shared provider bridge; no credentials or model calls.
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';

type Socket = { send(data: string): void; on(event: 'message', callback: (data: Buffer) => void): void };
type Server = { clients: Set<Socket>; on(event: 'connection', callback: (socket: Socket) => void): void };
type Message = { text?: string };
type Params = { cwd?: string; model?: string; ephemeral?: boolean; threadId?: string; name?: string; input?: Message[]; sortDirection?: string };
type Item = { id: string; type: string; content?: Message[]; phase?: string; text?: string };
type Turn = { id: string; status: string; items: Item[] };
type Thread = { id: string; cwd: string | undefined; model: string | undefined; name?: string | undefined; modelProvider: string; source: string; createdAt: number; updatedAt: number; preview: string; ephemeral: boolean; status: { type: string }; turns: Turn[] };
const { WebSocketServer }: { WebSocketServer: new (options: { server: http.Server }) => Server } = createRequire(import.meta.url)('ws');
const threads = new Map<string, Thread>();
let wss: Server | undefined;
const send = (value: object, socket?: Socket) => socket ? socket.send(JSON.stringify(value)) : process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: object) => wss ? [...wss.clients].forEach(socket => send({ method, params }, socket)) : send({ method, params });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const threadOf = (id: string | undefined) => { const thread = id === undefined ? undefined : threads.get(id); if (!thread) throw Error('Thread missing'); return thread; };
async function handle({ id, method, params: p = {} }: { id?: string | number; method?: string; params?: Params }, socket?: Socket) {
  if (id === undefined || !method) return;
  const requests = process.env.INTERVIEW_REQUESTS; if (!requests) throw Error('Interview request log missing');
  fs.appendFileSync(requests, JSON.stringify({ method, params: p }) + '\n');
  const reply = (result: object) => send({ id, result }, socket);
  if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: p.cwd, model: p.model, modelProvider: 'openai', source: 'appServer', createdAt: 1, updatedAt: 1, preview: '', ephemeral: p.ephemeral === true, status: { type: 'idle' }, turns: [] };
    threads.set(thread.id, thread); reply({ thread, model: thread.model, modelProvider: 'openai' });
    notify('thread/started', { thread }); return;
  }
  if (method === 'thread/name/set') { threadOf(p.threadId).name = p.name; reply({}); return; }
  if (method === 'thread/list') { reply({ data: [...threads.values()].filter(t => !t.ephemeral), nextCursor: null }); return; }
  if (method === 'turn/start') {
    const thread = threadOf(p.threadId), turn: Turn = { id: randomUUID(), status: 'inProgress', items: [] };
    if (!p.input) throw Error('Turn input missing');
    if (!thread.preview) thread.preview = p.input[0]?.text ?? '';
    thread.turns.push(turn); reply({ turn }); notify('turn/started', { threadId: thread.id, turn });
    const user = { id: randomUUID(), type: 'userMessage', content: p.input };
    turn.items.push(user); notify('item/completed', { threadId: thread.id, turnId: turn.id, item: user });
    const control = process.env.INTERVIEW_CONTROL; if (!control) throw Error('Interview control missing');
    while (JSON.parse(fs.readFileSync(control, 'utf8')).hold) await pause();
    const { answer, failure }: { answer: string; failure?: string } = JSON.parse(fs.readFileSync(control, 'utf8'));
    if (failure) { notify('turn/completed', { threadId: thread.id, turn: { ...turn, status: 'failed', error: { message: failure } } }); return; }
    const item = { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: answer };
    turn.items.push(item); turn.status = 'completed';
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
    notify('turn/completed', { threadId: thread.id, turn }); return;
  }
  if (method === 'thread/read' || method === 'thread/resume') { reply({ thread: p.threadId === undefined ? undefined : threads.get(p.threadId) }); return; }
  if (method === 'thread/turns/list') { reply({ data: threadOf(p.threadId).turns, nextCursor: null }); return; }
  if (method === 'thread/items/list') {
    const data = threadOf(p.threadId).turns.flatMap(turn => turn.items.map(item => ({ threadId: p.threadId, turnId: turn.id, item })));
    reply({ data: p.sortDirection === 'asc' ? data : data.reverse(), nextCursor: null }); return;
  }
  if (method === 'model/list') { reply({ data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: true, supportedReasoningEfforts: [], inputModalities: ['text'] }], nextCursor: null }); return; }
  if (method === 'config/read') { reply({ config: { model: 'gpt-6-luna', model_provider: 'openai' }, origins: {}, layers: [] }); return; }
  reply({});
}
const socketPath = process.argv.find(arg => arg.startsWith('unix://'))?.slice(7);
if (socketPath) {
  const server = http.createServer(); wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', raw => { void handle(JSON.parse(raw.toString()), socket); }));
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => { void handle(JSON.parse(line)); });
  process.stdin.on('end', () => process.exit(0));
}

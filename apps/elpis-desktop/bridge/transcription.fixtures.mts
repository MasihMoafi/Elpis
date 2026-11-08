import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createTranscription } from "./transcription.mts";

export type Handler = ReturnType<typeof createTranscription>;

export type MockRequest = Readable & Pick<IncomingMessage, "method" | "url" | "headers">;

export type Result = {
  status: number;
  value: { text?: string; available?: boolean; backend?: string; label?: string; source?: string; reason?: string };
};

export type MockReply = { status?: number; headers?: Record<string, string>; body: unknown };

export type RecordedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: {
    contents: { role: string; parts: { text: string; inline_data: { mime_type: string; data: string } }[] }[];
    generationConfig: object;
  };
};

export const server = (env: Record<string, string>) => ({
  command: "private-command",
  env: { SECRET_KEY: "private-key", ...env },
});

export const MODEL = "openai/gpt-4o-mini-transcribe";

export async function call(
  handle: Handler,
  mime: string,
  audio = Buffer.from("clip"),
  { provider, backend = "local" }: { provider?: string; backend?: string } = {},
) {
  const request = Readable.from([audio]) as MockRequest;
  request.method = "POST";
  request.url = `/api/tools/transcription${provider === undefined ? "" : `?provider=${encodeURIComponent(provider)}`}`;
  request.headers = { "content-type": mime, "x-elpis-transcription-backend": backend };
  const response = new PassThrough();
  let result: Result | undefined;
  await handle(request as IncomingMessage, response as unknown as ServerResponse, (_res, status, value) => {
    result = { status, value };
  });
  assert.ok(result);
  return result;
}

export async function status(handle: Handler, provider?: string) {
  const request = new Readable({
    read() {
      this.push(null);
    },
  }) as MockRequest;
  request.method = "GET";
  request.headers = {};
  request.url = `/api/tools/transcription${provider === undefined ? "" : `?provider=${encodeURIComponent(provider)}`}`;
  let result: { code: number; value: Result["value"] } | undefined;
  await handle(request as IncomingMessage, new PassThrough() as unknown as ServerResponse, (_res, code, value) => {
    result = { code, value };
  });
  assert.ok(result);
  return result;
}

// A real child process checks the MCP handshake and fixed tool arguments without a network call.
export const fakeMcp = `let text=''; process.stdin.on('data',chunk=>{text+=chunk;let n;while((n=text.indexOf('\\n'))>=0){const m=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'sample',version:'1'}}}));if(m.id===2){const a=m.params.arguments;const ok=m.params.name==='transcribe_audio'&&a.refine_prompt===false&&a.backend==='local'&&a.audio_base64==='Y2xpcA==';console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({success:ok,text:'Speech inserted into draft'})}]}}));}}});`;

// The fake WhisperType returns the CODEX_HOME it was started with, so the test sees which ChatGPT sign-in it would read.
export const fakeHome = `let t='';process.stdin.on('data',c=>{t+=c;let n;while((n=t.indexOf('\\n'))>=0){const m=JSON.parse(t.slice(0,n));t=t.slice(n+1);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'s',version:'1'}}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({success:true,text:String(process.env.CODEX_HOME)})}]}}));}});`;

// A local HTTP server stands in for Google: no call ever leaves this machine.
export async function googleMock(reply: (count: number) => MockReply) {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const out = reply(requests.length);
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    })();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export const spoken = (text: string) => ({
  body: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] },
});

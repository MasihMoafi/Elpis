import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { FunctionTool } from "openai/resources/responses/responses";

export class CreditTools {
  readonly definitions: FunctionTool[] = [];
  private readonly calls = new Map<string, { client: Client; name: string; title: string }>();
  private readonly clients: Client[] = [];

  async connect(servers: McpServer[], cwd: string, signal: AbortSignal) {
    for (const server of servers) {
      signal.throwIfAborted();
      const client = new Client({ name: "elpis-openai-credits", version: "1" });
      this.clients.push(client);
      let transport;
      if ("command" in server) {
        transport = new StdioClientTransport({ command: server.command, args: server.args, cwd,
          env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])), stderr: "ignore" });
      } else {
        const options = { requestInit: { headers: Object.fromEntries(server.headers.map(entry => [entry.name, entry.value])) } };
        transport = server.type === "sse" ? new SSEClientTransport(new URL(server.url), options) : new StreamableHTTPClientTransport(new URL(server.url), options);
      }
      await client.connect(transport, { timeout: 10000, signal });
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor }, { timeout: 10000, signal });
        for (const tool of page.tools) {
          const title = `${server.name} / ${tool.name}`;
          const name = `mcp_${this.calls.size}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
          this.calls.set(name, { client, name: tool.name, title });
          this.definitions.push({ type: "function", name, description: [title, tool.description].filter(Boolean).join("\n"), parameters: tool.inputSchema, strict: false });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }

  async run(name: string, raw: string, approve: (title: string, args: Record<string, unknown>) => Promise<boolean>, signal: AbortSignal) {
    const tool = this.calls.get(name);
    if (!tool) throw new Error("The requested tool is unavailable.");
    const args: unknown = JSON.parse(raw);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments.");
    const input = args as Record<string, unknown>;
    if (!await approve(tool.title, input)) return "Permission denied.";
    signal.throwIfAborted();
    const result = await tool.client.callTool({ name: tool.name, arguments: input }, undefined, { signal, timeout: 60_000 });
    return JSON.stringify(result);
  }

  async close() {
    await Promise.allSettled(this.clients.map(client => client.close()));
  }
}

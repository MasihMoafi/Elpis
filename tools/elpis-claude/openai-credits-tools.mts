import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ToolState } from "./bridge-types.mts";
import { workspaceTools, type CreditToolExecution, type CreditToolPrepared, type WorkspaceToolConfig } from "./openai-credits-workspace.mts";

export type CreditToolDecision = (info: {
  title: string;
  kind: "read" | "edit" | "execute" | "other";
  toolName: string;
  rawInput: ToolState["raw"];
  requiresApproval: boolean;
}) => Promise<boolean>;

export class CreditTools {
  readonly definitions: FunctionTool[] = [];
  private readonly handlers = new Map<string, (args: Record<string, unknown>) => CreditToolPrepared>();
  private readonly clients: Client[] = [];

  registerWorkspace(config: WorkspaceToolConfig) {
    for (const tool of workspaceTools(config)) {
      if (this.handlers.has(tool.definition.name)) continue;
      this.definitions.push(tool.definition);
      this.handlers.set(tool.definition.name, tool.prepare);
    }
  }

  async connect(servers: McpServer[], cwd: string, signal: AbortSignal) {
    for (const server of servers) {
      signal.throwIfAborted();
      const client = new Client({ name: "elpis-openai-credits", version: "1" });
      this.clients.push(client);
      let transport;
      if ("command" in server) {
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd,
          env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
          stderr: "ignore",
        });
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
          const name = `mcp_${this.handlers.size}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
          this.definitions.push({ type: "function", name, description: [title, tool.description].filter(Boolean).join("\n"), parameters: tool.inputSchema, strict: false });
          this.handlers.set(name, args => ({
            title,
            kind: "other",
            toolName: title,
            rawInput: args as ToolState["raw"],
            requiresApproval: true,
            async run(runSignal) {
              const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal: runSignal, timeout: 60_000 });
              const output = JSON.stringify(result);
              return { output, failed: Boolean((result as { isError?: boolean }).isError), text: output };
            },
          }));
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }

  async run(name: string, raw: string, authorize: CreditToolDecision, signal: AbortSignal): Promise<CreditToolExecution> {
    const prepare = this.handlers.get(name);
    if (!prepare) return { output: JSON.stringify({ error: `Tool "${name}" is not available in this session.` }), failed: true, text: `Tool "${name}" is not available in this session.` };
    let args: unknown;
    try {
      args = JSON.parse(raw);
    } catch {
      return { output: JSON.stringify({ error: "Invalid tool arguments JSON." }), failed: true, text: "Invalid tool arguments JSON." };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { output: JSON.stringify({ error: "Invalid tool arguments: expected JSON object." }), failed: true, text: "Invalid tool arguments: expected JSON object." };
    }
    let prepared: CreditToolPrepared;
    try {
      prepared = prepare(args as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: JSON.stringify({ error: message }), failed: true, text: message };
    }
    if (!await authorize({ title: prepared.title, kind: prepared.kind, toolName: prepared.toolName, rawInput: prepared.rawInput, requiresApproval: prepared.requiresApproval })) {
      return { output: "Permission denied.", failed: true, text: "Permission denied." };
    }
    signal.throwIfAborted();
    try {
      return await prepared.run(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { output: JSON.stringify({ error: message }), failed: true, text: message };
    }
  }

  async close() {
    await Promise.allSettled(this.clients.map(client => client.close()));
  }
}

/** Role tools over private local IPC for ACP runtimes; native runtimes use app-server dynamic tools. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, lstat, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { key } from "../core/index.mts";
import { KV } from "../sources/kv.mts";
import type { ExecutorStore } from "./store.mts";
import type { ToolBinding } from "./adapters.mts";
import type { Tool } from "../app/tools/tool.mts";

export interface McpRuntime {
  command: string;
  args: string[];
  env: Record<string, string>;
}
interface Entry {
  token: string;
  initial: Tool[];
  binding?: ToolBinding;
}
export class ToolRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly directory: string;
  private readonly socket: string;
  private readonly server = createServer((req, res) => {
    const task = this.respond(req, res).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  });
  private starting: Promise<void> | undefined;
  private ownsSocket = false;
  private stopping = false;
  private readonly store: ExecutorStore;
  constructor(store: ExecutorStore, stateDir: string) {
    this.store = store;
    this.directory = join(tmpdir(), `elpis-mother-${key(stateDir)}`);
    this.socket = join(this.directory, "tools.sock");
  }
  private start(): Promise<void> {
    return (this.starting ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o077
      )
        throw new Error("Elpis tool IPC directory is not private");
      const old = await lstat(this.socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (old) {
        if (!old.isSocket()) throw new Error("Elpis tool IPC path contains another file");
        await unlink(this.socket);
      }
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.socket, () => {
          this.server.off("error", reject);
          this.ownsSocket = true;
          resolve();
        });
      });
    })());
  }
  async transport(id: string, tools: Tool[], role: "orchestrator" | "worker" = "worker"): Promise<McpRuntime> {
    if (this.stopping) throw new Error("Elpis tools are stopping");
    const token = this.store.get(KV.sessions.tools(id)) ?? randomUUID();
    this.store.set(KV.sessions.tools(id), token);
    this.entries.set(id, { token, initial: tools });
    await this.start();
    return {
      command: process.env.ELPIS_NODE_BIN ?? process.execPath,
      args: [fileURLToPath(new URL("./tool-stdio.mts", import.meta.url)), this.socket, id],
      env: { ELPIS_MOTHER_CAPABILITY: token, ELPIS_MOTHER_ROLE: role },
    };
  }
  bind(id: string, binding: ToolBinding): void {
    const entry = this.entries.get(id);
    if (entry) entry.binding = binding;
  }
  private async respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const id = req.headers["x-mother-session"],
        token = req.headers["x-mother-capability"];
      const entry = typeof id === "string" ? this.entries.get(id) : undefined;
      if (this.stopping || !entry || token !== entry.token) {
        json(403, { error: "Elpis tool session is unavailable" });
        return;
      }
      if (req.method === "GET" && req.url === "/tools") {
        json(200, {
          tools: (entry.binding?.tools() ?? entry.initial).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
          })),
        });
        return;
      }
      if (req.method !== "POST" || req.url !== "/call") {
        json(404, { error: "Unknown Elpis tool operation" });
        return;
      }
      const binding = entry.binding;
      if (!binding) throw new Error("The Elpis session is still attaching");
      binding.signal.throwIfAborted();
      binding.authorize();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 128 * 1024) throw new Error("Elpis tool arguments are too large");
        chunks.push(bytes);
      }
      const args = z
        .object({ name: z.string(), arguments: z.unknown() })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      binding.signal.throwIfAborted();
      binding.authorize();
      const tool = binding.tools().find(tool => tool.name === args.name);
      if (!tool) throw new Error("This tool is unavailable to this session");
      json(200, { value: await tool.execute(tool.schema.parse(args.arguments), binding.signal) });
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (!this.starting) return;
    await this.starting.catch(() => {});
    await Promise.allSettled([...this.tasks]);
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (this.ownsSocket) await unlink(this.socket).catch(() => {});
    await rmdir(this.directory).catch(() => {});
    this.entries.clear();
  }
}

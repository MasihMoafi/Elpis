/** MCP stdio adapter for a single managed Elpis session. No credentials or model calls live here. */
import { request } from "node:http";
import { createInterface } from "node:readline";
import { z } from "zod";
const [socketPath, session] = process.argv.slice(2),
  capability = process.env.ELPIS_MOTHER_CAPABILITY;
if (!socketPath || !session || !capability) throw new Error("Elpis tool IPC requires a session capability");
const call = (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: { "x-mother-session": session, "x-mother-capability": capability },
        timeout: 60_000,
      },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          text += String(chunk);
        });
        res.on("end", () => {
          try {
            const value = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
            if ((res.statusCode ?? 500) >= 400) reject(new Error(String(value.error)));
            else resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Elpis tool request timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
const Input = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const send = (id: string | number, result: unknown) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    continue;
  }
  const parsed = Input.safeParse(raw);
  if (!parsed.success || parsed.data.id === undefined) continue;
  const { id, method, params = {} } = parsed.data;
  try {
    if (method === "initialize")
      send(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "elpis-mother", version: "1" },
      });
    else if (method === "ping") send(id, {});
    else if (method === "tools/list") send(id, await call("GET", "/tools"));
    else if (method === "tools/call") {
      const value = (await call("POST", "/call", { name: params.name, arguments: params.arguments ?? {} })).value;
      const image = z.object({ image_url: z.string() }).safeParse(value);
      const match = image.success ? /^data:([^;]+);base64,(.+)$/.exec(image.data.image_url) : undefined;
      send(id, {
        content: match
          ? [{ type: "image", mimeType: match[1], data: match[2] }]
          : [{ type: "text", text: JSON.stringify(value) ?? "null" }],
      });
    } else
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown MCP operation" } })}\n`,
      );
  } catch (error) {
    send(id, {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    });
  }
}

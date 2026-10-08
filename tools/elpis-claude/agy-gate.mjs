// Antigravity's PreToolUse hook in the agy runs Elpis starts while Elpis asks before acting
// (agy-acp.mjs writes it into <Elpis home>/elpis-claude/agy-approvals/.agents/hooks.json and adds
// that folder as a workspace). It asks the Elpis user through the wrapper over a local socket,
// and keeps the tool in the chat's folder: agy may pick the hooks folder as the place to work.
import { connect } from "node:net";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const call = JSON.parse(input || "{}").toolCall ?? {};
const args = call.args ?? {};
const { ELPIS_AGY_GATE: gate, ELPIS_AGY_CWD: cwd, ELPIS_AGY_HOOKS: hooks } = process.env;
const answer = (decision) => process.stdout.write(JSON.stringify(decision));
const inHooks = (path) => typeof path === "string" && !!hooks && path.startsWith(hooks);

const target = args.TargetFile ?? args.AbsolutePath ?? args.FilePath;
if (inHooks(target)) {
  answer({ decision: "deny", reason: `Work in ${cwd}: ${hooks} is Elpis's approval folder, not part of the task.` });
} else {
  const overwrite = inHooks(args.Cwd) && cwd ? { Cwd: cwd } : null;
  const reply = !gate ? { allowed: true } : await new Promise((resolve) => {
    const sock = connect(gate);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify({ toolCall: { name: call.name, args: { ...args, ...overwrite } } }) + "\n"));
    sock.on("data", (d) => { buf += d; });
    sock.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    sock.on("error", () => resolve(null));
  });
  answer(reply?.allowed
    ? { decision: "allow", ...(overwrite && { overwrite }) }
    : { decision: "deny", reason: reply ? "The user declined this in Elpis." : "Elpis could not ask the user, so this was not run." });
}

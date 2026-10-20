import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// Credentials stay in Claude Code's own private configuration directories. The index contains IDs only.
export class ClaudeAccounts {
  constructor({ home, dir, defaultConfigDir = join(home, ".claude"), claudeBin = join(home, ".local/bin/claude") }) {
    this.home = home; this.dir = dir; this.defaultConfigDir = defaultConfigDir; this.claudeBin = claudeBin;
    this.file = join(dir, "claude-accounts.json"); this.logins = new Map();
  }
  state() {
    let value;
    try { value = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { activeId: "default", ids: [] }; throw invalid("Claude account settings could not be read."); }
    if (!value || !Array.isArray(value.ids) || value.ids.length > 1 || value.ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) || !["default", ...value.ids].includes(value.activeId)) throw invalid("Claude account settings could not be read.");
    return value;
  }
  write(state) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
  }
  activeId() { return this.state().activeId; }
  configDir(id = this.activeId()) {
    if (!["default", ...this.state().ids].includes(id)) throw invalid("Unknown Claude account.");
    return id === "default" ? this.defaultConfigDir : join(this.dir, "claude-accounts", id);
  }
  credentials(id = this.activeId()) { return readJson(join(this.configDir(id), ".credentials.json"))?.claudeAiOauth ?? null; }
  account(id = this.activeId()) {
    const config = readJson(join(this.configDir(id), ".claude.json")) ?? (id === "default" ? readJson(join(this.home, ".claude.json")) : null);
    return { email: config?.oauthAccount?.emailAddress ?? null, plan: this.credentials(id)?.subscriptionType ?? null };
  }
  snapshot() {
    const state = this.state();
    return { activeId: state.activeId, accounts: ["default", ...state.ids].map((id, index) => {
      const login = this.logins.get(id);
      return { id, label: index ? "Claude 2" : "Claude 1", ...this.account(id), authenticated: !!this.credentials(id)?.accessToken, signingIn: !!login?.running, error: login?.error ?? null };
    }) };
  }
  add() {
    const state = this.state();
    if (state.ids.length) throw invalid("Elpis already has two Claude accounts.");
    const id = randomUUID();
    const directory = join(this.dir, "claude-accounts", id);
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.write({ ...state, ids: [id] });
    return { id };
  }
  select(id) {
    const state = this.state();
    if (!this.credentials(id)?.accessToken) throw invalid("Sign in to this Claude account before switching.");
    this.write({ ...state, activeId: id });
    return this.snapshot();
  }
  environment(id = this.activeId()) {
    if (id === "default") return process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: this.configDir(id) } : {};
    return { CLAUDE_CONFIG_DIR: this.configDir(id), ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined };
  }
  async login(id) {
    const environment = this.environment(id);
    if (this.logins.get(id)?.running) throw invalid("Claude sign-in is already open. Complete it in your browser.");
    const child = spawn(this.claudeBin, ["auth", "login", "--claudeai"], { env: { ...process.env, ...environment, BROWSER: "true" }, stdio: ["pipe", "pipe", "pipe"] });
    const login = { child, running: true, error: null }; this.logins.set(id, login);
    return new Promise((resolve, reject) => {
      let output = "", answered = false;
      const timer = setTimeout(() => { child.kill(); finish(new Error("Claude sign-in timed out. Try signing in again.")); }, 15 * 60_000);
      timer.unref();
      const finish = error => {
        clearTimeout(timer); login.running = false; login.error = error?.message ?? null;
        if (!answered) { answered = true; if (error) reject(error); else resolve({ accounts: this.snapshot() }); }
      };
      const read = chunk => {
        output = (output + chunk.toString()).slice(-32_000);
        for (const match of output.matchAll(/https:\/\/[^\s\u001b<>"']+/g)) {
          let url; try { url = new URL(match[0]); } catch { continue; }
          if (!["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname) || !url.pathname.includes("oauth/authorize")) continue;
          if (!answered) { answered = true; resolve({ authUrl: url.href, accounts: this.snapshot() }); }
        }
      };
      child.stdout.on("data", read); child.stderr.on("data", read);
      child.on("error", () => finish(new Error("Claude Code could not start. Check that it is installed, then try signing in again.")));
      child.on("exit", code => finish(code === 0 && this.credentials(id)?.accessToken ? null : new Error("Claude sign-in did not complete. Try signing in again.")));
    });
  }
  close() { for (const login of this.logins.values()) if (login.running) login.child.kill(); }
}

import { BridgeError, object, text } from './validate.mts';
import { privateConfigFile } from './provider-settings.mjs';
import { readClaudeMcp } from './claude-mcp-import.mts';

import { internal_rpc } from './client-connection.mts';
import type { DesktopClient } from './client.mts';
import type { ClientState } from './client-state.mts';

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Preview exposes no commands, URLs, environment or header values. */
export async function impl_previewClaudeMcp(this: DesktopClient, clientState: ClientState) {
    const current = await this.mcp();
    const source = await readClaudeMcp(clientState.appHome, current.servers.map(server => server.name));
    return { servers: source.preview, revision: source.revision, version: current.version };
  }

export async function impl_importClaudeMcp(this: DesktopClient, clientState: ClientState, raw: unknown) {
    const input = object(raw, ['version', 'revision', 'names']) as Record<string, unknown>;
    text(input.version, 'MCP settings version', 200);
    text(input.revision, 'Claude settings revision', 200);
    if (!Array.isArray(input.names) || !input.names.length || input.names.length > 100 || new Set(input.names).size !== input.names.length || input.names.some(name => typeof name !== 'string' || !MCP_NAME.test(name))) throw new BridgeError('Choose one or more available servers.');
    const current = await this.mcp();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed. Preview the import again.', 409);
    const source = await readClaudeMcp(clientState.appHome, current.servers.map(server => server.name));
    if (source.revision !== input.revision || input.names.some(name => !Object.hasOwn(source.definitions, name))) throw new BridgeError('Claude Code or Elpis settings changed. Preview the import again.', 409);
    privateConfigFile(current.configPath);
    const edits = input.names.map(name => ({ keyPath: `mcp_servers.${name}`, value: source.definitions[name], mergeStrategy: 'replace' }));
    try { await internal_rpc(this, clientState, 'config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: false }); }
    catch (error) { const failure = error as { status?: number }; if (failure.status === 409) throw new BridgeError('Settings changed. Preview the import again.', 409); throw new BridgeError('MCP servers could not be imported.', failure.status ?? 502); }
    return { imported: input.names.length };
  }

/** Adds, removes, enables or configures one MCP server through the native versioned config writer. */
export async function impl_saveMcp(this: DesktopClient, clientState: ClientState, raw: unknown) {
    const input = object(raw, ['version', 'action', 'name', 'command', 'args', 'enabled', 'backend', 'model', 'env', 'everyChat']) as Record<string, unknown>;
    text(input.version, 'MCP settings version', 200);
    if (typeof input.name !== 'string' || !MCP_NAME.test(input.name)) throw new BridgeError('Use letters, numbers, - or _ for the server name');
    const current = await this.mcp();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const exists = current.servers.some(server => server.name === input.name);
    const key = `mcp_servers.${input.name}`;
    let edits;
    if (input.action === 'add') {
      if (exists) throw new BridgeError('A server with this name already exists', 409);
      const command = text(input.command, 'command', 4096).trim();
      const args = input.args === undefined ? [] : input.args;
      if (!Array.isArray(args) || args.length > 64) throw new BridgeError('Give at most 64 arguments');
      edits = [{ keyPath: key, value: { command, args: args.map(arg => text(arg, 'argument', 4096)) }, mergeStrategy: 'replace' }];
    } else if (!exists) throw new BridgeError('Unknown MCP server', 409);
    else if (input.action === 'remove') edits = [{ keyPath: key, value: null, mergeStrategy: 'replace' }];
    else if (input.action === 'enable') {
      if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose enabled or disabled');
      edits = [{ keyPath: `${key}.enabled`, value: input.enabled, mergeStrategy: 'replace' }];
    } else if (input.action === 'credentials') {
      if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || !Object.keys(input.env).length || Object.keys(input.env).length > 16) throw new BridgeError('Invalid credential fields');
      edits = [];
      for (const [name, value] of Object.entries(input.env)) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) || (value !== null && (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)))) throw new BridgeError('Invalid credential');
        if (typeof value === 'string' && (!value.trim() || /^[*•●]+$/.test(value.trim()))) continue;
        edits.push({ keyPath: `${key}.env.${name}`, value, mergeStrategy: 'replace' });
      }
    } else if (input.action === 'whispertype' && input.name === 'whispertype') {
      // null is Automatic: no explicit backend, so the bridge picks the ChatGPT sign-in or Local (see bridge/transcription.mjs).
      if (input.backend !== null && !['openrouter', 'codex', 'local'].includes(input.backend as string)) throw new BridgeError('Choose OpenRouter, Codex sign-in or local transcription');
      edits = [{ keyPath: `${key}.env.WHISPERTYPE_BACKEND`, value: input.backend, mergeStrategy: 'replace' }];
      if (input.model !== undefined) {
        if (input.model !== null && !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(input.model as string)) throw new BridgeError('Choose an OpenRouter model.');
        edits.push({ keyPath: `${key}.env.WHISPERTYPE_CLOUD_MODEL`, value: input.model, mergeStrategy: 'replace' });
      }
      if (input.everyChat !== undefined) {
        if (typeof input.everyChat !== 'boolean') throw new BridgeError('Choose whether dictation applies to every chat.');
        edits.push({ keyPath: `${key}.env.WHISPERTYPE_EVERY_CHAT`, value: input.everyChat ? '1' : null, mergeStrategy: 'replace' });
        // Distinguish an explicit new choice from older WhisperType settings that use their own API key.
        edits.push({ keyPath: `${key}.env.ELPIS_DICTATION_EXPLICIT`, value: input.everyChat ? '1' : null, mergeStrategy: 'replace' });
      }
    } else throw new BridgeError('Unsupported MCP change');
    if (!edits.length) return current;
    if (input.action === 'credentials') {
      privateConfigFile(current.configPath);
    }
    try { await internal_rpc(this, clientState, 'config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); }
    catch (error) {
      // Native TOML errors can contain submitted values. Keep safe status semantics only.
      const failure = error as { status?: number };
      if (failure.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('MCP settings could not be saved. Refresh settings before retrying.', failure.status ?? 502);
    }
    let reloadRequested = true;
    await internal_rpc(this, clientState, 'config/mcpServer/reload', undefined).catch(() => { reloadRequested = false; });
    return { ...await this.mcp(), reloadRequested };
  }

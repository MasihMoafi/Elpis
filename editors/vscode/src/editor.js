'use strict';
const {approvalMode}=require('./approval-modes');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const plainRange = range => ({ start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } });
const location = { uri: string, line: integer, character: integer };
const tool = (name, description, inputSchema) => ({ type: 'function', name: `editor_${name}`, description, inputSchema });
const specs = [
  tool('documents', 'List open documents in this workspace, including unsaved versions. Only this bridge can see unsaved text.', schema({})),
  tool('read', 'Read current editor text, never a stale disk copy. Keep returned version for proposing edits.', schema({ uri: string }, ['uri'])),
  tool('diagnostics', 'Get actual current VS Code language diagnostics (zero-based positions). Empty diagnostics may also mean no provider; consult status.', schema({ uri: string }, ['uri'])),
  tool('definition', 'Ask the installed language provider for symbol definitions at zero-based line/character.', schema(location, ['uri', 'line', 'character'])),
  tool('references', 'Ask the installed language provider for references at zero-based line/character.', schema(location, ['uri', 'line', 'character'])),
  tool('propose_edit', 'Propose replacement of the whole document at the exact version previously read. Returns a proposal ID; this does not edit the document.', schema({ uri: string, version: integer, text: string, reason: string }, ['uri', 'version', 'text', 'reason'])),
  tool('apply_edit', 'Apply a proposal ID. Ask mode shows a diff and requires approval; Auto and Full allow workspace editor edits. Refusal, cancellation, or a changed document leaves text untouched. Does not save to disk. After success check diagnostics again.', schema({ proposalId: string }, ['proposalId'])),
];

class EditorBridge {
  constructor(vscode, root, options = {}) {
    this.approvalMode=options.approvalMode || (()=>'ask');
    this.vscode = vscode;
    this.root = root;
    this.enabled = options.enabled || (() => vscode.workspace.getConfiguration('elpis', root).get('editorAccess', true));
    this.approve = options.approve || (async proposal => {
      await this.showDiff(proposal);
      return (await vscode.window.showWarningMessage(`Apply Elpis edit to ${path.basename(proposal.document.uri.fsPath)}? ${proposal.reason}`, 'Apply', 'Reject')) === 'Apply';
    });
    this.proposals = new Map();
    this.epoch = 0;
  }
  check() {
    if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before using Elpis.');
    if (!this.enabled()) throw new Error('Editor access is disabled. Unsaved text and language intelligence are unavailable.');
  }
  async uri(value) {
    if (typeof value !== 'string') throw new Error('uri must be a file URI.');
    const uri = this.vscode.Uri.parse(value, true);
    if (uri.scheme !== 'file') throw new Error('Only local file documents inside the selected workspace are supported.');
    const root = await fs.realpath(this.root.fsPath);
    const target = await fs.realpath(uri.fsPath);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Document is outside this conversation workspace.');
    return uri;
  }
  async document(value) { return this.vscode.workspace.openTextDocument(await this.uri(value)); }
  async showDiff(proposal) {
    const scheme = `elpis-proposal-${proposal.id}`;
    const registration = this.vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: () => proposal.text });
    try {
      await this.vscode.commands.executeCommand('vscode.diff', proposal.document.uri, this.vscode.Uri.parse(`${scheme}:/proposed`), 'Elpis proposed edit', { preview: true });
    } finally { registration.dispose(); }
  }
  async execute(name, args = {}) {
    this.check();
    const epoch = this.epoch;
    const v = this.vscode;
    if (name === 'editor_documents') {
      const documents = [];
      for (const d of v.workspace.textDocuments) {
        try { await this.uri(d.uri.toString()); } catch { continue; }
        documents.push({ uri: d.uri.toString(), version: d.version, dirty: d.isDirty, language: d.languageId });
      }
      this.check();
      return { documents };
    }
    if (name === 'editor_apply_edit') {
      const p = this.proposals.get(args.proposalId);
      if (!p) throw new Error('Unknown or expired proposal; read the document and propose again.');
      this.proposals.delete(args.proposalId);
      if (approvalMode(this.approvalMode()).reviewEdits && !await this.approve(p)) return { applied: false, reason: 'User rejected edit; nothing changed.' };
      this.check();
      await this.uri(p.document.uri.toString());
      const editor = await v.window.showTextDocument(p.document, { preview: false });
      this.check();
      if (epoch !== this.epoch) throw new Error('Edit cancelled; nothing changed.');
      if (p.document.isClosed || p.document.version !== p.version || p.document.getText() !== p.original) throw new Error('Document changed since proposal; refusing to overwrite newer user edits. Read and propose again.');
      // TextEditor.edit carries the document version into VS Code's atomic edit operation.
      const applied = await editor.edit(builder => builder.replace(new v.Range(p.document.positionAt(0), p.document.positionAt(p.original.length)), p.text), { undoStopBefore: true, undoStopAfter: true });
      return { applied, version: p.document.version, saved: false, reason: applied ? 'Approved edit applied to editor buffer. Query diagnostics again after language service updates.' : 'Editor rejected the edit; read the current version and propose again.' };
    }
    const document = await this.document(args.uri);
    this.check();
    if (name === 'editor_read') return { uri: document.uri.toString(), version: document.version, dirty: document.isDirty, language: document.languageId, text: document.getText() };
    if (name === 'editor_diagnostics') {
      const diagnostics = v.languages.getDiagnostics(document.uri).map(d => ({ message: d.message, severity: d.severity, code: typeof d.code === 'object' ? d.code.value : d.code, source: d.source, range: plainRange(d.range) }));
      return { uri: document.uri.toString(), version: document.version, diagnostics, status: diagnostics.length ? 'Diagnostics from installed providers.' : 'No diagnostics currently published. This does not prove a language provider is installed or finished; check the language status and retry after updates.' };
    }
    if (name === 'editor_definition' || name === 'editor_references') {
      if (!Number.isInteger(args.line) || !Number.isInteger(args.character) || args.line < 0 || args.line >= document.lineCount || args.character < 0 || args.character > document.lineAt(args.line).text.length) throw new Error('Position is outside the document (use zero-based line and character).');
      const command = name === 'editor_definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';
      const locations = await v.commands.executeCommand(command, document.uri, new v.Position(args.line, args.character)) || [];
      const results = [];
      for (const l of locations) {
        const uri = l.uri || l.targetUri;
        try { await this.uri(uri.toString()); } catch { continue; }
        results.push({ uri: uri.toString(), range: plainRange(l.range || l.targetSelectionRange || l.targetRange) });
      }
      this.check();
      return { results, status: results.length ? 'Language provider returned workspace locations.' : 'No workspace locations returned. A provider may be missing, still starting, or have no result for this symbol; install/enable the language extension and retry.' };
    }
    if (name === 'editor_propose_edit') {
      if (!Number.isInteger(args.version) || args.version !== document.version) throw new Error('Stale document version; read current editor text before proposing.');
      if (typeof args.text !== 'string' || typeof args.reason !== 'string') throw new Error('Replacement text and reason must be strings.');
      if (args.text.length > 2_000_000) throw new Error('Proposed replacement exceeds 2 MB. Split the task.');
      const id = crypto.randomUUID();
      if (this.proposals.size >= 20) this.proposals.delete(this.proposals.keys().next().value);
      this.proposals.set(id, { id, document, version: args.version, original: document.getText(), text: args.text, reason: args.reason });
      return { proposalId: id, applied: false, requiresApproval: true };
    }
    throw new Error(`Unknown editor tool: ${name}`);
  }
  cancel() { this.epoch++; this.proposals.clear(); }
  dispose() { this.cancel(); }
}
module.exports = { EditorBridge, specs };

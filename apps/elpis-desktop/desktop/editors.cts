'use strict';

type Environment = { PATH?: string; home?: string };
type Editor = { id: string; name: string; commands: string[]; args: (file: string, line: number) => string[] };
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The editors "Open in" offers, as Claude's desktop app offers VS Code, Cursor, Windsurf and Zed. VS Code is prohibited on
// this machine, so neither it nor a build or fork of it is listed, and a command that turns out to be one is dropped
// (installedEditors). `args` puts a line on the command line the way each editor documents; Text Editor takes the file only.
const at = (file: string, line: number) => [line ? `${file}:${line}` : file];
const editorList: Editor[] = [
  { id: 'zed', name: 'Zed', commands: ['zed', 'zeditor'], args: at },
  { id: 'sublime', name: 'Sublime Text', commands: ['subl', 'sublime_text'], args: at },
  { id: 'gnome-text-editor', name: 'Text Editor', commands: ['gnome-text-editor'], args: file => [file] },
  { id: 'gedit', name: 'gedit', commands: ['gedit'], args: (file, line) => line ? [`+${line}`, file] : [file] },
  { id: 'kate', name: 'Kate', commands: ['kate'], args: (file, line) => line ? ['-l', String(line), file] : [file] },
];

const isVsCode = (file: string) => { try { return /(^|\/)(code|codium|code-insiders|code-oss|vscodium)$|vscode|visual-studio-code/i.test(fs.realpathSync(file)); } catch { return true; } };
const isExecutable = (file: string) => { try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; } };

/** The file that runs an editor: its first command found in the PATH folders, then in ~/.local/bin. Null when it is not installed or is VS Code. */
function find(editor: Editor, { PATH = process.env.PATH ?? '', home = os.homedir() }: Environment = {}) {
  const folders = [...PATH.split(path.delimiter).filter(Boolean), path.join(home, '.local/bin')];
  for (const command of editor.commands) for (const folder of folders) {
    const file = path.join(folder, command);
    if (isExecutable(file)) return isVsCode(file) ? null : file;
  }
  return null;
}

/** The editors installed, `{ id, name }` in name order. */
function installedEditorsImpl(env?: Environment) {
  return editorList.filter(editor => find(editor, env)).map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** What to run to open `file` (at `line`) in the editor `id`. Only an installed editor from the list; anything else throws. */
function editorCommandImpl(id: unknown, file: string, line?: unknown, env?: Environment) {
  const editor = typeof id === 'string' ? editorList.find(item => item.id === id) : undefined, command = editor && find(editor, env);
  if (!editor || !command) throw Error('This editor is not available.');
  return { name: editor.name, command, args: editor.args(file, typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : 0) };
}

export declare const EDITORS: typeof editorList;
export declare const installedEditors: typeof installedEditorsImpl;
export declare const editorCommand: typeof editorCommandImpl;
module.exports = { EDITORS: editorList, installedEditors: installedEditorsImpl, editorCommand: editorCommandImpl };
